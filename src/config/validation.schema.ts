import { z } from 'zod';

// docs/implementation-overrides.md #11: tam degisken listesi, koszullu
// dogrulama yalniz parse edilmis env nesnesi uzerinden calisir (dogrudan
// process.env okunmaz).
const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  // Rotasyon destegi: virgulle ayrilmis birden fazla secret olabilir.
  // Imzalama ilk degeri kullanir, dogrulama tumunu sirayla dener
  // (docs/architecture.md Bolum 15). Her segmentin uzunlugu superRefine'da
  // kontrol edilir.
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.coerce.number().int().positive(),
  REFRESH_TOKEN_PEPPER: z.string().min(32),
  REFRESH_TOKEN_EXPIRES_IN: z.coerce.number().int().positive(),

  OTP_HMAC_SECRET: z.string().min(32),
  OTP_EXPIRES_IN_SECONDS: z.coerce.number().int().positive(),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive(),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive(),

  SMS_PROVIDER: z.enum(['mock', 'external']),
  SMS_API_URL: z.string().optional(),
  SMS_API_KEY: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3']),
  STORAGE_LOCAL_PATH: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().optional(),

  CORS_ALLOWED_ORIGINS: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Faz 4: EMERGENCY urgency'li ticket'lar icin sabit SLA hedefi (saat).
  // Yalniz contract.emergencyCoverage=true iken kullanilir (onaylanan Faz 4
  // plani Bolum 16).
  EMERGENCY_SLA_HOURS: z.coerce.number().int().positive(),

  // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 13): OutboxRelay ve
  // NotificationDeliveryRelay AYNI dort sayisal degeri paylasir (onaylanan
  // karar #7). Operasyonel tuning degerleri - iş kurali esigi degil.
  OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  OUTBOX_CLAIM_LEASE_MS: z.coerce.number().int().positive().default(60000),
  // Kill-switch (plan Bolum 9.1/10.1). BILINCLI OLARAK z.coerce.boolean()
  // KULLANILMAZ: Zod'da Boolean("false") === true oldugundan
  // z.coerce.boolean() "false" string'ini de true'ya cevirir. Burada AYRICA
  // varsayilan deger de field seviyesinde UYGULANMAZ (transform de yok) -
  // ham string ('true'|'false'|undefined) olarak birakilir, cunku
  // superRefine YALNIZ zaten parse/transform edilmis degeri gorebilir,
  // "hic verilmedi" ile "explicit true verildi" ayrimini goremez. Production
  // icin "acikca verilmemis" kontrolu bu yuzden asagidaki superRefine'da,
  // gercek varsayilan deger uygulamasi ise configuration.ts'teki
  // outboxRelayConfig'te (yalniz production-disi ortamlar icin) yapilir.
  OUTBOX_RELAY_ENABLED: z.enum(['true', 'false']).optional(),
});

export const envSchema = rawEnvSchema.superRefine((env, ctx) => {
  const jwtSecrets = env.JWT_ACCESS_SECRET.split(',').map((secret) => secret.trim());
  if (jwtSecrets.length === 0 || jwtSecrets.some((secret) => secret.length < 32)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_ACCESS_SECRET'],
      message: 'JWT_ACCESS_SECRET virgulle ayrilmis her segment en az 32 karakter olmalidir.',
    });
  }

  if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'mock') {
    ctx.addIssue({
      code: 'custom',
      path: ['SMS_PROVIDER'],
      message: 'Production ortaminda SMS_PROVIDER=mock kullanilamaz.',
    });
  }

  // Faz 8 Dilim 1: production'da varsayilan deger KULLANILAMAZ - ilk
  // deploy'da bu degiskenin unutulmasi relay'in sessizce acik baslamasina
  // yol acabilirdi (docs/phase-8-plan.md Bolum 9.1 rollout onerisi: once
  // false, backlog temizligi dogrulanip sonra true). Bu kontrol operatoru
  // acik bir karar vermeye ZORLAR - fail-fast, sessiz varsayilan yok.
  if (env.NODE_ENV === 'production' && env.OUTBOX_RELAY_ENABLED === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['OUTBOX_RELAY_ENABLED'],
      message:
        'Production ortaminda OUTBOX_RELAY_ENABLED acikca belirtilmelidir (true veya false) - varsayilan deger production icin kullanilamaz.',
    });
  }

  if (env.SMS_PROVIDER === 'external') {
    if (!env.SMS_API_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_API_URL'],
        message: 'SMS_PROVIDER=external icin SMS_API_URL zorunludur.',
      });
    }
    if (!env.SMS_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_API_KEY'],
        message: 'SMS_PROVIDER=external icin SMS_API_KEY zorunludur.',
      });
    }
  }

  if (env.STORAGE_PROVIDER === 'local' && !env.STORAGE_LOCAL_PATH) {
    ctx.addIssue({
      code: 'custom',
      path: ['STORAGE_LOCAL_PATH'],
      message: 'STORAGE_PROVIDER=local icin STORAGE_LOCAL_PATH zorunludur.',
    });
  }

  if (env.STORAGE_PROVIDER === 's3') {
    if (!env.S3_REGION) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_REGION'],
        message: 'STORAGE_PROVIDER=s3 icin S3_REGION zorunludur.',
      });
    }
    if (!env.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'STORAGE_PROVIDER=s3 icin S3_BUCKET zorunludur.',
      });
    }
    if (!env.S3_ACCESS_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY'],
        message: 'STORAGE_PROVIDER=s3 icin S3_ACCESS_KEY zorunludur.',
      });
    }
    if (!env.S3_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECRET_KEY'],
        message: 'STORAGE_PROVIDER=s3 icin S3_SECRET_KEY zorunludur.',
      });
    }
  }
});

export type EnvConfig = z.infer<typeof rawEnvSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Environment dogrulama hatasi: ${details}`);
  }

  return result.data;
}
