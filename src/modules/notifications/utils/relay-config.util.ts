import type { ConfigService } from '@nestjs/config';

export interface RelayConfig {
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  claimLeaseMs: number;
  enabled: boolean;
}

// OutboxRelay ve NotificationDeliveryRelay AYNI config dilimini okur
// (onaylanan docs/phase-8-plan.md karar #7) - iki bagimsiz relay sinifinin
// paylastigi tek kucuk yardimci, generic bir taban sinif degil.
export function readRelayConfig(config: ConfigService): RelayConfig {
  return {
    pollIntervalMs: config.getOrThrow<number>('outboxRelay.pollIntervalMs'),
    batchSize: config.getOrThrow<number>('outboxRelay.batchSize'),
    maxAttempts: config.getOrThrow<number>('outboxRelay.maxAttempts'),
    claimLeaseMs: config.getOrThrow<number>('outboxRelay.claimLeaseMs'),
    enabled: config.getOrThrow<boolean>('outboxRelay.enabled'),
  };
}
