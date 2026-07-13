import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

const OTP_HMAC_SECRET = 'otp-hmac-secret-'.padEnd(40, 'x');
const CODE = '654321';

describe('AuthService.verifyOtp - gercek concurrency (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let authService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hmacSha256: (secret: string, payload: string) => string;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { AuthService } = await import('../../../src/modules/auth/services/auth.service');
    const otpCryptoUtil = await import('../../../src/modules/auth/utils/otp-crypto.util');
    hmacSha256 = otpCryptoUtil.hmacSha256;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  it('iki paralel verifyOtp cagrisindan YALNIZ biri basarili olur (FOR UPDATE satir kilidi)', async () => {
    const phone = '+905551110001';
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: 'Test Site', code: 'TST-CONC' },
    });
    const user = await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Concurrent', lastName: 'User', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId: site.id, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.otpChallenge.create({
      data: {
        userId: user.id,
        phoneNumber: phone,
        purpose: 'LOGIN',
        codeHash: hmacSha256(OTP_HMAC_SECRET, `${phone}:${CODE}`),
        expiresAt: new Date(Date.now() + 60000),
        maxAttempts: 5,
        requestedIp: '127.0.0.1',
      },
    });

    const ctx = { ip: '127.0.0.1', userAgent: 'jest-integration' };
    const results = await Promise.allSettled([
      authService.verifyOtp(phone, CODE, ctx),
      authService.verifyOtp(phone, CODE, ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const sessions = await prisma.refreshSession.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);

    const challenge = await prisma.otpChallenge.findFirstOrThrow({ where: { phoneNumber: phone } });
    expect(challenge.consumedAt).not.toBeNull();
  });
});
