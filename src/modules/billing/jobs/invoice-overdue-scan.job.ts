import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { raceWithTimeout } from '../../../common/utils/shutdown-drain.util';
import { utcToday } from '../../../common/utils/billable-window.util';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { InvoiceRepository } from '../repositories/invoice.repository';
import { InvoiceService } from '../services/invoice.service';

const JOB_NAME = 'invoice-overdue-scan';
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const CHUNK_LIMIT = 200;

// Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.1/9/12): BillingModule
// icinde yasar - InvoiceRepository disariya export edilmedigi icin (Faz 7
// karari, degismedi) bu job dogrudan enjekte eder, hicbir yeni export
// gerekmez. OutboxRelay/NotificationDeliveryRelay'in aksine SKIP LOCKED
// claim mekanizmasi YOKTUR: aday sorgusu kilitsizdir, asil mutasyon
// (markOverdueBySystem) her aday icin AYRI bir $transaction'da
// findByIdForUpdate row-lock kullanir - iki instance ayni faturayi
// islemeye calisirsa ikincisi satirda bloke olur, birincinin commit'inden
// sonra durumun zaten degistigini gorur ve sessizce atlar (idempotent-by-
// construction, plan Bolum 5.3 gerekcesiyle ayni - gereksiz advisory lock
// kurulmaz).
@Injectable()
export class InvoiceOverdueScanJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceOverdueScanJob.name);
  private isRunning = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly invoiceService: InvoiceService,
  ) {}

  onModuleInit(): void {
    if (!this.config.getOrThrow<boolean>('backgroundJobs.enabled')) {
      this.logger.log(
        'InvoiceOverdueScanJob devre disi (BACKGROUND_JOBS_ENABLED=false veya NODE_ENV=test).',
      );
      return;
    }

    // Gunluk 02:00 UTC - sunucu locale'inden bagimsiz (CLAUDE.md: "veritabani
    // zamanlari UTC"). @Cron decorator'i YERINE dinamik SchedulerRegistry
    // kaydi kullanilir: decorator argumanlari DI kullanilabilir olmadan once
    // (import zamaninda) sabitlenir, bu yuzden enabled kontrolu
    // ONCESINDE calisamaz - OutboxRelay/NotificationDeliveryRelay ile ayni
    // desen (plan Bolum 10.1 "test ortaminda otomatik baslamama" garantisi).
    const job = CronJob.from({
      cronTime: '0 2 * * *',
      timeZone: 'UTC',
      onTick: () => this.scheduleRun(),
    });
    this.schedulerRegistry.addCronJob(JOB_NAME, job);
    job.start();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('cron', JOB_NAME)) {
      await this.schedulerRegistry.getCronJob(JOB_NAME).stop();
      this.schedulerRegistry.deleteCronJob(JOB_NAME);
    }
    if (this.currentRun) {
      await raceWithTimeout(this.currentRun, SHUTDOWN_DRAIN_TIMEOUT_MS);
    }
  }

  private scheduleRun(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentRun = this.runOnce()
      .catch((error: unknown) => {
        // Job hatasi HTTP API'yi veya bootstrap'i asla dusurmez - burada
        // yutulur, structured log ile gorunur kalir.
        this.logger.error({ err: error }, 'InvoiceOverdueScanJob calismasi basarisiz.');
      })
      .finally(() => {
        this.isRunning = false;
        this.currentRun = null;
      });
  }

  // Tek tarama turu - dogrudan (testlerden dahil) cagrilabilir, zamanlayici
  // beklemez.
  async runOnce(): Promise<void> {
    let candidateCount = CHUNK_LIMIT;
    while (candidateCount >= CHUNK_LIMIT) {
      const candidates = await this.invoiceRepo.findOverdueCandidatesAcrossSites(this.prisma, {
        today: utcToday(),
        limit: CHUNK_LIMIT,
      });
      candidateCount = candidates.length;

      for (const candidate of candidates) {
        try {
          await this.invoiceService.markOverdueBySystem(candidate.id, candidate.siteId);
        } catch (error) {
          // Bir adayin hatasi batch'in kalanini durdurmaz.
          this.logger.error(
            { err: error, invoiceId: candidate.id },
            'InvoiceOverdueScanJob: aday isleme hatasi.',
          );
        }
      }
    }
  }
}
