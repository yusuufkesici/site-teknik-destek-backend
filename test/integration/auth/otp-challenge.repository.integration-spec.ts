import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('OtpChallengeRepository (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let otpChallengeRepo: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { OtpChallengeRepository } = await import(
      '../../../src/modules/auth/repositories/otp-challenge.repository'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    otpChallengeRepo = app.get(OtpChallengeRepository);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  async function createUser(phoneSuffix: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+9055500${phoneSuffix}`,
        firstName: 'Test',
        lastName: 'User',
        role: 'RESIDENT',
      },
    });
    return user.id;
  }

  it('findActiveForUpdate yalniz tuketilmemis/gecersiz kilinmamis/suresi dolmamis en son satiri bulur', async () => {
    const userId = await createUser('00001');
    const phone = '+905550000001';

    await prisma.otpChallenge.create({
      data: {
        userId,
        phoneNumber: phone,
        purpose: 'LOGIN',
        codeHash: 'old-hash',
        expiresAt: new Date(Date.now() - 1000),
        maxAttempts: 5,
        requestedIp: '127.0.0.1',
      },
    });

    const active = await prisma.otpChallenge.create({
      data: {
        userId,
        phoneNumber: phone,
        purpose: 'LOGIN',
        codeHash: 'active-hash',
        expiresAt: new Date(Date.now() + 60000),
        maxAttempts: 5,
        requestedIp: '127.0.0.1',
      },
    });

    const found = await otpChallengeRepo.findActiveForUpdate(prisma, phone);

    expect(found?.id).toBe(active.id);
    expect(found?.codeHash).toBe('active-hash');
  });

  it('incrementAttemptAndMaybeInvalidate esik altinda yalniz sayaci artirir, invalidate etmez', async () => {
    const userId = await createUser('00002');
    const challenge = await prisma.otpChallenge.create({
      data: {
        userId,
        phoneNumber: '+905550000002',
        purpose: 'LOGIN',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() + 60000),
        maxAttempts: 5,
        attemptCount: 2,
        requestedIp: '127.0.0.1',
      },
    });

    const result = await otpChallengeRepo.incrementAttemptAndMaybeInvalidate(prisma, challenge.id, 5);

    expect(result).toEqual({ attemptCount: 3, invalidated: false });

    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.invalidatedAt).toBeNull();
  });

  it('5. hatali denemede attemptCount artisiyla AYNI ANDA invalidatedAt set edilir (tek atomik UPDATE)', async () => {
    const userId = await createUser('00003');
    const challenge = await prisma.otpChallenge.create({
      data: {
        userId,
        phoneNumber: '+905550000003',
        purpose: 'LOGIN',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() + 60000),
        maxAttempts: 5,
        attemptCount: 4,
        requestedIp: '127.0.0.1',
      },
    });

    const result = await otpChallengeRepo.incrementAttemptAndMaybeInvalidate(prisma, challenge.id, 5);

    expect(result).toEqual({ attemptCount: 5, invalidated: true });

    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(row.invalidatedAt).not.toBeNull();

    // Bir sonraki istek (ekstra deneme beklemeden) artik bu satiri bulamaz.
    const found = await otpChallengeRepo.findActiveForUpdate(prisma, '+905550000003');
    expect(found).toBeNull();
  });

  it('invalidateOpen ayni telefon icin acik onceki challenge lari gecersiz kilar', async () => {
    const userId = await createUser('00004');
    const phone = '+905550000004';
    const first = await prisma.otpChallenge.create({
      data: {
        userId,
        phoneNumber: phone,
        purpose: 'LOGIN',
        codeHash: 'first-hash',
        expiresAt: new Date(Date.now() + 60000),
        maxAttempts: 5,
        requestedIp: '127.0.0.1',
      },
    });

    await otpChallengeRepo.invalidateOpen(prisma, phone);

    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.invalidatedAt).not.toBeNull();
  });
});
