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
