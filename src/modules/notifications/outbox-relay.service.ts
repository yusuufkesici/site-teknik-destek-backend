import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DOMAIN_AUDIT_ACTIONS } from '../../common/constants/domain-audit-actions.constant';
import { AuditWriter } from '../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service';
import { NonRetryableDispatchError } from './errors/dispatch-error';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { computeBackoffDelayMs } from './utils/backoff.util';
import { readRelayConfig } from './utils/relay-config.util';
import { raceWithTimeout } from './utils/shutdown-drain.util';

const INTERVAL_NAME = 'outbox-relay-poll';
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SWEEP_BATCH_SIZE = 100;

interface ClaimedOutboxRow {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attemptCount: number;
  createdAt: Date;
}

interface SweptOutboxRow {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
}

// Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 5): outbox_events
// tuketicisi. Claim, attemptCount'u ATOMIK olarak artirir (crash sonrasi
// bile deneme hakki tuketilmis sayilir); FOR UPDATE SKIP LOCKED, iki
// worker'in ayni satiri claim etmesini yapisal olarak imkansiz kilar.
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private isPolling = false;
  private currentPoll: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly dispatcher: NotificationDispatcher,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    const { enabled, pollIntervalMs } = readRelayConfig(this.config);
    if (!enabled) {
      this.logger.log('OutboxRelay devre disi (OUTBOX_RELAY_ENABLED=false veya NODE_ENV=test).');
      return;
    }

    const handle = setInterval(() => this.scheduleTick(), pollIntervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, handle);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
    if (this.currentPoll) {
      // DUZELTME (pre-commit denetimi): duz Promise.race kaybeden setTimeout'u
      // iptal etmezdi - currentPoll once cozulse bile 10sn'lik zamanlayici
      // arka planda calismaya devam edip process/worker'i gereksiz yere
      // acik tutuyordu (raceWithTimeout ikisini de temizler).
      await raceWithTimeout(this.currentPoll, SHUTDOWN_DRAIN_TIMEOUT_MS);
    }
  }

  // Interval tick'i her zaman scheduleTick() cagirir - re-entrancy guard
  // (isPolling) burada, onceki batch bitmeden yeni tick'in ust uste
  // binmesini onler. pollOnce()'un KENDISI bu korumaya sahip DEGIL (asagi
  // bkz.) - dogruluk SQL SKIP LOCKED'a dayanir, integration testler onu
  // BILEREK eszamanli cagirir.
  private scheduleTick(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.currentPoll = this.pollOnce()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'OutboxRelay poll basarisiz.');
      })
      .finally(() => {
        this.isPolling = false;
        this.currentPoll = null;
      });
  }

  // Tek sweep+claim+dispatch turu. Dogrudan (integration testlerden dahil)
  // cagrilabilir - re-entrancy guard icermez.
  async pollOnce(): Promise<void> {
    const { maxAttempts, batchSize, claimLeaseMs } = readRelayConfig(this.config);
    await this.sweepExhausted(maxAttempts);
    const claimed = await this.claimBatch(maxAttempts, batchSize, claimLeaseMs);
    await Promise.allSettled(claimed.map((row) => this.processClaimedRow(row, maxAttempts)));
  }

  private async claimBatch(
    maxAttempts: number,
    batchSize: number,
    claimLeaseMs: number,
  ): Promise<ClaimedOutboxRow[]> {
    return this.prisma.$queryRaw<ClaimedOutboxRow[]>`
      UPDATE outbox_events
      SET status = 'PROCESSING',
          attempt_count = attempt_count + 1,
          next_attempt_at = now() + (${claimLeaseMs}::text || ' milliseconds')::interval
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status IN ('PENDING', 'PROCESSING')
          AND attempt_count < ${maxAttempts}
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_type AS "eventType", aggregate_type AS "aggregateType",
                aggregate_id AS "aggregateId", payload, attempt_count AS "attemptCount",
                created_at AS "createdAt"
    `;
  }

  // Deneme butcesi (claim aninda) tukenmis satirlar - claim sorgusunun
  // WHERE'i attempt_count < maxAttempts oldugundan bunlar bir daha claim
  // edilmez, sweep olmazsa PENDING/PROCESSING'de sonsuza dek asili kalirlar.
  private async sweepExhausted(maxAttempts: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const swept = await tx.$queryRaw<SweptOutboxRow[]>`
        UPDATE outbox_events
        SET status = 'FAILED', failed_at = now(),
            last_error = COALESCE(last_error, 'MAX_ATTEMPTS_REACHED_AT_CLAIM')
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status IN ('PENDING', 'PROCESSING')
            AND attempt_count >= ${maxAttempts}
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          LIMIT ${SWEEP_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_type AS "eventType", aggregate_type AS "aggregateType",
                  aggregate_id AS "aggregateId"
      `;

      for (const row of swept) {
        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.OUTBOX_EVENT_FAILED,
          entityType: row.aggregateType,
          entityId: row.aggregateId,
          metadata: { eventType: row.eventType, reason: 'MAX_ATTEMPTS_REACHED_AT_CLAIM' },
        });
      }
    });
  }

  private async processClaimedRow(row: ClaimedOutboxRow, maxAttempts: number): Promise<void> {
    try {
      await this.dispatcher.fanOut(row);
      // Basari: fanOut() PROCESSED'i KENDI transaction'inda zaten yazdi
      // (delivery satirlariyla atomik) - relay ayrica bir sey yazmaz.
    } catch (error) {
      await this.resolveFailure(row, maxAttempts, error);
    }
  }

  // DUZELTME (pre-commit denetimi): iki eszamanli fanOut() cagrisindan
  // (crash-reclaim yarisi, plan Bolum 3.1/9.2) kaybeden taraf unique
  // constraint ihlaliyle reddedilir - ama kazanan taraf bu satiri ZATEN
  // PROCESSED yapmis olabilir. Asagidaki her iki yazim da `status =
  // 'PROCESSING'` sarti tasiyan `updateMany` kullanir: satir hala bu
  // worker'in beklediigi durumdaysa (PROCESSING) yazilir; baskasi zaten
  // sonuclandirdiysa (count=0) HICBIR SEY YAZILMAZ - basariyla tamamlanmis
  // bir event'in "hata" yuzunden PENDING'e/FAILED'e cekilmesi boylece
  // yapisal olarak engellenir.
  private async resolveFailure(
    row: ClaimedOutboxRow,
    maxAttempts: number,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error).slice(0, 2000);
    const nonRetryable = error instanceof NonRetryableDispatchError;

    if (nonRetryable || row.attemptCount >= maxAttempts) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.outboxEvent.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: { status: 'FAILED', failedAt: new Date(), nextAttemptAt: null, lastError: message },
        });
        if (updated.count === 0) {
          // Baska bir worker (ör. es zamanli kazanan fanOut() cagrisi) bu
          // satiri zaten sonuclandirmis - bu hata artik gecersiz.
          return;
        }
        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.OUTBOX_EVENT_FAILED,
          entityType: row.aggregateType,
          entityId: row.aggregateId,
          metadata: {
            eventType: row.eventType,
            reason: nonRetryable ? 'NON_RETRYABLE_PAYLOAD' : 'MAX_ATTEMPTS_REACHED',
          },
        });
      });
      return;
    }

    const delayMs = computeBackoffDelayMs(row.attemptCount);
    await this.prisma.outboxEvent.updateMany({
      where: { id: row.id, status: 'PROCESSING' },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: message,
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
