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

// Faz 9 Slice 4 sonrasi gecerli hicbir production SMS_PROVIDER kombinasyonu
// yoktur (mock production'da yasak, external implemente edilmedi) - tam
// production dogrulamasi BILINCLI olarak gecmez. Production'a ozgu diger
// kurallarin tek tek dogru calistigi, toplanan hata mesajinin ilgili
// degiskeni icerip icermedigiyle olculur.
function validationErrorMessage(env: Record<string, unknown>): string {
  try {
    validateEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('validateEnv hata firlatmadi (beklenen: en az SMS provider hatasi).');
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

  it('production + OUTBOX_RELAY_ENABLED=false: OUTBOX kurali gecer (kalan tek hata SMS provider fail-fast)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
      BACKGROUND_JOBS_ENABLED: 'false',
    });

    const message = validationErrorMessage(env);
    expect(message).not.toMatch(/OUTBOX_RELAY_ENABLED/);
    expect(message).toMatch(/SMS_PROVIDER/);
  });

  it('production + OUTBOX_RELAY_ENABLED=true: OUTBOX kurali gecer (acikca verildigi surece)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'true',
      BACKGROUND_JOBS_ENABLED: 'false',
    });

    const message = validationErrorMessage(env);
    expect(message).not.toMatch(/OUTBOX_RELAY_ENABLED/);
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

  it('production + BACKGROUND_JOBS_ENABLED=false: JOBS kurali gecer (kalan tek hata SMS provider fail-fast)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
      BACKGROUND_JOBS_ENABLED: 'false',
    });

    const message = validationErrorMessage(env);
    expect(message).not.toMatch(/BACKGROUND_JOBS_ENABLED/);
    expect(message).toMatch(/SMS_PROVIDER/);
  });

  it('production + BACKGROUND_JOBS_ENABLED=true: JOBS kurali gecer (acikca verildigi surece)', () => {
    const env = baseEnv({
      NODE_ENV: 'production',
      SMS_PROVIDER: 'external',
      SMS_API_URL: 'https://sms.example',
      SMS_API_KEY: 'k',
      OUTBOX_RELAY_ENABLED: 'false',
      BACKGROUND_JOBS_ENABLED: 'true',
    });

    const message = validationErrorMessage(env);
    expect(message).not.toMatch(/BACKGROUND_JOBS_ENABLED/);
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

    const message = validationErrorMessage(env);
    expect(message).not.toMatch(/DEV_SMS_INBOX_ENABLED/);
  });
});

// Faz 9 Slice 4: provider fail-fast'in ANA katmani config validation'dir
// (SmsModule/StorageModule factory hatalari ikinci savunma hattidir).
// ExternalSmsProvider ve S3StorageProvider implemente edilmedigi icin
// 'external' ve 's3' hicbir ortamda kabul edilmez; production ayrica mock'u
// da reddettigi icin gercek provider gelene kadar tam production boot
// bilincli olarak kapalidir.
describe('validateEnv - SMS_PROVIDER fail-fast (Faz 9 Slice 4)', () => {
  it('development + mock kabul edilir', () => {
    expect(validateEnv(baseEnv()).SMS_PROVIDER).toBe('mock');
  });

  it('test + mock kabul edilir', () => {
    expect(validateEnv(baseEnv({ NODE_ENV: 'test' })).SMS_PROVIDER).toBe('mock');
  });

  it('production + mock acik mesajla reddedilir', () => {
    const message = validationErrorMessage(
      baseEnv({
        NODE_ENV: 'production',
        OUTBOX_RELAY_ENABLED: 'false',
        BACKGROUND_JOBS_ENABLED: 'false',
      }),
    );
    expect(message).toMatch(/Production ortaminda SMS_PROVIDER=mock kullanilamaz/);
  });

  it('development + external reddedilir (ExternalSmsProvider implemente edilmedi)', () => {
    expect(() =>
      validateEnv(
        baseEnv({ SMS_PROVIDER: 'external', SMS_API_URL: 'https://sms.example', SMS_API_KEY: 'k' }),
      ),
    ).toThrow(/ExternalSmsProvider implemente edilmedi/);
  });

  it('production + external de reddedilir (hicbir ortamda desteklenmez)', () => {
    const message = validationErrorMessage(
      baseEnv({
        NODE_ENV: 'production',
        SMS_PROVIDER: 'external',
        SMS_API_URL: 'https://sms.example',
        SMS_API_KEY: 'k',
        OUTBOX_RELAY_ENABLED: 'false',
        BACKGROUND_JOBS_ENABLED: 'false',
      }),
    );
    expect(message).toMatch(/ExternalSmsProvider implemente edilmedi/);
  });

  it('tanimsiz provider degeri enum tarafindan reddedilir', () => {
    expect(() => validateEnv(baseEnv({ SMS_PROVIDER: 'twilio' }))).toThrow(/SMS_PROVIDER/);
  });
});

describe('validateEnv - STORAGE_PROVIDER fail-fast (Faz 9 Slice 4)', () => {
  it('local kabul edilir', () => {
    expect(validateEnv(baseEnv()).STORAGE_PROVIDER).toBe('local');
  });

  it('s3 reddedilir (S3StorageProvider implemente edilmedi) - S3 alanlari dolu olsa bile', () => {
    expect(() =>
      validateEnv(
        baseEnv({
          STORAGE_PROVIDER: 's3',
          S3_REGION: 'eu-central-1',
          S3_BUCKET: 'bucket',
          S3_ACCESS_KEY: 'ak',
          S3_SECRET_KEY: 'sk',
        }),
      ),
    ).toThrow(/S3StorageProvider implemente edilmedi/);
  });

  it('production + s3 de ayni mesajla reddedilir', () => {
    const message = validationErrorMessage(
      baseEnv({
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 's3',
        S3_REGION: 'eu-central-1',
        S3_BUCKET: 'bucket',
        S3_ACCESS_KEY: 'ak',
        S3_SECRET_KEY: 'sk',
        OUTBOX_RELAY_ENABLED: 'false',
        BACKGROUND_JOBS_ENABLED: 'false',
      }),
    );
    expect(message).toMatch(/S3StorageProvider implemente edilmedi/);
  });

  it('tanimsiz provider degeri enum tarafindan reddedilir', () => {
    expect(() => validateEnv(baseEnv({ STORAGE_PROVIDER: 'gcs' }))).toThrow(/STORAGE_PROVIDER/);
  });
});

// Faz 9 Slice 4 CORS sertlestirmesi: yalniz 'http(s)://host[:port]' bicimli
// origin listesi kabul edilir; '*' hicbir ortamda gecmez (CORS her zaman
// credentials:true ile acilir).
describe('validateEnv - CORS_ALLOWED_ORIGINS (Faz 9 Slice 4)', () => {
  it('gecerli tek origin kabul edilir', () => {
    const result = validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com' }));
    expect(result.CORS_ALLOWED_ORIGINS).toBe('https://app.example.com');
  });

  it('development localhost origin kabul edilir (mevcut davranis korunur)', () => {
    const result = validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173' }));
    expect(result.CORS_ALLOWED_ORIGINS).toBe('http://localhost:5173');
  });

  it('birden fazla origin ve girdi cevresindeki whitespace kabul edilir', () => {
    const result = validateEnv(
      baseEnv({
        CORS_ALLOWED_ORIGINS: ' https://app.example.com , http://admin.example.com:8080 ',
      }),
    );
    expect(result.CORS_ALLOWED_ORIGINS).toContain('https://app.example.com');
  });

  it('bos girdi (ardisik veya sondaki virgul) reddedilir', () => {
    expect(() =>
      validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com,,https://b.example' })),
    ).toThrow(/bos veya yalniz whitespace/);
    expect(() =>
      validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: 'https://app.example.com,' })),
    ).toThrow(/bos veya yalniz whitespace/);
  });

  it('yalniz whitespace deger reddedilir', () => {
    expect(() => validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: '   ' }))).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
  });

  it("development ortaminda dahi '*' reddedilir (credentials:true ile kullanilamaz)", () => {
    expect(() => validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: '*' }))).toThrow(/wildcard/);
  });

  it("production ortaminda '*' reddedilir", () => {
    const message = validationErrorMessage(
      baseEnv({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: '*',
        OUTBOX_RELAY_ENABLED: 'false',
        BACKGROUND_JOBS_ENABLED: 'false',
      }),
    );
    expect(message).toMatch(/wildcard/);
  });

  it('bozuk URL reddedilir', () => {
    expect(() => validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: 'not-an-origin' }))).toThrow(
      /gecersiz origin/,
    );
    expect(() => validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: 'ftp://files.example.com' }))).toThrow(
      /gecersiz origin/,
    );
  });

  it('path, query, fragment veya trailing slash iceren girdiler reddedilir', () => {
    for (const invalid of [
      'https://app.example.com/path',
      'https://app.example.com?x=1',
      'https://app.example.com#top',
      'https://app.example.com/',
    ]) {
      expect(() => validateEnv(baseEnv({ CORS_ALLOWED_ORIGINS: invalid }))).toThrow(
        /gecersiz origin/,
      );
    }
  });
});
