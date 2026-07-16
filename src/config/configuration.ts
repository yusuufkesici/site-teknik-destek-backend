import { registerAs } from '@nestjs/config';
import { validateEnv, type EnvConfig } from './validation.schema';

let cachedEnv: EnvConfig | undefined;

// ConfigModule.forRoot({ validate }) zaten process.env'i bootstrap'te
// dogrular (fail-fast). Burada ayni dogrulama, gruplu/tipli config
// dilimlerini uretmek icin tek seferlik yeniden calistirilir ve
// bellekte tutulur.
function getValidatedEnv(): EnvConfig {
  cachedEnv ??= validateEnv(process.env);
  return cachedEnv;
}

export const appConfig = registerAs('app', () => {
  const env = getValidatedEnv();
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    apiPrefix: 'api/v1',
  };
});

export const corsConfig = registerAs('cors', () => {
  const env = getValidatedEnv();
  return {
    allowedOrigins: env.CORS_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
});

export const loggingConfig = registerAs('logging', () => {
  const env = getValidatedEnv();
  return {
    level: env.LOG_LEVEL,
  };
});

export const databaseConfig = registerAs('database', () => {
  const env = getValidatedEnv();
  return {
    url: env.DATABASE_URL,
  };
});

export const authConfig = registerAs('auth', () => {
  const env = getValidatedEnv();
  return {
    jwtAccessSecrets: env.JWT_ACCESS_SECRET.split(',').map((secret) => secret.trim()),
    jwtAccessExpiresInSeconds: env.JWT_ACCESS_EXPIRES_IN,
    refreshTokenPepper: env.REFRESH_TOKEN_PEPPER,
    refreshTokenExpiresInSeconds: env.REFRESH_TOKEN_EXPIRES_IN,
    otpHmacSecret: env.OTP_HMAC_SECRET,
    otpExpiresInSeconds: env.OTP_EXPIRES_IN_SECONDS,
    otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
    otpResendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
  };
});

export const ticketsConfig = registerAs('tickets', () => {
  const env = getValidatedEnv();
  return {
    emergencySlaHours: env.EMERGENCY_SLA_HOURS,
  };
});

// Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 13): OutboxRelay ve
// NotificationDeliveryRelay bu AYNI dilimi okur (onaylanan karar #7).
export const outboxRelayConfig = registerAs('outboxRelay', () => {
  const env = getValidatedEnv();
  // validation.schema.ts'te OUTBOX_RELAY_ENABLED artik alan-seviyesinde
  // varsayilan/transform ICERMIYOR (ham 'true'|'false'|undefined) - Zod
  // superRefine, production'da bu alanin ACIKCA verilmesini zorunlu kilar
  // (fail-fast, sessiz varsayilan yok). Gercek varsayilan (true) yalniz
  // BURADA, yalniz development/test rahatligi icin uygulanir; production'a
  // asla ORTUK sekilde acik baslamis bir relay ile ulasilamaz cunku
  // superRefine zaten process'i baslatmadan durdurur.
  const outboxRelayEnabledRaw = env.OUTBOX_RELAY_ENABLED ?? 'true';
  return {
    pollIntervalMs: env.OUTBOX_RELAY_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_RELAY_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    claimLeaseMs: env.OUTBOX_CLAIM_LEASE_MS,
    // Rev 1.1 bulgu F: NODE_ENV=test HER ZAMAN otomatik kapatir - ayri bir
    // test-setup dosyasinin OUTBOX_RELAY_ENABLED=false set etmeyi
    // hatirlamasina bagimli degildir (plan Bolum 10.1).
    enabled: env.NODE_ENV !== 'test' && outboxRelayEnabledRaw === 'true',
  };
});

export const storageConfig = registerAs('storage', () => {
  const env = getValidatedEnv();
  return {
    provider: env.STORAGE_PROVIDER,
    localPath: env.STORAGE_LOCAL_PATH,
    s3: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
  };
});
