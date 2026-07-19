import { HttpStatus, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';

const PHONE = '+905553331001';
const PHONE_URL = '/api/v1/dev/sms/%2B905553331001/last-otp';

// Faz 9 karar #2 guvenlik kaniti: dev SMS inbox route'u YALNIZ
// NODE_ENV=development VE DEV_SMS_INBOX_ENABLED=true cift kosuluyla mount
// edilir. Bu suite ayni Testcontainers veritabani uzerinde AppModule'u uc
// farkli env kombinasyonuyla (jest.resetModules ile taze modul kaydi)
// boot eder. Production kompozisyonu burada boot EDILMEZ (gercek SMS
// provider olmadan production boot bilincli olarak imkansizdir); production
// dislamasi ayni kosul fonksiyonunun izole unit testiyle kanitlanir
// (src/modules/dev-tools/dev-tools.condition.spec.ts).
describe('Dev SMS inbox route guard (E2E)', () => {
  let testDb: TestDatabase;

  const managedKeys = [
    'NODE_ENV',
    'DEV_SMS_INBOX_ENABLED',
    'OUTBOX_RELAY_ENABLED',
    'BACKGROUND_JOBS_ENABLED',
  ] as const;
  const originalEnv: Partial<Record<(typeof managedKeys)[number], string | undefined>> = {};

  beforeAll(async () => {
    for (const key of managedKeys) {
      originalEnv[key] = process.env[key];
    }
    testDb = await startTestDatabase();
  }, 120000);

  afterAll(async () => {
    // Env sizintisini temizle: --runInBand'de sonraki suite'ler ayni
    // process'i paylasir. NODE_ENV her kosulda 'test'e geri doner.
    for (const key of managedKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.env.NODE_ENV = 'test';
    await stopTestDatabase(testDb);
  });

  // AppModule kompozisyonu import zamaninda process.env okur; her boot'tan
  // once modul kaydi sifirlanir ki kosul guncel env ile degerlendirilsin.
  async function bootApp(): Promise<INestApplication> {
    jest.resetModules();
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    return app;
  }

  it('NODE_ENV=test iken DEV_SMS_INBOX_ENABLED=true olsa bile route mount edilmez (404)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_SMS_INBOX_ENABLED = 'true';

    const app = await bootApp();
    try {
      await request(app.getHttpServer()).get(PHONE_URL).expect(HttpStatus.NOT_FOUND);
    } finally {
      await app.close();
    }
  });

  it('NODE_ENV=development + DEV_SMS_INBOX_ENABLED=false iken route mount edilmez (404)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_SMS_INBOX_ENABLED = 'false';
    // Development boot'unda relay/job varsayilani true'dur; test kosumunda
    // arka plan dongusu istemiyoruz.
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    process.env.BACKGROUND_JOBS_ENABLED = 'false';

    const app = await bootApp();
    try {
      await request(app.getHttpServer()).get(PHONE_URL).expect(HttpStatus.NOT_FOUND);
    } finally {
      await app.close();
      process.env.NODE_ENV = 'test';
    }
  });

  it('NODE_ENV=development + DEV_SMS_INBOX_ENABLED=true iken OTP kodu endpoint ile alinabilir ve loglara sizmamistir', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_SMS_INBOX_ENABLED = 'true';
    process.env.OUTBOX_RELAY_ENABLED = 'false';
    process.env.BACKGROUND_JOBS_ENABLED = 'false';

    const app = await bootApp();
    // bootApp'in resetModules cagrisindan SONRA import edildikleri icin bu
    // siniflar uygulamanin kullandigi modul kopyalariyla aynidir.
    const { PrismaService } = await import(
      '../../src/infrastructure/database/prisma/prisma.service'
    );
    const { Logger } = await import('@nestjs/common');

    const logSpies = [
      jest.spyOn(Logger.prototype, 'log'),
      jest.spyOn(Logger.prototype, 'debug'),
      jest.spyOn(Logger.prototype, 'warn'),
      jest.spyOn(Logger.prototype, 'error'),
      jest.spyOn(Logger.prototype, 'verbose'),
    ];

    try {
      const prisma = app.get(PrismaService);
      const site = await prisma.facility.create({
        data: { type: 'SITE', name: 'DevInbox Site', code: 'DEVINBOX' },
      });
      const user = await prisma.user.create({
        data: { phoneNumber: PHONE, firstName: 'Dev', lastName: 'Inbox', role: 'RESIDENT' },
      });
      await prisma.siteMembership.create({
        data: { userId: user.id, siteId: site.id, membershipRole: 'RESIDENT', isActive: true },
      });

      const server = app.getHttpServer();

      await request(server)
        .post('/api/v1/auth/otp/request')
        .send({ phoneNumber: PHONE })
        .expect(HttpStatus.OK);

      const inboxRes = await request(server).get(PHONE_URL).expect(HttpStatus.OK);
      const { code } = inboxRes.body as { code: string };
      expect(code).toMatch(/^\d{6}$/);

      // Donen kod gercekten gecerli OTP'dir: verify basarili olur.
      const verifyRes = await request(server)
        .post('/api/v1/auth/otp/verify')
        .send({ phoneNumber: PHONE, code })
        .expect(HttpStatus.OK);
      expect((verifyRes.body as { accessToken: string }).accessToken).toEqual(expect.any(String));

      // OTP kodu hicbir Logger cagrisinda gecmez (maskelenmis telefon
      // loglanabilir; kodun kendisi asla).
      const loggedText = logSpies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => String(arg))
        .join(' ');
      expect(loggedText).not.toContain(code);
    } finally {
      for (const spy of logSpies) {
        spy.mockRestore();
      }
      await app.close();
      process.env.NODE_ENV = 'test';
      delete process.env.DEV_SMS_INBOX_ENABLED;
    }
  });
});
