import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 4.4/20: billability matrisi gercek DB'ye karsi:
// DRAFT/SUSPENDED -> RED; ACTIVE/EXPIRED -> [start, end+1); TERMINATED ->
// LEAST(end+1, UTC_DATE(terminatedAt)+1) HER IKI DALIYLA. Ayrica currency'nin
// kilitli contract'tan server-side kopyalandigi app yolu.
describe('Invoice billability / contract status matrisi (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoiceService: any;
  let opsActor: { id: string; role: 'OPERATIONS'; sessionId: string; tokenVersion: number };

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { InvoiceService } = await import(
      '../../../src/modules/billing/services/invoice.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    invoiceService = app.get(InvoiceService);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557777001',
        firstName: 'Ops',
        lastName: 'Bill',
        role: 'OPERATIONS',
      },
    });
    opsActor = { id: ops.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 };
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  let siteSeq = 0;
  async function createContract(overrides: Record<string, unknown> = {}): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Bill Site ${siteSeq}`, code: `BIL-${siteSeq}` },
    });
    const contract = await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `BIL-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-120)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(120)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
        ...overrides,
      },
    });
    return contract.id;
  }

  function dto(startOffset: number, endOffset: number) {
    return {
      billingPeriodStart: isoDaysFromToday(startOffset),
      billingPeriodEnd: isoDaysFromToday(endOffset),
      issueDate: isoDaysFromToday(startOffset),
      dueDate: isoDaysFromToday(startOffset + 5),
      amount: '1000.00',
    };
  }

  it.each(['DRAFT', 'SUSPENDED'] as const)(
    '%s sozlesmeye fatura reddedilir: 422 INVOICE_CONTRACT_NOT_BILLABLE',
    async (status) => {
      const contractId = await createContract({ status });
      await expect(
        invoiceService.create(opsActor, contractId, dto(-50, -20)),
      ).rejects.toMatchObject({
        code: 'INVOICE_CONTRACT_NOT_BILLABLE',
        meta: expect.objectContaining({ contractStatus: status }),
      });
    },
  );

  it('EXPIRED sozlesmeye donem-ici GECMISE DONUK fatura olusturulabilir', async () => {
    // Dogal suresi dolmus sozlesme: [gecmis, dun].
    const contractId = await createContract({
      startDate: new Date(`${isoDaysFromToday(-200)}T00:00:00Z`),
      endDate: new Date(`${isoDaysFromToday(-1)}T00:00:00Z`),
      status: 'EXPIRED',
    });
    const invoice = await invoiceService.create(opsActor, contractId, dto(-60, -30));
    expect(invoice.status).toBe('DRAFT');

    // Pencere disina cikan (endDate+1'i asan) donem yine reddedilir.
    await expect(
      invoiceService.create(opsActor, contractId, dto(-30, 30)),
    ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
  });

  describe('TERMINATED LEAST penceresi - iki dal', () => {
    it('dal 1 (terminatedAt < endDate): pencere UTC_DATE(terminatedAt)+1 ile sinirlidir', async () => {
      // 30 gun once feshedilmis: pencere [start, gun-30+1).
      const contractId = await createContract({
        status: 'TERMINATED',
        terminatedAt: new Date(`${isoDaysFromToday(-30)}T14:30:00Z`),
        terminationReason: 'erken fesih',
      });

      // Tam sinirda biten donem gecerli: periodEnd = terminatedAt gunu + 1.
      const ok = await invoiceService.create(opsActor, contractId, dto(-60, -29));
      expect(ok.status).toBe('DRAFT');

      // Bir gun oteye tasan donem reddedilir.
      await expect(
        invoiceService.create(opsActor, contractId, {
          ...dto(-90, -28),
          billingPeriodStart: isoDaysFromToday(-90),
          billingPeriodEnd: isoDaysFromToday(-28),
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
    });

    it('dal 2 (terminatedAt > endDate): pencere dogal endDate+1 sinirini ASAMAZ', async () => {
      // Sozlesme dun bitti; fesih kaydi BUGUN girildi (gec kayit).
      const contractId = await createContract({
        startDate: new Date(`${isoDaysFromToday(-200)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(-10)}T00:00:00Z`),
        status: 'TERMINATED',
        terminatedAt: new Date(),
        terminationReason: 'gec kaydedilen fesih',
      });

      // endDate+1 sinirinda biten tam donem gecerli.
      const ok = await invoiceService.create(opsActor, contractId, dto(-40, -9));
      expect(ok.status).toBe('DRAFT');

      // terminatedAt daha ileride olsa bile endDate+1 otesi reddedilir.
      await expect(
        invoiceService.create(opsActor, contractId, dto(-70, -8)),
      ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
    });
  });

  it('currency server-copy: fatura para birimi KILITLI contracttan kopyalanir (USD sozlesme)', async () => {
    const contractId = await createContract({ currency: 'USD' });
    const invoice = await invoiceService.create(opsActor, contractId, dto(-50, -20));
    expect(invoice.currency).toBe('USD');

    const row = await prisma.contractInvoice.findUnique({ where: { id: invoice.id } });
    expect(row.currency).toBe('USD');
  });
});
