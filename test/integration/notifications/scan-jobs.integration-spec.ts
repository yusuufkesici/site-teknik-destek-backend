import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan docs/phase-8-plan.md Bolum 5.3/7/9: iki tarama job'unun
// (InvoiceOverdueScanJob, ContractExpiringScanJob) advisory lock KULLANMAYAN,
// idempotent-by-construction davranisi (kilitsiz aday secimi + her aday icin
// ayri findByIdForUpdate row-lock + transaction-ici yeniden dogrulama), UTC
// tarih siniri ve bildirim alicisi site izolasyonu - bu ucu de gercek
// PostgreSQL satir kilitlenmesine/transaction izolasyonuna dayandigindan
// mock'la test edilemez.
describe('InvoiceOverdueScanJob / ContractExpiringScanJob (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoiceOverdueScanJob: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contractExpiringScanJob: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoiceService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let notificationDispatcher: any;
  let opsActor: { id: string; role: 'OPERATIONS'; sessionId: string; tokenVersion: number };

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { InvoiceOverdueScanJob } = await import(
      '../../../src/modules/billing/jobs/invoice-overdue-scan.job'
    );
    const { ContractExpiringScanJob } = await import(
      '../../../src/modules/contracts/jobs/contract-expiring-scan.job'
    );
    const { InvoiceService } = await import(
      '../../../src/modules/billing/services/invoice.service'
    );
    const { NotificationDispatcher } = await import(
      '../../../src/modules/notifications/notification-dispatcher.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    invoiceOverdueScanJob = app.get(InvoiceOverdueScanJob);
    contractExpiringScanJob = app.get(ContractExpiringScanJob);
    invoiceService = app.get(InvoiceService);
    notificationDispatcher = app.get(NotificationDispatcher);

    const ops = await prisma.user.create({
      data: {
        phoneNumber: '+905557779001',
        firstName: 'Ops',
        lastName: 'ScanJobs',
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
  async function createSite(prefix: string): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `${prefix} Site ${siteSeq}`, code: `SJ-${prefix}-${siteSeq}` },
    });
    return site.id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function createActiveContract(siteId: string, endOffsetDays: number): Promise<any> {
    return prisma.contract.create({
      data: {
        siteId,
        contractNumber: `SJ-CN-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-300)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(endOffsetDays)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsActor.id,
      },
    });
  }

  async function createIssuedInvoice(contractId: string, dueOffsetDays: number): Promise<string> {
    const created = await invoiceService.create(opsActor, contractId, {
      billingPeriodStart: isoDaysFromToday(-60),
      billingPeriodEnd: isoDaysFromToday(-30),
      issueDate: isoDaysFromToday(-60),
      dueDate: isoDaysFromToday(dueOffsetDays),
      amount: '1250.00',
    });
    await invoiceService.changeStatus(opsActor, created.id, { status: 'ISSUED' });
    return created.id;
  }

  describe('InvoiceOverdueScanJob', () => {
    it('gecmis vadeli ISSUED fatura OVERDUE olur, audit+outbox uretilir', async () => {
      const siteId = await createSite('IOD1');
      const contract = await createActiveContract(siteId, 300);
      const invoiceId = await createIssuedInvoice(contract.id, -1); // dun vadesi gecti

      await invoiceOverdueScanJob.runOnce();

      const row = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('OVERDUE');

      const audit = await prisma.auditLog.findMany({
        where: { entityId: invoiceId, action: 'INVOICE_OVERDUE' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].siteId).toBe(siteId);

      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: invoiceId, eventType: 'InvoiceOverdue' },
      });
      expect(outbox).toHaveLength(1);
    });

    it('dueDate bugunse (UTC gun siniri): henuz vadesi gecmemistir, job dokunmaz', async () => {
      const siteId = await createSite('IOD2');
      const contract = await createActiveContract(siteId, 300);
      const invoiceId = await createIssuedInvoice(contract.id, 0); // bugun

      await invoiceOverdueScanJob.runOnce();

      const row = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('ISSUED');
    });

    it('PAID faturaya dokunmaz', async () => {
      const siteId = await createSite('IOD3');
      const contract = await createActiveContract(siteId, 300);
      const invoiceId = await createIssuedInvoice(contract.id, -5);
      await invoiceService.changeStatus(opsActor, invoiceId, {
        status: 'PAID',
        paymentMethod: 'CASH',
      });

      await invoiceOverdueScanJob.runOnce();

      const row = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('PAID');
      const audit = await prisma.auditLog.findMany({
        where: { entityId: invoiceId, action: 'INVOICE_OVERDUE' },
      });
      expect(audit).toHaveLength(0);
    });

    it('CANCELLED faturaya dokunmaz', async () => {
      const siteId = await createSite('IOD4');
      const contract = await createActiveContract(siteId, 300);
      const invoiceId = await createIssuedInvoice(contract.id, -5);
      await invoiceService.changeStatus(opsActor, invoiceId, { status: 'CANCELLED' });

      await invoiceOverdueScanJob.runOnce();

      const row = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('CANCELLED');
    });

    it('iki eszamanli runOnce() cagrisi ayni faturayi CIFT islemez (tek OVERDUE gecisi, tek audit/outbox)', async () => {
      const siteId = await createSite('IOD5');
      const contract = await createActiveContract(siteId, 300);
      const invoiceId = await createIssuedInvoice(contract.id, -1);

      await Promise.all([invoiceOverdueScanJob.runOnce(), invoiceOverdueScanJob.runOnce()]);

      const row = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } });
      expect(row.status).toBe('OVERDUE');
      const audit = await prisma.auditLog.findMany({
        where: { entityId: invoiceId, action: 'INVOICE_OVERDUE' },
      });
      expect(audit).toHaveLength(1);
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: invoiceId, eventType: 'InvoiceOverdue' },
      });
      expect(outbox).toHaveLength(1);
    });
  });

  describe('ContractExpiringScanJob', () => {
    it('lead-day penceresi icindeki ACTIVE sozlesme bildirilir: expiryNotifiedAt set edilir, audit+outbox uretilir', async () => {
      const siteId = await createSite('CES1');
      const contract = await createActiveContract(siteId, 10); // 10 gun sonra bitiyor, varsayilan lead=30

      await contractExpiringScanJob.runOnce();

      const row = await prisma.contract.findUnique({ where: { id: contract.id } });
      expect(row.expiryNotifiedAt).not.toBeNull();

      const audit = await prisma.auditLog.findMany({
        where: { entityId: contract.id, action: 'CONTRACT_EXPIRING_NOTIFIED' },
      });
      expect(audit).toHaveLength(1);
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: contract.id, eventType: 'ContractExpiring' },
      });
      expect(outbox).toHaveLength(1);
    });

    it('pencere disindaki (60 gun sonra biten, varsayilan lead=30 disi) sozlesme dokunulmaz', async () => {
      const siteId = await createSite('CES2');
      const contract = await createActiveContract(siteId, 60);

      await contractExpiringScanJob.runOnce();

      const row = await prisma.contract.findUnique({ where: { id: contract.id } });
      expect(row.expiryNotifiedAt).toBeNull();
    });

    it('iki eszamanli runOnce() cagrisi ayni sozlesmeyi CIFT islemez', async () => {
      const siteId = await createSite('CES3');
      const contract = await createActiveContract(siteId, 5);

      await Promise.all([contractExpiringScanJob.runOnce(), contractExpiringScanJob.runOnce()]);

      const audit = await prisma.auditLog.findMany({
        where: { entityId: contract.id, action: 'CONTRACT_EXPIRING_NOTIFIED' },
      });
      expect(audit).toHaveLength(1);
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: contract.id, eventType: 'ContractExpiring' },
      });
      expect(outbox).toHaveLength(1);
    });
  });

  describe('Bildirim alicisi site izolasyonu (gercek PostgreSQL)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function createManager(siteId: string, phone: string): Promise<any> {
      const user = await prisma.user.create({
        data: { phoneNumber: phone, firstName: 'Mgr', lastName: 'Site', role: 'RESIDENT' },
      });
      await prisma.siteMembership.create({
        data: { userId: user.id, siteId, membershipRole: 'MANAGER', isActive: true },
      });
      return user;
    }

    it("ContractExpiring: yalniz ilgili sitenin MANAGER'i alici olur, baska sitenin yoneticisi HARIC tutulur", async () => {
      const siteA = await createSite('ISO-A1');
      const siteB = await createSite('ISO-B1');
      const managerA = await createManager(siteA, '+905557001001');
      await createManager(siteB, '+905557001002');
      const contractA = await createActiveContract(siteA, 5);

      await contractExpiringScanJob.runOnce();
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: contractA.id, eventType: 'ContractExpiring' },
      });
      await notificationDispatcher.fanOut(event);

      const deliveries = await prisma.notificationDelivery.findMany({
        where: { sourceEventId: event.id },
      });
      const phones = deliveries.map((d: { recipientPhone: string }) => d.recipientPhone);
      expect(phones).toContain(managerA.phoneNumber);
      expect(phones).not.toContain('+905557001002');
    });

    it("InvoiceOverdue: yalniz ilgili sitenin MANAGER'i alici olur, baska sitenin yoneticisi HARIC tutulur", async () => {
      const siteA = await createSite('ISO-A2');
      const siteB = await createSite('ISO-B2');
      const managerA = await createManager(siteA, '+905557002001');
      await createManager(siteB, '+905557002002');
      const contractA = await createActiveContract(siteA, 300);
      const invoiceId = await createIssuedInvoice(contractA.id, -1);

      await invoiceOverdueScanJob.runOnce();
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: invoiceId, eventType: 'InvoiceOverdue' },
      });
      await notificationDispatcher.fanOut(event);

      const deliveries = await prisma.notificationDelivery.findMany({
        where: { sourceEventId: event.id },
      });
      const phones = deliveries.map((d: { recipientPhone: string }) => d.recipientPhone);
      expect(phones).toContain(managerA.phoneNumber);
      expect(phones).not.toContain('+905557002002');
    });
  });
});
