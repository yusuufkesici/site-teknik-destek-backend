import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 20: tam mutlu yol
// DRAFT -> ACTIVE -> SUSPENDED -> ACTIVE -> TERMINATED, her adimda DB satiri
// + audit + outbox dogrulamasi; KATI EXPIRED siniri (bugun=RED, dun=OK);
// audit/outbox atomikligi (outbox hatasi tum transaction'i geri alir).
describe('Contract lifecycle (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contractService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outboxService: any;
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
    const { OutboxService } = await import('../../../src/infrastructure/events/outbox.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    contractService = app.get(ContractService);
    outboxService = app.get(OutboxService);

    const ops = await prisma.user.create({
      data: { phoneNumber: '+905557771001', firstName: 'Ops', lastName: 'Life', role: 'OPERATIONS' },
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
      data: { type: 'SITE', name: `Life Site ${siteSeq}`, code: `LIFE-${siteSeq}` },
    });
    return site.id;
  }

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  async function auditRows(entityId: string, action: string) {
    return prisma.auditLog.findMany({ where: { entityId, action } });
  }

  async function outboxRows(aggregateId: string, eventType: string) {
    return prisma.outboxEvent.findMany({ where: { aggregateId, eventType } });
  }

  it('tam yasam dongusu: DRAFT -> ACTIVE -> SUSPENDED -> ACTIVE -> TERMINATED', async () => {
    const siteId = await createSite();

    // 1) Olusturma: her zaman DRAFT, numara sequence formatinda.
    const created = await contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(-30),
      endDate: isoDaysFromToday(300),
      monthlyFee: '1500.00',
      billingDay: 5,
    });
    expect(created.status).toBe('DRAFT');
    expect(created.contractNumber).toMatch(/^CNT-\d{4}-\d{6}$/);
    expect((await auditRows(created.id, 'CONTRACT_CREATED')).length).toBe(1);
    expect((await outboxRows(created.id, 'ContractCreated')).length).toBe(1);

    // 2) DRAFT'ta ticari alan duzenleme serbest.
    const updatedFee = await contractService.update(opsActor, created.id, {
      monthlyFee: '1750.50',
    });
    expect(updatedFee.monthlyFee.toFixed(2)).toBe('1750.50');
    expect((await auditRows(created.id, 'CONTRACT_UPDATED')).length).toBe(1);

    // 3) Aktivasyon.
    const active = await contractService.update(opsActor, created.id, { status: 'ACTIVE' });
    expect(active.status).toBe('ACTIVE');
    expect((await auditRows(created.id, 'CONTRACT_ACTIVATED')).length).toBe(1);
    expect((await outboxRows(created.id, 'ContractActivated')).length).toBe(1);

    // 4) ACTIVE'te ticari alan artik kilitli.
    await expect(
      contractService.update(opsActor, created.id, { monthlyFee: '9999.99' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_IMMUTABLE_FIELD' });

    // 5) Askiya al / geri al.
    const suspended = await contractService.update(opsActor, created.id, { status: 'SUSPENDED' });
    expect(suspended.status).toBe('SUSPENDED');
    expect((await auditRows(created.id, 'CONTRACT_SUSPENDED')).length).toBe(1);
    expect((await outboxRows(created.id, 'ContractSuspended')).length).toBe(1);

    const reactivated = await contractService.update(opsActor, created.id, { status: 'ACTIVE' });
    expect(reactivated.status).toBe('ACTIVE');
    expect((await auditRows(created.id, 'CONTRACT_ACTIVATED')).length).toBe(2);

    // 6) Ayni durum tekrari 409.
    await expect(
      contractService.update(opsActor, created.id, { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_STATUS_UNCHANGED' });

    // 7) Fesih: terminatedAt server-set, reason trim'li; metadata'ya reason
    //    METNI yazilmaz.
    const terminated = await contractService.update(opsActor, created.id, {
      status: 'TERMINATED',
      terminationReason: '  musteri talebi  ',
    });
    expect(terminated.status).toBe('TERMINATED');
    expect(terminated.terminatedAt).toBeInstanceOf(Date);
    expect(terminated.terminationReason).toBe('musteri talebi');

    const termAudit = await auditRows(created.id, 'CONTRACT_TERMINATED');
    expect(termAudit.length).toBe(1);
    expect(termAudit[0].metadata.reasonProvided).toBe(true);
    expect(JSON.stringify(termAudit[0].metadata)).not.toContain('musteri talebi');
    expect((await outboxRows(created.id, 'ContractTerminated')).length).toBe(1);

    // 8) Terminal durumdan cikis yok.
    await expect(
      contractService.update(opsActor, created.id, { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_STATUS_TRANSITION' });
    await expect(
      contractService.update(opsActor, created.id, { endDate: isoDaysFromToday(400) }),
    ).rejects.toMatchObject({ code: 'CONTRACT_IMMUTABLE_FIELD' });
  });

  it('KATI EXPIRED siniri: endDate bugunse RED, dunse izinli (gercek DB tarihiyle)', async () => {
    // endDate = bugun: sozlesme o gun boyunca hala gecerli, EXPIRED reddedilir.
    const siteToday = await createSite();
    const endsToday = await prisma.contract.create({
      data: {
        siteId: siteToday,
        contractNumber: `LIFE-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-100)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(0)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
    await expect(
      contractService.update(opsActor, endsToday.id, { status: 'EXPIRED' }),
    ).rejects.toMatchObject({
      code: 'CONTRACT_INVALID_STATUS_TRANSITION',
      meta: expect.objectContaining({ reason: 'END_DATE_NOT_YET_REACHED' }),
    });

    // endDate = dun: EXPIRED izinli.
    const siteYesterday = await createSite();
    const endedYesterday = await prisma.contract.create({
      data: {
        siteId: siteYesterday,
        contractNumber: `LIFE-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-100)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(-1)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
    const expired = await contractService.update(opsActor, endedYesterday.id, {
      status: 'EXPIRED',
    });
    expect(expired.status).toBe('EXPIRED');
    expect((await auditRows(endedYesterday.id, 'CONTRACT_EXPIRED')).length).toBe(1);
    expect((await outboxRows(endedYesterday.id, 'ContractExpired')).length).toBe(1);

    // Gecmis endDate ile (yeniden) aktivasyon da reddedilir.
    await expect(
      contractService.update(opsActor, endedYesterday.id, { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_STATUS_TRANSITION' });
  });

  it('audit/outbox atomikligi: outbox yazimi patlarsa business yazimi da geri alinir', async () => {
    const siteId = await createSite();
    const contract = await contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(-10),
      endDate: isoDaysFromToday(100),
      monthlyFee: '1000.00',
      billingDay: 1,
      notes: 'orijinal not',
    });

    const spy = jest
      .spyOn(outboxService, 'publishInTx')
      .mockRejectedValueOnce(new Error('outbox patladi'));
    try {
      await expect(
        contractService.update(opsActor, contract.id, { notes: 'yeni not' }),
      ).rejects.toThrow('outbox patladi');
    } finally {
      spy.mockRestore();
    }

    // Ayni transaction'daki business + audit yazimlari geri alinmis olmali.
    const row = await prisma.contract.findUnique({ where: { id: contract.id } });
    expect(row.notes).toBe('orijinal not');
    expect((await auditRows(contract.id, 'CONTRACT_UPDATED')).length).toBe(0);
  });
});
