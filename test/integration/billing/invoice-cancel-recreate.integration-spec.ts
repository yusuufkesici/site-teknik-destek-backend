import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 4.11/20: iptal + ayni donem icin yeniden
// olusturma. Kosulsuz unique kaldirildi; yerine yalniz status <> 'CANCELLED'
// kapsayan uq_contract_invoices_period_start_open partial unique index'i
// geldi. CANCELLED fatura donem baslangicini artik rezerve ETMEZ;
// non-CANCELLED cift hala reddedilir. Dogrudan DB testleri dahil.
describe('Invoice cancel + recreate (gercek PostgreSQL, partial unique)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoiceService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errUtil: any;
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
    errUtil = await import('../../../src/common/utils/prisma-error.util');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    invoiceService = app.get(InvoiceService);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557778001',
        firstName: 'Ops',
        lastName: 'Cancel',
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
  async function createActiveContract(): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Cancel Site ${siteSeq}`, code: `CNL-${siteSeq}` },
    });
    const contract = await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `CNL-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-120)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(120)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
    return contract.id;
  }

  function dto() {
    return {
      billingPeriodStart: isoDaysFromToday(-50),
      billingPeriodEnd: isoDaysFromToday(-20),
      issueDate: isoDaysFromToday(-50),
      dueDate: isoDaysFromToday(-40),
      amount: '1000.00',
    };
  }

  async function rawInsertSamePeriod(contractId: string): Promise<unknown> {
    try {
      await prisma.$executeRaw`
        INSERT INTO contract_invoices
          (id, contract_id, invoice_number, billing_period_start, billing_period_end,
           issue_date, due_date, amount, currency, status, updated_at)
        VALUES
          (gen_random_uuid(), ${contractId}::uuid,
           ${`CNL-RAW-${Math.floor(Math.random() * 1_000_000_000)}`},
           ${isoDaysFromToday(-50)}::date, ${isoDaysFromToday(-20)}::date,
           ${isoDaysFromToday(-50)}::date, ${isoDaysFromToday(-40)}::date,
           1000.00, 'TRY', 'DRAFT', now())
      `;
      return null;
    } catch (error) {
      return error;
    }
  }

  it('DRAFT fatura CANCELLED yapilir; ayni contract + ayni billingPeriodStart ile yeni fatura BASARILI olur', async () => {
    const contractId = await createActiveContract();
    const first = await invoiceService.create(opsActor, contractId, dto());

    // Ayni donem, non-CANCELLED dururken reddedilir.
    await expect(invoiceService.create(opsActor, contractId, dto())).rejects.toMatchObject({
      code: 'INVOICE_PERIOD_OVERLAP',
    });

    // Iptal + yeniden olusturma.
    await invoiceService.changeStatus(opsActor, first.id, { status: 'CANCELLED' });
    const recreated = await invoiceService.create(opsActor, contractId, dto());

    expect(recreated.id).not.toBe(first.id);
    expect(recreated.invoiceNumber).not.toBe(first.invoiceNumber);
    expect(recreated.billingPeriodStart.toISOString().slice(0, 10)).toBe(isoDaysFromToday(-50));

    // Yeniden olusturulan da non-CANCELLED oldugundan ucuncu kopya reddedilir.
    await expect(invoiceService.create(opsActor, contractId, dto())).rejects.toMatchObject({
      code: 'INVOICE_PERIOD_OVERLAP',
    });
  });

  it('dogrudan DB: non-CANCELLED cift ayni donem baslangici DB tarafindan reddedilir; CANCELLED sonrasi kabul edilir', async () => {
    const contractId = await createActiveContract();
    const first = await invoiceService.create(opsActor, contractId, dto());

    // App on-kontrolunu atlayan raw insert -> DB reddeder. Ayni cift hem
    // partial unique'i hem excl_invoice_period_overlap'i ihlal eder; gist
    // index once islendiginden gozlemlenen hata 23P01'dir (spike bulgusu) -
    // partial unique ayni CANCELLED-istisnasini paylasan ikinci savunma
    // hattidir, kullanici anlami ayni (INVOICE_PERIOD_OVERLAP).
    const dupError = await rawInsertSamePeriod(contractId);
    expect(dupError).not.toBeNull();
    expect(errUtil.isExclusionConstraintViolation(dupError, 'excl_invoice_period_overlap')).toBe(
      true,
    );

    // Fatura CANCELLED yapilinca ayni donem DB seviyesinde de acilir.
    await invoiceService.changeStatus(opsActor, first.id, { status: 'CANCELLED' });
    const okError = await rawInsertSamePeriod(contractId);
    expect(okError).toBeNull();

    const rows = await prisma.contractInvoice.findMany({ where: { contractId } });
    expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(['CANCELLED', 'DRAFT']);
  });

  it('partial unique index dogru tanimla mevcuttur; eski kosulsuz unique kaldirilmistir', async () => {
    const indexes = await prisma.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'contract_invoices'`;

    const names = indexes.map((i: { indexname: string }) => i.indexname);
    expect(names).toContain('uq_contract_invoices_period_start_open');
    expect(names).not.toContain('contract_invoices_contract_id_billing_period_start_key');

    const partial = indexes.find(
      (i: { indexname: string }) => i.indexname === 'uq_contract_invoices_period_start_open',
    );
    expect(partial?.indexdef).toContain('UNIQUE');
    expect(partial?.indexdef).toContain('contract_id');
    expect(partial?.indexdef).toContain('billing_period_start');
    expect(partial?.indexdef).toContain("<> 'CANCELLED'");
  });
});
