import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { utcToday } from '../../../common/utils/billable-window.util';
import { raceWithTimeout } from '../../../common/utils/shutdown-drain.util';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { ContractRepository } from '../repositories/contract.repository';
import { ContractService } from '../services/contract.service';

const JOB_NAME = 'contract-expiring-scan';
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const CHUNK_LIMIT = 200;

// Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.2/9/12): ContractsModule
// icinde yasar - ContractRepository disariya export edilmedigi icin (Faz 7
// karari, degismedi) bu job dogrudan enjekte eder, hicbir yeni export
// gerekmez. InvoiceOverdueScanJob ile BIREBIR ayni desen: kilitsiz aday
// sorgusu + her aday icin ayri $transaction'da findByIdForUpdate row-lock
// (gereksiz advisory lock yok, plan Bolum 5.3).
@Injectable()
export class ContractExpiringScanJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractExpiringScanJob.name);
  private isRunning = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly contractRepo: ContractRepository,
    private readonly contractService: ContractService,
  ) {}

  onModuleInit(): void {
    if (!this.config.getOrThrow<boolean>('backgroundJobs.enabled')) {
      this.logger.log(
        'ContractExpiringScanJob devre disi (BACKGROUND_JOBS_ENABLED=false veya NODE_ENV=test).',
      );
      return;
    }

    // Gunluk 02:00 UTC - InvoiceOverdueScanJob ile ayni saatte, ayni
    // gerekce (CLAUDE.md: "veritabani zamanlari UTC"). Dinamik
    // SchedulerRegistry kaydi (@Cron decorator DEGIL) - plan Bolum 10.1
    // "test ortaminda otomatik baslamama" garantisiyle ayni desen.
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
        this.logger.error({ err: error }, 'ContractExpiringScanJob calismasi basarisiz.');
      })
      .finally(() => {
        this.isRunning = false;
        this.currentRun = null;
      });
  }

  async runOnce(): Promise<void> {
    const leadDays = this.config.getOrThrow<number>('contracts.expiryLeadDays');
    let candidateCount = CHUNK_LIMIT;
    while (candidateCount >= CHUNK_LIMIT) {
      const candidates = await this.contractRepo.findExpiringSoonAcrossSites(this.prisma, {
        today: utcToday(),
        leadDays,
        limit: CHUNK_LIMIT,
      });
      candidateCount = candidates.length;

      for (const candidate of candidates) {
        try {
          await this.contractService.markExpiringNotifiedBySystem(
            candidate.id,
            candidate.siteId,
            leadDays,
          );
        } catch (error) {
          this.logger.error(
            { err: error, contractId: candidate.id },
            'ContractExpiringScanJob: aday isleme hatasi.',
          );
        }
      }
    }
  }
}
