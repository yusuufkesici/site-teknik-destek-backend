import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

const REFRESH_TOKEN_PEPPER = 'refresh-token-pepper-'.padEnd(40, 'x');

describe('TokenService.rotate - reuse detection (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tokenService: any;
  let hashRefreshToken: (pepper: string, raw: string) => string;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { TokenService } = await import('../../../src/modules/auth/services/token.service');
    const otpCryptoUtil = await import('../../../src/modules/auth/utils/otp-crypto.util');
    hashRefreshToken = otpCryptoUtil.hashRefreshToken;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    tokenService = app.get(TokenService);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  it('rotate basarili olur; eski token tekrar sunulunca kullanicinin TUM session lari revoke edilir', async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: '+905552220001', firstName: 'Rotate', lastName: 'User', role: 'RESIDENT' },
    });

    const originalRaw = randomBytes(48).toString('base64url');
    const originalSession = await prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(REFRESH_TOKEN_PEPPER, originalRaw),
        ipAddress: '127.0.0.1',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      },
    });

    const ctx = { ip: '127.0.0.1', userAgent: 'jest-integration' };

    const rotated = await tokenService.rotate(originalRaw, ctx);
    expect(rotated.refreshToken).not.toBe(originalRaw);

    const oldRow = await prisma.refreshSession.findUniqueOrThrow({ where: { id: originalSession.id } });
    expect(oldRow.revokedAt).not.toBeNull();
    expect(oldRow.replacedByTokenId).not.toBeNull();

    // Eski (zaten rotate edilmis) token'i TEKRAR sunmak reuse detection'i tetikler.
    await expect(tokenService.rotate(originalRaw, ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_REFRESH',
    });

    const allSessions = await prisma.refreshSession.findMany({ where: { userId: user.id } });
    expect(allSessions.length).toBeGreaterThanOrEqual(2);
    expect(allSessions.every((session: { revokedAt: Date | null }) => session.revokedAt !== null)).toBe(
      true,
    );
  });
});
