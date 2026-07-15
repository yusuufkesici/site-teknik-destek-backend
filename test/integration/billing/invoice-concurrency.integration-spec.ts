import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 12/20: fatura eszamanlilik + FOR SHARE trigger
// kilidi. Determinizm: bekleyen transaction'in gercekten bloke oldugu, zaman
// tahminli sleep'lerle DEGIL, pg_locks uzerinden (granted=false) sinirli-poll
// ile gozlemlenir; ancak blokaj dogrulandiktan sonra tutucu transaction
// commit edilir ve bekleyenin sonucu assert edilir. Test sonunda acik
// transaction/baglanti birakilmaz (gate her kosulda finally'de acilir).
describe('Invoice concurrency + FOR SHARE trigger kilidi (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoiceService: any;
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
    const { InvoiceService } = await import(
      '../../../src/modules/billing/services/invoice.service'
    );
    const { ContractService } = await import(
      '../../../src/modules/contracts/services/contract.service'
    );
    errUtil = await import('../../../src/common/utils/prisma-error.util');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    invoiceService = app.get(InvoiceService);
    contractService = app.get(ContractService);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557779001',
        firstName: 'Ops',
        lastName: 'InvConc',
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
      data: { type: 'SITE', name: `InvConc Site ${siteSeq}`, code: `IVC-${siteSeq}` },
    });
    const contract = await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `IVC-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-120)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(300)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
    return contract.id;
  }

  // Fesih penceresini (bugun+1) MUTLAKA asan gelecek donem.
  function futurePeriodDto() {
    return {
      billingPeriodStart: isoDaysFromToday(30),
      billingPeriodEnd: isoDaysFromToday(60),
      issueDate: isoDaysFromToday(0),
      dueDate: isoDaysFromToday(10),
      amount: '1000.00',
    };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Sinirli-poll: pg_locks'ta granted=false satir gorunene kadar (sleep'e
  // dayali kirilgan varsayim yerine kilit DURUMU gozlemlenir).
  async function waitForBlockedLock(timeoutMs = 20000): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const rows = await prisma.$queryRaw<
        { blocked: number }[]
      >`SELECT count(*)::int AS blocked FROM pg_locks WHERE NOT granted`;
      if (rows[0].blocked > 0) return;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Beklenen kilit blokaji gozlemlenemedi.');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function rawInsertInvoice(
    contractId: string,
    startIso: string,
    endIso: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any = prisma,
  ): Promise<void> {
    await client.$executeRaw`
      INSERT INTO contract_invoices
        (id, contract_id, invoice_number, billing_period_start, billing_period_end,
         issue_date, due_date, amount, currency, status, updated_at)
      VALUES
        (gen_random_uuid(), ${contractId}::uuid,
         ${`IVC-RAW-${Math.floor(Math.random() * 1_000_000_000)}`},
         ${startIso}::date, ${endIso}::date,
         ${startIso}::date, ${startIso}::date,
         1000.00, 'TRY', 'DRAFT', now())
    `;
  }

  it('(a) ayni donem icin iki paralel servis-yolu olusturma: biri basarili, digeri INVOICE_PERIOD_OVERLAP', async () => {
    const contractId = await createActiveContract();
    const dto = {
      billingPeriodStart: isoDaysFromToday(-50),
      billingPeriodEnd: isoDaysFromToday(-20),
      issueDate: isoDaysFromToday(-50),
      dueDate: isoDaysFromToday(-45),
      amount: '1000.00',
    };

    const results = await Promise.allSettled([
      invoiceService.create(opsActor, contractId, dto),
      invoiceService.create(opsActor, contractId, dto),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Ebeveyn contract FOR UPDATE kilidi istekleri serilestirir: ikinci
    // istek, birincinin commit'inden sonra on-kontrolde temiz domain hatasi
    // alir. CONCURRENT_MODIFICATION bu modulde yoktur.
    expect(rejected[0].reason).toMatchObject({ code: 'INVOICE_PERIOD_OVERLAP' });

    expect(await prisma.contractInvoice.count({ where: { contractId } })).toBe(1);
  });

  it('(b) fatura olusturma vs fesih yarisi: FOR UPDATE serilestirir, sonuc her iki sirada da tutarli', async () => {
    const contractId = await createActiveContract();

    const results = await Promise.allSettled([
      invoiceService.create(opsActor, contractId, futurePeriodDto()),
      contractService.update(opsActor, contractId, {
        status: 'TERMINATED',
        terminationReason: 'yaris testi',
      }),
    ]);

    const [createResult, terminateResult] = results;
    // Kilit hangi islemi once serilestirdiyse iki tutarli sonuctan biri
    // olusur; tutarsiz (ikisi de basarili) sonuc ASLA olusamaz.
    if (createResult.status === 'fulfilled') {
      expect(terminateResult.status).toBe('rejected');
      expect((terminateResult as PromiseRejectedResult).reason).toMatchObject({
        code: 'CONTRACT_TERMINATION_INVOICE_CONFLICT',
      });
    } else {
      expect(terminateResult.status).toBe('fulfilled');
      expect((createResult as PromiseRejectedResult).reason).toMatchObject({
        code: 'INVOICE_PERIOD_OUT_OF_CONTRACT',
      });
    }
  });

  it('(c) ayni faturaya iki paralel PAID istegi: biri basarili, digeri INVOICE_STATUS_UNCHANGED', async () => {
    const contractId = await createActiveContract();
    const invoice = await invoiceService.create(opsActor, contractId, {
      billingPeriodStart: isoDaysFromToday(-50),
      billingPeriodEnd: isoDaysFromToday(-20),
      issueDate: isoDaysFromToday(-50),
      dueDate: isoDaysFromToday(-45),
      amount: '1000.00',
    });
    await invoiceService.changeStatus(opsActor, invoice.id, { status: 'ISSUED' });

    const results = await Promise.allSettled([
      invoiceService.changeStatus(opsActor, invoice.id, {
        status: 'PAID',
        paymentMethod: 'CASH',
      }),
      invoiceService.changeStatus(opsActor, invoice.id, {
        status: 'PAID',
        paymentMethod: 'CASH',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Ikinci istek fatura satiri kilidinde bekledi, guncel PAID satirini
    // okudu -> mesru 409; yapay CONCURRENT_MODIFICATION yok.
    expect(rejected[0].reason).toMatchObject({ code: 'INVOICE_STATUS_UNCHANGED' });
  });

  it('FOR SHARE senaryo A: Tx1 raw invoice insert (trigger FOR SHARE tutar), Tx2 fesih BEKLER ve commit sonrasi tutarli reddedilir', async () => {
    const contractId = await createActiveContract();
    const insertDone = deferred();
    const gate = deferred();

    // Tx1: dogrudan-DB insert - trigger, parent contract satirinda FOR SHARE
    // alir ve transaction gate acilana kadar acik tutulur.
    const tx1 = prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tx: any) => {
        await rawInsertInvoice(contractId, isoDaysFromToday(30), isoDaysFromToday(60), tx);
        insertDone.resolve();
        await gate.promise;
      },
      { timeout: 60000, maxWait: 15000 },
    );

    let tx2Error: unknown = null;
    let tx2: Promise<unknown> = Promise.resolve();
    try {
      await insertDone.promise;

      // Tx2: contract'i feshetmeye calisir - UPDATE'in FOR NO KEY UPDATE
      // kilidi Tx1'in FOR SHARE'iyle CAKISIR ve bekler (FOR KEY SHARE olsaydi
      // bloklamazdi - duzeltmenin kaniti).
      tx2 = prisma.contract
        .update({
          where: { id: contractId },
          data: {
            status: 'TERMINATED',
            terminatedAt: new Date(),
            terminationReason: 'senaryo A feshi',
          },
        })
        .catch((error: unknown) => {
          tx2Error = error;
          return null;
        });

      // Blokaj kilit durumundan gozlemlenir (sleep tahmini degil).
      await waitForBlockedLock();
    } finally {
      gate.resolve();
    }

    // Tx1 commit oldu; Tx2 artik devam edebilir ve fesih trigger'i yeni
    // faturayi gorur -> tutarli, adlandirilmis red.
    await tx1;
    await tx2;

    expect(tx2Error).not.toBeNull();
    expect(
      errUtil.isRaisedConstraintViolation(tx2Error, 'chk_contract_termination_invoice_conflict'),
    ).toBe(true);

    // Tx1'in faturasi kalicidir; contract hala ACTIVE'tir.
    expect(await prisma.contractInvoice.count({ where: { contractId } })).toBe(1);
    const contractRow = await prisma.contract.findUnique({ where: { id: contractId } });
    expect(contractRow.status).toBe('ACTIVE');
  });

  it('FOR SHARE senaryo B: Tx1 fesih kilidini tutar, Tx2 raw insert BEKLER ve commit sonrasi guncel duruma gore reddedilir', async () => {
    const contractId = await createActiveContract();
    const lockDone = deferred();
    const gate = deferred();

    // Tx1: contract satirini FOR UPDATE ile kilitler ve TERMINATED'a ceker
    // (henuz commit etmez).
    const tx1 = prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE`;
        await tx.$executeRaw`
          UPDATE contracts
          SET status = 'TERMINATED', terminated_at = now(),
              termination_reason = 'senaryo B feshi'
          WHERE id = ${contractId}::uuid
        `;
        lockDone.resolve();
        await gate.promise;
      },
      { timeout: 60000, maxWait: 15000 },
    );

    let tx2Result: 'pending' | 'accepted' | unknown = 'pending';
    let tx2: Promise<unknown> = Promise.resolve();
    try {
      await lockDone.promise;

      // Tx2: dogrudan-DB insert - trigger'in FOR SHARE okumasi Tx1'in satir
      // kilidinde bekler.
      tx2 = rawInsertInvoice(contractId, isoDaysFromToday(30), isoDaysFromToday(60))
        .then(() => {
          tx2Result = 'accepted';
        })
        .catch((error: unknown) => {
          tx2Result = error;
        });

      await waitForBlockedLock();
    } finally {
      gate.resolve();
    }

    await tx1;
    await tx2;

    // Guncel (TERMINATED) duruma gore pencere bugun+1'e kucduldu; gelecek
    // donem insert'i adlandirilmis trigger hatasiyla reddedilir.
    expect(tx2Result).not.toBe('accepted');
    expect(
      errUtil.isRaisedConstraintViolation(tx2Result, 'chk_invoice_period_within_contract'),
    ).toBe(true);
    expect(await prisma.contractInvoice.count({ where: { contractId } })).toBe(0);
  });

  it('FOR SHARE senaryo B (kabul dali): fesih commit edildikten sonra pencere ICI donem kabul edilir', async () => {
    const contractId = await createActiveContract();
    const lockDone = deferred();
    const gate = deferred();

    const tx1 = prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE`;
        await tx.$executeRaw`
          UPDATE contracts
          SET status = 'TERMINATED', terminated_at = now(),
              termination_reason = 'senaryo B kabul dali'
          WHERE id = ${contractId}::uuid
        `;
        lockDone.resolve();
        await gate.promise;
      },
      { timeout: 60000, maxWait: 15000 },
    );

    let tx2Result: 'pending' | 'accepted' | unknown = 'pending';
    let tx2: Promise<unknown> = Promise.resolve();
    try {
      await lockDone.promise;
      // Tamamen gecmis (pencere ici) donem: fesih sonrasi bile gecerli.
      tx2 = rawInsertInvoice(contractId, isoDaysFromToday(-50), isoDaysFromToday(-20))
        .then(() => {
          tx2Result = 'accepted';
        })
        .catch((error: unknown) => {
          tx2Result = error;
        });
      await waitForBlockedLock();
    } finally {
      gate.resolve();
    }

    await tx1;
    await tx2;

    expect(tx2Result).toBe('accepted');
    expect(await prisma.contractInvoice.count({ where: { contractId } })).toBe(1);
  });
});
