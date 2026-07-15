import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 4.5/20: fesih, pencereyi asan non-CANCELLED
// faturalari gecersizlestiremez.
// - App on-kontrol yolu: 409 CONTRACT_TERMINATION_INVOICE_CONFLICT.
// - Fatura iptal edildikten sonra fesih basarili olur (cancel-then-terminate).
// - PAID fatura penceyi asiyorsa fesih KALICI olarak bloklanir (PAID iptal
//   edilemez, refund sistemi Faz 7'de yok - bilincli sinir).
// - Dogrudan DB yolunda gercek trigger backstop'u (P0001, adlandirilmis).
describe('Contract termination - invoice conflict (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contractService: any;
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
    const { ContractService } = await import(
      '../../../src/modules/contracts/services/contract.service'
    );
    const { InvoiceService } = await import(
      '../../../src/modules/billing/services/invoice.service'
    );
    errUtil = await import('../../../src/common/utils/prisma-error.util');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    contractService = app.get(ContractService);
    invoiceService = app.get(InvoiceService);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557774001',
        firstName: 'Ops',
        lastName: 'Term',
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
      data: { type: 'SITE', name: `Term Site ${siteSeq}`, code: `TRM-${siteSeq}` },
    });
    return site.id;
  }

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  async function createActiveContract(siteId: string) {
    return prisma.contract.create({
      data: {
        siteId,
        contractNumber: `TRM-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-60)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(300)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
  }

  // Bugunun cok otesinde biten bir donem: fesih penceresi (bugun+1) bu
  // faturayi MUTLAKA asar -> cakisma garantili ve deterministik.
  function futureInvoiceDto() {
    return {
      billingPeriodStart: isoDaysFromToday(30),
      billingPeriodEnd: isoDaysFromToday(60),
      issueDate: isoDaysFromToday(0),
      dueDate: isoDaysFromToday(15),
      amount: '1000.00',
    };
  }

  it('gelecek donemli DRAFT fatura varken fesih reddedilir; fatura iptal edilince fesih basarili olur', async () => {
    const siteId = await createSite();
    const contract = await createActiveContract(siteId);
    const invoice = await invoiceService.create(opsActor, contract.id, futureInvoiceDto());

    await expect(
      contractService.update(opsActor, contract.id, {
        status: 'TERMINATED',
        terminationReason: 'erken fesih',
      }),
    ).rejects.toMatchObject({
      code: 'CONTRACT_TERMINATION_INVOICE_CONFLICT',
      meta: expect.objectContaining({ conflictingInvoices: 1 }),
    });

    // Fesih reddedildi: sozlesme hala ACTIVE, terminatedAt/reason NULL.
    let row = await prisma.contract.findUnique({ where: { id: contract.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.terminatedAt).toBeNull();
    expect(row.terminationReason).toBeNull();

    // Kullanici once faturayi iptal eder, sonra fesih basarili olur.
    await invoiceService.changeStatus(opsActor, invoice.id, { status: 'CANCELLED' });
    const terminated = await contractService.update(opsActor, contract.id, {
      status: 'TERMINATED',
      terminationReason: 'erken fesih',
    });
    expect(terminated.status).toBe('TERMINATED');

    row = await prisma.contract.findUnique({ where: { id: contract.id } });
    expect(row.terminatedAt).not.toBeNull();
    expect(row.terminationReason).toBe('erken fesih');
  });

  it('ISSUED fatura da cakisma sayilir; PAID fatura fesihi KALICI bloklar (PAID iptal edilemez)', async () => {
    const siteId = await createSite();
    const contract = await createActiveContract(siteId);
    const invoice = await invoiceService.create(opsActor, contract.id, futureInvoiceDto());

    // ISSUED da non-CANCELLED oldugundan cakisir.
    await invoiceService.changeStatus(opsActor, invoice.id, { status: 'ISSUED' });
    await expect(
      contractService.update(opsActor, contract.id, {
        status: 'TERMINATED',
        terminationReason: 'fesih',
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_TERMINATION_INVOICE_CONFLICT' });

    // PAID edilirse fesih hala bloklu ve PAID artik iptal EDILEMEZ (terminal).
    await invoiceService.changeStatus(opsActor, invoice.id, {
      status: 'PAID',
      paymentMethod: 'CASH',
    });
    await expect(
      contractService.update(opsActor, contract.id, {
        status: 'TERMINATED',
        terminationReason: 'fesih',
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_TERMINATION_INVOICE_CONFLICT' });
    await expect(
      invoiceService.changeStatus(opsActor, invoice.id, { status: 'CANCELLED' }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_STATUS_TRANSITION' });
    // Bilincli Faz 7 siniri: refund/duzeltme sistemi olmadigi icin bu
    // sozlesme bu haliyle terminate edilemez - veri sessizce tutarsizlasmaz.
  });

  it('dogrudan DB yolunda gercek trigger backstop calisir (P0001, adlandirilmis)', async () => {
    const siteId = await createSite();
    const contract = await createActiveContract(siteId);
    await invoiceService.create(opsActor, contract.id, futureInvoiceDto());

    // App on-kontrolunu atlayan dogrudan UPDATE (raw degil ama service-disi).
    let dbError: unknown = null;
    try {
      await prisma.contract.update({
        where: { id: contract.id },
        data: {
          status: 'TERMINATED',
          terminatedAt: new Date(),
          terminationReason: 'dogrudan fesih',
        },
      });
    } catch (error) {
      dbError = error;
    }

    expect(dbError).not.toBeNull();
    expect(
      errUtil.isRaisedConstraintViolation(dbError, 'chk_contract_termination_invoice_conflict'),
    ).toBe(true);

    const row = await prisma.contract.findUnique({ where: { id: contract.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('pencere icinde kalan (gecmis) faturalar fesihi engellemez', async () => {
    const siteId = await createSite();
    const contract = await createActiveContract(siteId);
    // Tamamen gecmiste kalan donem: bitisi bugunden once -> pencere icinde.
    await invoiceService.create(opsActor, contract.id, {
      billingPeriodStart: isoDaysFromToday(-50),
      billingPeriodEnd: isoDaysFromToday(-20),
      issueDate: isoDaysFromToday(-50),
      dueDate: isoDaysFromToday(-35),
      amount: '1000.00',
    });

    const terminated = await contractService.update(opsActor, contract.id, {
      status: 'TERMINATED',
      terminationReason: 'normal fesih',
    });
    expect(terminated.status).toBe('TERMINATED');
  });
});
