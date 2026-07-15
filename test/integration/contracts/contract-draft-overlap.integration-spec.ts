import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 4.6/20: DRAFT cakisma davranisi.
// - DRAFT-DRAFT cakismasi SERBEST.
// - Create ve DRAFT endDate guncellemesi, mevcut ACTIVE/SUSPENDED kayitlarla
//   application on-kontrolunden gecer (CONTRACT_OVERLAP).
// - DRAFT icin DB exclusion backstop'u YOKTUR (bilinçli sinir) - dogrudan DB
//   insert'i bunu kanitlar; nihai guvence aktivasyonda calisir.
// - '[]' kapsayici-kapsayici sinir: A'nin bittigi gun B'nin baslamasi CAKISMADIR.
describe('Contract DRAFT overlap davranisi (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contractService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errUtil: any;
  let opsActor: { id: string; role: 'OPERATIONS'; sessionId: string; tokenVersion: number };

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { ContractService } = await import(
      '../../../src/modules/contracts/services/contract.service'
    );
    errUtil = await import('../../../src/common/utils/prisma-error.util');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    contractService = app.get(ContractService);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557773001',
        firstName: 'Ops',
        lastName: 'Draft',
        role: 'OPERATIONS',
      },
    });
    opsActor = { id: ops.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 };
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  let siteSeq = 0;
  async function createSite(): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Draft Site ${siteSeq}`, code: `DRF-${siteSeq}` },
    });
    return site.id;
  }

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  it('DRAFT-DRAFT cakismasi serbesttir: ayni sitede ortusen iki taslak olusturulabilir', async () => {
    const siteId = await createSite();
    const a = await contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(-10),
      endDate: isoDaysFromToday(100),
      monthlyFee: '1000.00',
      billingDay: 1,
    });
    const b = await contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(30),
      endDate: isoDaysFromToday(200),
      monthlyFee: '2000.00',
      billingDay: 1,
    });
    expect(a.status).toBe('DRAFT');
    expect(b.status).toBe('DRAFT');
  });

  it('create sirasinda ACTIVE ile cakisma application on-kontrolunde yakalanir', async () => {
    const siteId = await createSite();
    await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `DRF-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-30)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(60)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });

    await expect(
      contractService.create(opsActor, {
        siteId,
        startDate: isoDaysFromToday(0),
        endDate: isoDaysFromToday(120),
        monthlyFee: '1000.00',
        billingDay: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_OVERLAP' });
  });

  it('DRAFT endDate guncellemesi ACTIVE penceresine girerse on-kontrol reddeder', async () => {
    const siteId = await createSite();
    // ACTIVE: [gun+50, gun+150]
    await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `DRF-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(50)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(150)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
    // DRAFT: [gun-10, gun+20] - cakismiyor, olusur.
    const draft = await contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(-10),
      endDate: isoDaysFromToday(20),
      monthlyFee: '1000.00',
      billingDay: 1,
    });

    // DRAFT'ta endDate ileri/geri serbest AMA ACTIVE ile cakisirsa RED.
    await expect(
      contractService.update(opsActor, draft.id, { endDate: isoDaysFromToday(80) }),
    ).rejects.toMatchObject({ code: 'CONTRACT_OVERLAP' });

    // Geri yonde (kisaltma) DRAFT'ta serbest.
    const shortened = await contractService.update(opsActor, draft.id, {
      endDate: isoDaysFromToday(10),
    });
    expect(shortened.endDate.toISOString().slice(0, 10)).toBe(isoDaysFromToday(10));
  });

  it('DRAFT icin DB exclusion backstop YOKTUR: dogrudan DB inserti ACTIVE ile cakisan DRAFT kabul eder', async () => {
    const siteId = await createSite();
    await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `DRF-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-30)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(60)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });

    // Uygulama on-kontrolunu atlayan dogrudan insert: DRAFT satiri
    // excl_contracts_active_overlap'in WHERE kumesinde olmadigindan DB kabul
    // eder - bu, planda acikca belgelenen bilincli sinirdir.
    const overlappingDraft = await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `DRF-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(0)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(90)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'DRAFT',
        createdByUserId: opsActor.id,
      },
    });
    expect(overlappingDraft.status).toBe('DRAFT');

    // Nihai guvence aktivasyonda: bu DRAFT aktive edilmeye kalkilirsa
    // (on-kontrol + gercek EXCLUDE) reddedilir.
    await expect(
      contractService.update(opsActor, overlappingDraft.id, { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_OVERLAP' });
  });

  it("'[]' kapsayici sinir: A'nin bittigi gun B'nin baslamasi cakismadir (app + gercek 23P01)", async () => {
    const siteId = await createSite();
    const boundaryDay = isoDaysFromToday(60);
    await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `DRF-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-30)}T00:00:00Z`),
        endDate: new Date(`${boundaryDay}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });

    // Uygulama on-kontrolu: ayni gun baslayan yeni sozlesme CAKISIR.
    await expect(
      contractService.create(opsActor, {
        siteId,
        startDate: boundaryDay,
        endDate: isoDaysFromToday(200),
        monthlyFee: '1000.00',
        billingDay: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_OVERLAP' });

    // DB seviyesi: on-kontrolu atlayip dogrudan ACTIVE insert -> gercek 23P01.
    let dbError: unknown = null;
    try {
      await prisma.contract.create({
        data: {
          siteId,
          contractNumber: `DRF-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
          startDate: new Date(`${boundaryDay}T00:00:00Z`),
          endDate: new Date(`${isoDaysFromToday(200)}T00:00:00Z`),
          monthlyFee: '1000.00',
          billingDay: 1,
          status: 'ACTIVE',
          createdByUserId: opsActor.id,
        },
      });
    } catch (error) {
      dbError = error;
    }
    expect(dbError).not.toBeNull();
    expect(errUtil.isExclusionConstraintViolation(dbError, 'excl_contracts_active_overlap')).toBe(
      true,
    );

    // Ertesi gun baslayan sozlesme ise cakismaz.
    const nextDay = await contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(61),
      endDate: isoDaysFromToday(200),
      monthlyFee: '1000.00',
      billingDay: 1,
    });
    const activated = await contractService.update(opsActor, nextDay.id, { status: 'ACTIVE' });
    expect(activated.status).toBe('ACTIVE');
  });
});
