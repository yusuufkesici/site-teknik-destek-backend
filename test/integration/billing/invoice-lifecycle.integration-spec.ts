import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 20: fatura mutlu yolu DRAFT -> ISSUED -> PAID
// (gercek CHECK/trigger'lara karsi), audit/outbox kayitlari ve atomiklik.
describe('Invoice lifecycle (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoiceService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outboxService: any;
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
    const { OutboxService } = await import('../../../src/infrastructure/events/outbox.service');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    invoiceService = app.get(InvoiceService);
    outboxService = app.get(OutboxService);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557775001',
        firstName: 'Ops',
        lastName: 'InvLife',
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
  async function createSiteWithActiveContract(): Promise<{ siteId: string; contractId: string }> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `InvLife Site ${siteSeq}`, code: `IVL-${siteSeq}` },
    });
    const contract = await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `IVL-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-60)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(300)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
    return { siteId: site.id, contractId: contract.id };
  }

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  function pastPeriodDto(startOffset = -50, endOffset = -20) {
    return {
      billingPeriodStart: isoDaysFromToday(startOffset),
      billingPeriodEnd: isoDaysFromToday(endOffset),
      issueDate: isoDaysFromToday(startOffset),
      dueDate: isoDaysFromToday(startOffset + 10),
      amount: '1250.75',
    };
  }

  it('tam yasam dongusu: DRAFT -> ISSUED -> PAID (BANK_TRANSFER)', async () => {
    const { siteId, contractId } = await createSiteWithActiveContract();

    // 1) Olusturma: DRAFT, sequence numarasi, currency contract snapshot'i.
    const created = await invoiceService.create(opsActor, contractId, pastPeriodDto());
    expect(created.status).toBe('DRAFT');
    expect(created.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(created.currency).toBe('TRY');
    expect(created.amount.toFixed(2)).toBe('1250.75');

    const createdAudit = await prisma.auditLog.findMany({
      where: { entityId: created.id, action: 'INVOICE_CREATED' },
    });
    expect(createdAudit.length).toBe(1);
    expect(createdAudit[0].siteId).toBe(siteId);
    expect(createdAudit[0].metadata.contractStatusAtCreation).toBe('ACTIVE');
    expect(
      (await prisma.outboxEvent.findMany({
        where: { aggregateId: created.id, eventType: 'InvoiceCreated' },
      })).length,
    ).toBe(1);

    // 2) ISSUED.
    const issued = await invoiceService.changeStatus(opsActor, created.id, { status: 'ISSUED' });
    expect(issued.status).toBe('ISSUED');
    expect(
      (await prisma.auditLog.findMany({
        where: { entityId: created.id, action: 'INVOICE_ISSUED' },
      })).length,
    ).toBe(1);

    // 3) PAID: paidAt server-set, referans degeri audit'e SIZMAZ.
    const paid = await invoiceService.changeStatus(opsActor, created.id, {
      status: 'PAID',
      paymentMethod: 'BANK_TRANSFER',
      referenceNumber: '  TR-2026-GIZLIREF  ',
    });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect(paid.referenceNumber).toBe('TR-2026-GIZLIREF');

    const paidAudit = await prisma.auditLog.findMany({
      where: { entityId: created.id, action: 'INVOICE_PAID' },
    });
    expect(paidAudit.length).toBe(1);
    expect(paidAudit[0].metadata.paymentMethod).toBe('BANK_TRANSFER');
    expect(paidAudit[0].metadata.hasReferenceNumber).toBe(true);
    expect(JSON.stringify(paidAudit[0].metadata)).not.toContain('GIZLIREF');

    const paidOutbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: created.id, eventType: 'InvoicePaid' },
    });
    expect(paidOutbox.length).toBe(1);
    expect(paidOutbox[0].payload.amount).toBe('1250.75');
    expect(JSON.stringify(paidOutbox[0].payload)).not.toContain('GIZLIREF');

    // 4) PAID terminaldir.
    await expect(
      invoiceService.changeStatus(opsActor, created.id, { status: 'CANCELLED' }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_STATUS_TRANSITION' });
  });

  it('CASH icin referans olmadan PAID; DB satirinda odeme alanlari tutarli (CHECK canli)', async () => {
    const { contractId } = await createSiteWithActiveContract();
    const created = await invoiceService.create(opsActor, contractId, pastPeriodDto());
    await invoiceService.changeStatus(opsActor, created.id, { status: 'ISSUED' });
    await invoiceService.changeStatus(opsActor, created.id, {
      status: 'PAID',
      paymentMethod: 'CASH',
    });

    const row = await prisma.contractInvoice.findUnique({ where: { id: created.id } });
    expect(row.status).toBe('PAID');
    expect(row.paidAt).not.toBeNull();
    expect(row.paymentMethod).toBe('CASH');
    expect(row.referenceNumber).toBeNull();
  });

  it('audit/outbox atomikligi: outbox yazimi patlarsa fatura + audit birlikte geri alinir', async () => {
    const { contractId } = await createSiteWithActiveContract();

    const spy = jest
      .spyOn(outboxService, 'publishInTx')
      .mockRejectedValueOnce(new Error('outbox patladi'));
    try {
      await expect(
        invoiceService.create(opsActor, contractId, pastPeriodDto()),
      ).rejects.toThrow('outbox patladi');
    } finally {
      spy.mockRestore();
    }

    expect(await prisma.contractInvoice.count({ where: { contractId } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'INVOICE_CREATED', metadata: { path: ['contractId'], equals: contractId } },
      }),
    ).toBe(0);
  });
});
