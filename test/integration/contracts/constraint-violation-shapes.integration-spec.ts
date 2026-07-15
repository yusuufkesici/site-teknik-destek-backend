import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 12/20: ILK yazilan integration dosyasi (spike).
// Servis catch-blocklari yazilmadan ONCE gercek PostgreSQL 16 + Prisma 7 +
// @prisma/adapter-pg hata sekilleri bu dosyayla dogrulanmistir:
// - 23P01 (EXCLUDE) / 23514 (CHECK) / P0001 (RAISE) -> 'DriverAdapterError'
//   (cause: { kind:'postgres', code, message, ... }); yapisal constraint alani
//   YOK - ad, PG'nin sabit mesaj formatindan (23P01/23514) veya migration'in
//   RAISE mesajindaki 'constraint_adi: ...' on ekinden (P0001) cikarilir.
// - 23505 -> PrismaClientKnownRequestError P2002; ad/alanlar
//   meta.driverAdapterError.cause.constraint icindedir (meta.target YOK).
// Bu testler prisma-error.util.ts yardimcilarinin gercek DB hatalarini dogru
// tanidigini surekli kanitlar (regresyon bekcisi).

describe('Faz 7 - constraint/trigger hata sekilleri (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errUtil: any;
  let opsUserId: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../../../src/generated/prisma-client/client');
    errUtil = await import('../../../src/common/utils/prisma-error.util');
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDb.databaseUrl }),
    });

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557770001',
        firstName: 'Ops',
        lastName: 'Spike',
        role: 'OPERATIONS',
      },
    });
    opsUserId = ops.id;
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
    await stopTestDatabase(testDb);
  });

  let siteSeq = 0;
  async function createSite(): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Spike Site ${siteSeq}`, code: `SPK-${siteSeq}` },
    });
    return site.id;
  }

  async function createContract(
    siteId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    return prisma.contract.create({
      data: {
        siteId,
        contractNumber: `SPK-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsUserId,
        ...overrides,
      },
    });
  }

  function invoiceData(contractId: string, overrides: Record<string, unknown> = {}) {
    return {
      contractId,
      invoiceNumber: `SPK-INV-${Math.floor(Math.random() * 1_000_000_000)}`,
      billingPeriodStart: new Date('2026-01-01'),
      billingPeriodEnd: new Date('2026-02-01'),
      issueDate: new Date('2026-01-01'),
      dueDate: new Date('2026-01-15'),
      amount: '1000.00',
      currency: 'TRY',
      ...overrides,
    };
  }

  async function captureError(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  }

  it('excl_contracts_active_overlap ihlali 23P01 olarak taninir, constraint adi cikarilir', async () => {
    const siteId = await createSite();
    await createContract(siteId);
    const draft = await createContract(siteId, {
      status: 'DRAFT',
      startDate: new Date('2026-06-01'),
      endDate: new Date('2027-06-01'),
    });

    const error = await captureError(
      prisma.contract.update({ where: { id: draft.id }, data: { status: 'ACTIVE' } }),
    );

    expect(error).not.toBeNull();
    expect(errUtil.isExclusionConstraintViolation(error)).toBe(true);
    expect(errUtil.isExclusionConstraintViolation(error, 'excl_contracts_active_overlap')).toBe(
      true,
    );
    expect(errUtil.isExclusionConstraintViolation(error, 'excl_invoice_period_overlap')).toBe(
      false,
    );
    expect(errUtil.getConstraintName(error)).toBe('excl_contracts_active_overlap');
    expect(errUtil.isCheckConstraintViolation(error)).toBe(false);
    expect(errUtil.isRaisedConstraintViolation(error)).toBe(false);
  });

  it('ayni donem baslangicli iki non-CANCELLED fatura DB tarafindan reddedilir (exclusion once atesler)', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);
    await prisma.contractInvoice.create({ data: invoiceData(contract.id) });

    const error = await captureError(
      prisma.contractInvoice.create({ data: invoiceData(contract.id) }),
    );

    // Gozlemlenen davranis: ayni (contract_id, billing_period_start) cifti hem
    // excl_invoice_period_overlap'i hem partial unique'i ihlal eder; gist
    // index (daha eski OID) once islendigi icin DB her zaman 23P01 uretir.
    // Iki yol da ayni domain hatasina (INVOICE_PERIOD_OVERLAP) eslenir.
    expect(error).not.toBeNull();
    expect(errUtil.isExclusionConstraintViolation(error, 'excl_invoice_period_overlap')).toBe(
      true,
    );
  });

  it('contract_number unique ihlali P2002 olarak gelir; hedef alanlar cikarilir', async () => {
    const siteId = await createSite();
    await createContract(siteId, { contractNumber: 'SPK-DUP-01', status: 'DRAFT' });
    const error = await captureError(
      createContract(siteId, { contractNumber: 'SPK-DUP-01', status: 'DRAFT' }),
    );

    expect(error).not.toBeNull();
    expect(errUtil.isUniqueConstraintViolation(error)).toBe(true);
    expect(errUtil.getUniqueConstraintTarget(error)).toEqual(['contract_number']);
  });

  it('chk_invoice_due_after_issue CHECK ihlali 23514 olarak taninir', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);

    const error = await captureError(
      prisma.contractInvoice.create({
        data: invoiceData(contract.id, {
          billingPeriodStart: new Date('2026-03-01'),
          billingPeriodEnd: new Date('2026-04-01'),
          issueDate: new Date('2026-03-10'),
          dueDate: new Date('2026-03-01'),
        }),
      }),
    );

    expect(error).not.toBeNull();
    expect(errUtil.isCheckConstraintViolation(error, 'chk_invoice_due_after_issue')).toBe(true);
    expect(errUtil.getConstraintName(error)).toBe('chk_invoice_due_after_issue');
    expect(errUtil.isExclusionConstraintViolation(error)).toBe(false);
  });

  it('trigger P0001 chk_invoice_period_within_contract taninir', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);

    const error = await captureError(
      prisma.contractInvoice.create({
        data: invoiceData(contract.id, {
          billingPeriodStart: new Date('2026-12-01'),
          billingPeriodEnd: new Date('2027-02-01'),
          issueDate: new Date('2026-12-01'),
          dueDate: new Date('2026-12-15'),
        }),
      }),
    );

    expect(error).not.toBeNull();
    expect(
      errUtil.isRaisedConstraintViolation(error, 'chk_invoice_period_within_contract'),
    ).toBe(true);
    expect(errUtil.getConstraintName(error)).toBe('chk_invoice_period_within_contract');
  });

  it('trigger P0001 chk_invoice_contract_not_billable taninir (DRAFT contract)', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId, { status: 'DRAFT' });

    const error = await captureError(
      prisma.contractInvoice.create({ data: invoiceData(contract.id) }),
    );

    expect(error).not.toBeNull();
    expect(
      errUtil.isRaisedConstraintViolation(error, 'chk_invoice_contract_not_billable'),
    ).toBe(true);
  });

  it('trigger P0001 chk_invoice_currency_match taninir (dogrudan DB currency uyusmazligi)', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);

    const error = await captureError(
      prisma.contractInvoice.create({
        data: invoiceData(contract.id, {
          billingPeriodStart: new Date('2026-05-01'),
          billingPeriodEnd: new Date('2026-06-01'),
          issueDate: new Date('2026-05-01'),
          dueDate: new Date('2026-05-15'),
          currency: 'USD',
        }),
      }),
    );

    expect(error).not.toBeNull();
    expect(errUtil.isRaisedConstraintViolation(error, 'chk_invoice_currency_match')).toBe(true);
  });

  it('trigger P0001 chk_invoice_contract_exists taninir (FK kontrolunden once calisir)', async () => {
    const error = await captureError(
      prisma.contractInvoice.create({
        data: invoiceData('00000000-0000-0000-0000-000000000001'),
      }),
    );

    expect(error).not.toBeNull();
    expect(errUtil.isRaisedConstraintViolation(error, 'chk_invoice_contract_exists')).toBe(true);
  });

  it('trigger P0001 chk_contract_termination_invoice_conflict taninir', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);
    await prisma.contractInvoice.create({
      data: invoiceData(contract.id, {
        billingPeriodStart: new Date('2026-11-01'),
        billingPeriodEnd: new Date('2026-12-01'),
        issueDate: new Date('2026-11-01'),
        dueDate: new Date('2026-11-15'),
      }),
    });

    const error = await captureError(
      prisma.contract.update({
        where: { id: contract.id },
        data: {
          status: 'TERMINATED',
          terminatedAt: new Date('2026-06-15T10:00:00Z'),
          terminationReason: 'spike testi',
        },
      }),
    );

    expect(error).not.toBeNull();
    expect(
      errUtil.isRaisedConstraintViolation(error, 'chk_contract_termination_invoice_conflict'),
    ).toBe(true);
  });

  it('chk_invoice_payment_consistency CHECK ihlali taninir (PAID + eksik odeme alanlari)', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);
    const invoice = await prisma.contractInvoice.create({
      data: invoiceData(contract.id, {
        billingPeriodStart: new Date('2026-07-01'),
        billingPeriodEnd: new Date('2026-08-01'),
        issueDate: new Date('2026-07-01'),
        dueDate: new Date('2026-07-15'),
        status: 'ISSUED',
      }),
    });

    const error = await captureError(
      prisma.contractInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID' } }),
    );

    expect(error).not.toBeNull();
    expect(errUtil.isCheckConstraintViolation(error, 'chk_invoice_payment_consistency')).toBe(
      true,
    );
  });

  it('chk_contract_termination_consistency CHECK ihlali taninir (TERMINATED + eksik alanlar)', async () => {
    const siteId = await createSite();
    const contract = await createContract(siteId);

    const error = await captureError(
      prisma.contract.update({ where: { id: contract.id }, data: { status: 'TERMINATED' } }),
    );

    expect(error).not.toBeNull();
    expect(
      errUtil.isCheckConstraintViolation(error, 'chk_contract_termination_consistency'),
    ).toBe(true);
  });

  it('yardimcilar Prisma/PG disi hatalarda false doner', async () => {
    const plain = new Error('siradan hata');
    expect(errUtil.isExclusionConstraintViolation(plain)).toBe(false);
    expect(errUtil.isCheckConstraintViolation(plain)).toBe(false);
    expect(errUtil.isRaisedConstraintViolation(plain)).toBe(false);
    expect(errUtil.getConstraintName(plain)).toBeUndefined();
    expect(errUtil.getUniqueConstraintTarget(plain)).toBeUndefined();
    expect(errUtil.getConstraintName(null)).toBeUndefined();
    expect(errUtil.isExclusionConstraintViolation(undefined)).toBe(false);
  });
});
