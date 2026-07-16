import { validateEnv } from './validation.schema';

// Faz 8 Dilim 1 pre-commit denetimi: OUTBOX_RELAY_ENABLED'in production'da
// sessiz varsayilan almadan, acikca verilmesinin ZORUNLU oldugunu dogrular
// (ilk deploy'da unutulup relay'in sessizce acik baslamasi riskini kapatir).
function baseEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://app:app@localhost:5432/site_support',
    JWT_ACCESS_SECRET: 'jwt-access-secret-'.padEnd(40, 'x'),
    JWT_ACCESS_EXPIRES_IN: '900',
    REFRESH_TOKEN_PEPPER: 'refresh-token-pepper-'.padEnd(40, 'x'),
    REFRESH_TOKEN_EXPIRES_IN: '2592000',
    OTP_HMAC_SECRET: 'otp-hmac-secret-'.padEnd(40, 'x'),
    OTP_EXPIRES_IN_SECONDS: '180',
    OTP_MAX_ATTEMPTS: '5',
    OTP_RESEND_COOLDOWN_SECONDS: '60',
    SMS_PROVIDER: 'mock',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_PATH: './var/uploads',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'info',
    EMERGENCY_SLA_HOURS: '2',
    ...overrides,
  };
}

describe('validateEnv - OUTBOX_RELAY_ENABLED', () => {
  it('production + OUTBOX_RELAY_ENABLED verilmemis: dogrulama BASARISIZ olur (sessiz varsayilan yok)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
    });

    expect(() => validateEnv(env)).toThrow(/OUTBOX_RELAY_ENABLED/);
  });

  it('production + OUTBOX_RELAY_ENABLED=false: dogrulama BASARILI olur', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
    });

    const result = validateEnv(env);
    expect(result.OUTBOX_RELAY_ENABLED).toBe('false');
  });

  it('production + OUTBOX_RELAY_ENABLED=true: dogrulama BASARILI olur (acikca verildigi surece)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'true',
    });

    const result = validateEnv(env);
    expect(result.OUTBOX_RELAY_ENABLED).toBe('true');
  });

  it('development + OUTBOX_RELAY_ENABLED verilmemis: dogrulama BASARILI olur (production-disi zorunluluk yok)', () => {
    const env = baseEnv();

    const result = validateEnv(env);
    expect(result.OUTBOX_RELAY_ENABLED).toBeUndefined();
  });

  it('test + OUTBOX_RELAY_ENABLED verilmemis: dogrulama BASARILI olur', () => {
    const env = baseEnv({ NODE_ENV: 'test' });

    const result = validateEnv(env);
    expect(result.OUTBOX_RELAY_ENABLED).toBeUndefined();
  });
});
