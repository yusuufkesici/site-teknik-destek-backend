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
      BACKGROUND_JOBS_ENABLED: 'false',
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
      BACKGROUND_JOBS_ENABLED: 'false',
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

// Faz 8 (plan Bolum 10.1/13): BACKGROUND_JOBS_ENABLED, OUTBOX_RELAY_ENABLED
// ile AYNI production-zorunlu desenini kullanir (iki tarama job'unu
// kapatan bagimsiz kill-switch).
describe('validateEnv - BACKGROUND_JOBS_ENABLED', () => {
  it('production + BACKGROUND_JOBS_ENABLED verilmemis: dogrulama BASARISIZ olur (sessiz varsayilan yok)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
    });

    expect(() => validateEnv(env)).toThrow(/BACKGROUND_JOBS_ENABLED/);
  });

  it('production + BACKGROUND_JOBS_ENABLED=false: dogrulama BASARILI olur', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
      BACKGROUND_JOBS_ENABLED: 'false',
    });

    const result = validateEnv(env);
    expect(result.BACKGROUND_JOBS_ENABLED).toBe('false');
  });

  it('production + BACKGROUND_JOBS_ENABLED=true: dogrulama BASARILI olur (acikca verildigi surece)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
      BACKGROUND_JOBS_ENABLED: 'true',
    });

    const result = validateEnv(env);
    expect(result.BACKGROUND_JOBS_ENABLED).toBe('true');
  });

  it('development + BACKGROUND_JOBS_ENABLED verilmemis: dogrulama BASARILI olur (production-disi zorunluluk yok)', () => {
    const env = baseEnv();

    const result = validateEnv(env);
    expect(result.BACKGROUND_JOBS_ENABLED).toBeUndefined();
  });

  it('test + BACKGROUND_JOBS_ENABLED verilmemis: dogrulama BASARILI olur', () => {
    const env = baseEnv({ NODE_ENV: 'test' });

    const result = validateEnv(env);
    expect(result.BACKGROUND_JOBS_ENABLED).toBeUndefined();
  });
});

// Faz 8 (plan Bolum 7.2/13): CONTRACT_EXPIRY_LEAD_DAYS pozitif tam sayi,
// verilmezse varsayilan 30 (production dahil - OUTBOX_RELAY_ENABLED/
// BACKGROUND_JOBS_ENABLED'in aksine bu bir kill-switch degil, sessiz
// varsayilani production'da da guvenlidir).
describe('validateEnv - CONTRACT_EXPIRY_LEAD_DAYS', () => {
  it('verilmemis: varsayilan 30 kullanilir', () => {
    const result = validateEnv(baseEnv());
    expect(result.CONTRACT_EXPIRY_LEAD_DAYS).toBe(30);
  });

  it('gecerli pozitif tam sayi kabul edilir', () => {
    const result = validateEnv(baseEnv({ CONTRACT_EXPIRY_LEAD_DAYS: '45' }));
    expect(result.CONTRACT_EXPIRY_LEAD_DAYS).toBe(45);
  });

  it('sifir veya negatif deger reddedilir', () => {
    expect(() => validateEnv(baseEnv({ CONTRACT_EXPIRY_LEAD_DAYS: '0' }))).toThrow(
      /CONTRACT_EXPIRY_LEAD_DAYS/,
    );
    expect(() => validateEnv(baseEnv({ CONTRACT_EXPIRY_LEAD_DAYS: '-5' }))).toThrow(
      /CONTRACT_EXPIRY_LEAD_DAYS/,
    );
  });
});

// Faz 9 karar #2: DEV_SMS_INBOX_ENABLED yalniz 'true'|'false' string'i
// kabul eder; varsayilan uygulanmaz (undefined kalir - gercek varsayilan
// false, configuration.ts'teki devSmsInboxConfig'tedir). Production'da
// zorunlu DEGILDIR cunku verilmediginde guvenli taraf (kapali) gecerlidir.
describe('validateEnv - DEV_SMS_INBOX_ENABLED', () => {
  it('verilmemis: dogrulama basarili olur ve deger undefined kalir', () => {
    const result = validateEnv(baseEnv());
    expect(result.DEV_SMS_INBOX_ENABLED).toBeUndefined();
  });

  it("'true' ve 'false' string'leri kabul edilir", () => {
    expect(validateEnv(baseEnv({ DEV_SMS_INBOX_ENABLED: 'true' })).DEV_SMS_INBOX_ENABLED).toBe(
      'true',
    );
    expect(validateEnv(baseEnv({ DEV_SMS_INBOX_ENABLED: 'false' })).DEV_SMS_INBOX_ENABLED).toBe(
      'false',
    );
  });

  it('gecersiz deger reddedilir', () => {
    expect(() => validateEnv(baseEnv({ DEV_SMS_INBOX_ENABLED: '1' }))).toThrow(
      /DEV_SMS_INBOX_ENABLED/,
    );
  });

  it('production ortaminda verilmemis olmasi hata degildir (guvenli varsayilan: kapali)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
      BACKGROUND_JOBS_ENABLED: 'false',
    });

    const result = validateEnv(env);
    expect(result.DEV_SMS_INBOX_ENABLED).toBeUndefined();
  });
});
