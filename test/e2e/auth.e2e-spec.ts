import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

describe('Auth E2E (tam uygulama + Testcontainers)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let smsProvider: CapturingSmsProvider;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../src/app.module');
    const { PrismaService } = await import(
      '../../src/infrastructure/database/prisma/prisma.service'
    );
    const { SMS_PROVIDER } = await import('../../src/infrastructure/sms/sms-provider.interface');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useClass(CapturingSmsProvider)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    smsProvider = app.get(SMS_PROVIDER);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  it('resident: otp request -> yanlis kod -> dogru kod -> me -> refresh -> reuse -> logout', async () => {
    const phone = '+905553330001';
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: 'E2E Site', code: 'E2E-SITE' },
    });
    const user = await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'E2E', lastName: 'Resident', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId: site.id, membershipRole: 'RESIDENT', isActive: true },
    });

    const server = app.getHttpServer();

    const requestRes = await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: phone })
      .expect(HttpStatus.OK);
    expect(requestRes.body.message).toEqual(expect.any(String));

    const code = smsProvider.getLastCode(phone);
    expect(code).toMatch(/^\d{6}$/);

    await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: phone, code: '000000' })
      .expect(HttpStatus.UNAUTHORIZED)
      .expect((res) => {
        expect(res.body.error.code).toBe('AUTH_INVALID_OTP');
      });

    const verifyRes = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: phone, code })
      .expect(HttpStatus.OK);

    const { accessToken, refreshToken } = verifyRes.body as {
      accessToken: string;
      refreshToken: string;
    };
    expect(accessToken).toEqual(expect.any(String));
    expect(refreshToken).toEqual(expect.any(String));
    expect(verifyRes.body.user.role).toBe('RESIDENT');

    const meRes = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(HttpStatus.OK);
    expect(meRes.body.role).toBe('RESIDENT');
    expect(meRes.body.memberships).toHaveLength(1);

    await request(server).get('/api/v1/auth/me').expect(HttpStatus.UNAUTHORIZED);

    const refreshRes = await request(server)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken })
      .expect(HttpStatus.OK);
    const newRefreshToken = (refreshRes.body as { refreshToken: string }).refreshToken;
    expect(newRefreshToken).not.toBe(refreshToken);

    await request(server)
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken })
      .expect(HttpStatus.UNAUTHORIZED)
      .expect((res) => {
        expect(res.body.error.code).toBe('AUTH_INVALID_REFRESH');
      });

    const sessions = await prisma.refreshSession.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(
      sessions.every((session: { revokedAt: Date | null }) => session.revokedAt !== null),
    ).toBe(true);

    // /auth/logout JWT korumali (tum roller) - access token hala gecerli
    // (session revoke'u tokenVersion'i degistirmez).
    await request(server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken: newRefreshToken })
      .expect(HttpStatus.NO_CONTENT);

    // Bilinmeyen refresh token'la logout da 204 doner (enumeration korumasi, karar #8).
    await request(server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken: 'unknown-token-that-never-existed' })
      .expect(HttpStatus.NO_CONTENT);
  });

  it('uyeligi olmayan RESIDENT otp isterse generic 200 doner, OTP olusturulmaz, SMS gonderilmez', async () => {
    const noMembershipPhone = '+905553330002';
    await prisma.user.create({
      data: {
        phoneNumber: noMembershipPhone,
        firstName: 'No',
        lastName: 'Membership',
        role: 'RESIDENT',
      },
    });

    const server = app.getHttpServer();
    const res = await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: noMembershipPhone })
      .expect(HttpStatus.OK);
    expect(res.body.message).toEqual(expect.any(String));

    expect(smsProvider.getSentCount(noMembershipPhone)).toBe(0);
    const challenge = await prisma.otpChallenge.findFirst({
      where: { phoneNumber: noMembershipPhone },
    });
    expect(challenge).toBeNull();
  });

  it('gecersiz telefon formatinda 422 VALIDATION_ERROR doner', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: 'not-a-phone' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => {
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
  });

  it('health endpointleri JWT olmadan erisilebilir (@Public)', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/health/liveness').expect(HttpStatus.OK);
  });
});
