import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DOMAIN_AUDIT_ACTIONS } from '../../common/constants/domain-audit-actions.constant';
import { AuditWriter } from '../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service';
import { SMS_PROVIDER, type SmsProvider } from '../../infrastructure/sms/sms-provider.interface';
import { SMS_METHODS } from './constants/sms-method.constant';
import { raceWithTimeout } from '../../common/utils/shutdown-drain.util';
import { computeBackoffDelayMs } from './utils/backoff.util';
import { readRelayConfig } from './utils/relay-config.util';

const INTERVAL_NAME = 'notification-delivery-relay-poll';
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SWEEP_BATCH_SIZE = 100;

interface ClaimedDeliveryRow {
  id: string;
  sourceEventId: string;
  sourceEventType: string;
  smsMethod: string;
  recipientPhone: string;
  message: string;
  attemptCount: number;
}

interface SweptDeliveryRow {
  id: string;
  sourceEventId: string;
  sourceEventType: string;
}

// Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.1/6.3):
// notification_deliveries tuketicisi - gercek SMS gonderim adimi. Ayni
// claim/backoff/lease modelini OutboxRelay ile PAYLASIR ama ayri, bagimsiz
// bir siniftir (iki tablo icin generic bir taban sinif kurulmaz). Bu adim
// yapisal olarak AT-LEAST-ONCE'tur: SMS basariyla gonderilir gonderilmez
// process cokerse, lease dolunca satir yeniden claim edilip TEKRAR
// gonderilebilir - dokumante edilmis, kabul edilen, nadir bir risktir
// (plan Bolum 6.3/9.2). Her satir bir alici temsil ettigi icin bu risk
// yalniz O TEK alicıyla sinirlidir, digerlerine sicramaz.
@Injectable()
export class NotificationDeliveryRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryRelay.name);
  private isPolling = false;
  private currentPoll: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    const { enabled, pollIntervalMs } = readRelayConfig(this.config);
    if (!enabled) {
      this.logger.log(
        'NotificationDeliveryRelay devre disi (OUTBOX_RELAY_ENABLED=false veya NODE_ENV=test).',
      );
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

  private scheduleTick(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.currentPoll = this.pollOnce()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'NotificationDeliveryRelay poll basarisiz.');
      })
      .finally(() => {
        this.isPolling = false;
        this.currentPoll = null;
      });
  }

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
  ): Promise<ClaimedDeliveryRow[]> {
    return this.prisma.$queryRaw<ClaimedDeliveryRow[]>`
      UPDATE notification_deliveries
      SET status = 'PROCESSING',
          attempt_count = attempt_count + 1,
          next_attempt_at = now() + (${claimLeaseMs}::text || ' milliseconds')::interval
      WHERE id IN (
        SELECT id FROM notification_deliveries
        WHERE status IN ('PENDING', 'PROCESSING')
          AND attempt_count < ${maxAttempts}
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, source_event_id AS "sourceEventId", source_event_type AS "sourceEventType",
                sms_method AS "smsMethod", recipient_phone AS "recipientPhone", message,
                attempt_count AS "attemptCount"
    `;
  }

  private async sweepExhausted(maxAttempts: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const swept = await tx.$queryRaw<SweptDeliveryRow[]>`
        UPDATE notification_deliveries
        SET status = 'FAILED', failed_at = now(),
            last_error = COALESCE(last_error, 'MAX_ATTEMPTS_REACHED_AT_CLAIM')
        WHERE id IN (
          SELECT id FROM notification_deliveries
          WHERE status IN ('PENDING', 'PROCESSING')
            AND attempt_count >= ${maxAttempts}
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          LIMIT ${SWEEP_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, source_event_id AS "sourceEventId", source_event_type AS "sourceEventType"
      `;

      for (const row of swept) {
        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.NOTIFICATION_DELIVERY_FAILED,
          entityType: 'NotificationDelivery',
          entityId: row.id,
          metadata: {
            sourceEventId: row.sourceEventId,
            sourceEventType: row.sourceEventType,
            reason: 'MAX_ATTEMPTS_REACHED_AT_CLAIM',
          },
        });
      }
    });
  }

  private async processClaimedRow(row: ClaimedDeliveryRow, maxAttempts: number): Promise<void> {
    try {
      await this.sendSms(row);
      // DUZELTME (pre-commit denetimi): lease-expiry sonrasi reclaim
      // yarisinda iki worker ayni satiri isleyebilir (plan Bolum 9.2) -
      // `status = 'PROCESSING'` sarti, bu worker'in sonucu baska bir
      // worker'in ZATEN yazdigi sonucun uzerine yazmasini engeller.
      await this.prisma.notificationDelivery.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      await this.resolveFailure(row, maxAttempts, error);
    }
  }

  private async sendSms(row: ClaimedDeliveryRow): Promise<void> {
    if (row.smsMethod === SMS_METHODS.EMERGENCY_ALERT) {
      await this.sms.sendEmergencyAlert(row.recipientPhone, row.message);
      return;
    }
    await this.sms.sendTicketNotification(row.recipientPhone, row.message);
  }

  private async resolveFailure(
    row: ClaimedDeliveryRow,
    maxAttempts: number,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error).slice(0, 2000);

    if (row.attemptCount >= maxAttempts) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.notificationDelivery.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: { status: 'FAILED', failedAt: new Date(), nextAttemptAt: null, lastError: message },
        });
        if (updated.count === 0) {
          return;
        }
        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.NOTIFICATION_DELIVERY_FAILED,
          entityType: 'NotificationDelivery',
          entityId: row.id,
          metadata: {
            sourceEventId: row.sourceEventId,
            sourceEventType: row.sourceEventType,
            reason: 'MAX_ATTEMPTS_REACHED',
          },
        });
      });
      return;
    }

    const delayMs = computeBackoffDelayMs(row.attemptCount);
    await this.prisma.notificationDelivery.updateMany({
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
