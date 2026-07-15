import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 10/20: '[)' yari-acik fatura donemi semantigi.
// Contract araligi '[]' kapsayici oldugundan dogru pencere ust siniri
// endDate + 1 gundur: tam-donem faturasi (periodEnd = endDate+1) GECERLIDIR;
// naif 'periodEnd <= endDate' kontrolu bunu yanlis reddederdi. Bitisik
// donemler ([a,b) + [b,c)) hem app hem DB seviyesinde cakismaz.
describe('Invoice period boundary (gercek PostgreSQL)', () => {
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
        phoneNumber: '+905557776001',
        firstName: 'Ops',
        lastName: 'Bound',
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

  const CONTRACT_START = -60;
  const CONTRACT_END = 120;

  let siteSeq = 0;
  async function createActiveContract(): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Bound Site ${siteSeq}`, code: `BND-${siteSeq}` },
    });
    const contract = await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `BND-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(CONTRACT_START)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(CONTRACT_END)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
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

  it('tam-pencere faturasi: periodEnd === endDate + 1 gun GECERLIDIR (kritik sinir)', async () => {
    const contractId = await createActiveContract();
    const invoice = await invoiceService.create(
      opsActor,
      contractId,
      dto(CONTRACT_START, CONTRACT_END + 1),
    );
    expect(invoice.billingPeriodEnd.toISOString().slice(0, 10)).toBe(
      isoDaysFromToday(CONTRACT_END + 1),
    );
  });

  it('periodEnd === endDate + 2 gun 422 INVOICE_PERIOD_OUT_OF_CONTRACT', async () => {
    const contractId = await createActiveContract();
    await expect(
      invoiceService.create(opsActor, contractId, dto(CONTRACT_START, CONTRACT_END + 2)),
    ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
  });

  it('periodStart < contract.startDate 422 INVOICE_PERIOD_OUT_OF_CONTRACT', async () => {
    const contractId = await createActiveContract();
    await expect(
      invoiceService.create(opsActor, contractId, dto(CONTRACT_START - 1, 0)),
    ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
  });

  it("bitisik donemler '[)' geregi cakismaz: [a,b) + [b,c) ikisi de olusur", async () => {
    const contractId = await createActiveContract();
    await invoiceService.create(opsActor, contractId, dto(-50, -20));
    // Ikinci donem tam olarak ilkinin bittigi gun baslar - cakisma degildir.
    const second = await invoiceService.create(opsActor, contractId, dto(-20, 10));
    expect(second.billingPeriodStart.toISOString().slice(0, 10)).toBe(isoDaysFromToday(-20));
  });

  it('kismen ortusen donem app on-kontrolunde 409 INVOICE_PERIOD_OVERLAP', async () => {
    const contractId = await createActiveContract();
    await invoiceService.create(opsActor, contractId, dto(-50, -20));
    await expect(
      invoiceService.create(opsActor, contractId, dto(-35, -5)),
    ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OVERLAP' });
  });

  it("DB seviyesinde de bitisiklik gecerli: on-kontrolu atlayan raw insert '[)' ile kabul edilir", async () => {
    const contractId = await createActiveContract();
    await invoiceService.create(opsActor, contractId, dto(-50, -20));

    // App katmanini tamamen atlayan dogrudan insert - bitisik donem DB'nin
    // excl_invoice_period_overlap '[)' semantigiyle de cakismaz.
    await prisma.$executeRaw`
      INSERT INTO contract_invoices
        (id, contract_id, invoice_number, billing_period_start, billing_period_end,
         issue_date, due_date, amount, currency, status, updated_at)
      VALUES
        (gen_random_uuid(), ${contractId}::uuid,
         ${`BND-RAW-${Math.floor(Math.random() * 1_000_000_000)}`},
         ${isoDaysFromToday(-20)}::date, ${isoDaysFromToday(-10)}::date,
         ${isoDaysFromToday(-20)}::date, ${isoDaysFromToday(-15)}::date,
         1000.00, 'TRY', 'DRAFT', now())
    `;

    const count = await prisma.contractInvoice.count({ where: { contractId } });
    expect(count).toBe(2);
  });
});
