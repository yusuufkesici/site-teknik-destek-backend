import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

// Onaylanan Faz 7 plani Bolum 21: fatura E2E - server-copied currency,
// bilinmeyen currency alani 422 (forbidNonWhitelisted dogrulandi), billability
// reddi, TERMINATED LEAST siniri, odeme kurallari, manuel OVERDUE reddi,
// cancel+recreate, fesih-fatura cakismasi, pagination/filtre, tenant/IDOR.
describe('Billing E2E (tam uygulama + Testcontainers)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let smsProvider: CapturingSmsProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 120000);

  afterAll(async () => {
    await stopTestDatabase(testDb);
  });

  beforeEach(async () => {
    const { AppModule } = await import('../../src/app.module');
    const { PrismaService } = await import(
      '../../src/infrastructure/database/prisma/prisma.service'
    );
    const { SMS_PROVIDER } = await import('../../src/infrastructure/sms/sms-provider.interface');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useClass(CapturingSmsProvider)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    smsProvider = app.get(SMS_PROVIDER);
    server = app.getHttpServer();
  }, 60000);

  afterEach(async () => {
    await app.close();
  });

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  async function loginViaOtp(phone: string): Promise<string> {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: phone })
      .expect(HttpStatus.OK);
    const code = smsProvider.getLastCode(phone);
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: phone, code })
      .expect(HttpStatus.OK);
    return res.body.accessToken as string;
  }

  async function createOperationsAndLogin(phone: string): Promise<string> {
    await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Ops', lastName: 'BillE2E', role: 'OPERATIONS' },
    });
    return loginViaOtp(phone);
  }

  async function createSiteManagerAndLogin(phone: string, siteId: string): Promise<string> {
    const user = await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Site', lastName: 'Mgr', role: 'SITE_MANAGER' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'MANAGER', isActive: true },
    });
    return loginViaOtp(phone);
  }

  async function createRoleUserAndLogin(
    phone: string,
    role: 'RESIDENT' | 'TECHNICIAN',
    siteId?: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Rol', lastName: role, role },
    });
    if (role === 'RESIDENT' && siteId) {
      await prisma.siteMembership.create({
        data: { userId: user.id, siteId, membershipRole: 'RESIDENT', isActive: true },
      });
    }
    return loginViaOtp(phone);
  }

  async function createSite(opsToken: string, name: string, code: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name, code })
      .expect(HttpStatus.CREATED);
    return res.body.id as string;
  }

  async function seedContract(
    siteId: string,
    opsPhone: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const ops = await prisma.user.findUnique({ where: { phoneNumber: opsPhone } });
    const contract = await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `E2E-BIL-${Math.floor(Math.random() * 1_000_000_000)}`,
        startDate: new Date(`${isoDaysFromToday(-120)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(120)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: ops.id,
        ...overrides,
      },
    });
    return contract.id as string;
  }

  function invoiceDto(startOffset: number, endOffset: number) {
    return {
      billingPeriodStart: isoDaysFromToday(startOffset),
      billingPeriodEnd: isoDaysFromToday(endOffset),
      issueDate: isoDaysFromToday(startOffset),
      dueDate: isoDaysFromToday(startOffset + 5),
      amount: '1000.00',
    };
  }

  function expectErrorEnvelope(body: Record<string, unknown>, code: string): void {
    expect(body.success).toBe(false);
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe(code);
    expect(typeof error.message).toBe('string');
    expect(typeof error.requestId).toBe('string');
    expect(typeof error.timestamp).toBe('string');
  }

  it('fatura olusturma kurallari: server-copied currency, bilinmeyen currency 422, donem/vade/billability', async () => {
    const opsToken = await createOperationsAndLogin('+905558882001');
    const siteA = await createSite(opsToken, 'Bill Site A', 'E2E-BIL-A');
    // USD sozlesme: response currency'sinin contract'tan geldigini kanitlar.
    const usdContract = await seedContract(siteA, '+905558882001', { currency: 'USD' });

    // Bilinmeyen currency alani govdede -> KESIN 422 VALIDATION_ERROR
    // (dogrulanmis global forbidNonWhitelisted=true; sessizce yok sayilmaz).
    const currencyRes = await request(server)
      .post(`/api/v1/contracts/${usdContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ ...invoiceDto(-50, -20), currency: 'EUR' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(currencyRes.body, 'VALIDATION_ERROR');

    // Gecerli olusturma: currency contract snapshot'i (USD), DRAFT, INV- numara.
    const created = await request(server)
      .post(`/api/v1/contracts/${usdContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-50, -20))
      .expect(HttpStatus.CREATED);
    expect(created.body.currency).toBe('USD');
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(created.body.amount).toBe('1000.00');
    expect(created.body.billingPeriodStart).toBe(isoDaysFromToday(-50));

    // Gecersiz donem -> 422.
    const badPeriod = await request(server)
      .post(`/api/v1/contracts/${usdContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ ...invoiceDto(-10, -10) })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(badPeriod.body, 'INVOICE_INVALID_PERIOD');

    // dueDate < issueDate -> 422.
    const badDue = await request(server)
      .post(`/api/v1/contracts/${usdContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ ...invoiceDto(-10, -5), dueDate: isoDaysFromToday(-15) })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(badDue.body, 'INVOICE_INVALID_DUE_DATE');

    // Donem sozlesme penceresi disinda (endDate+2) -> 422.
    const outOfWindow = await request(server)
      .post(`/api/v1/contracts/${usdContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(100, 122))
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(outOfWindow.body, 'INVOICE_PERIOD_OUT_OF_CONTRACT');

    // Ayni donemle cakisan ikinci fatura -> 409.
    const overlap = await request(server)
      .post(`/api/v1/contracts/${usdContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-40, -10))
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(overlap.body, 'INVOICE_PERIOD_OVERLAP');

    // DRAFT/SUSPENDED sozlesme faturalanamaz -> 422.
    const siteB = await createSite(opsToken, 'Bill Site B', 'E2E-BIL-B');
    const draftContract = await seedContract(siteB, '+905558882001', { status: 'DRAFT' });
    const draftReject = await request(server)
      .post(`/api/v1/contracts/${draftContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-50, -20))
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(draftReject.body, 'INVOICE_CONTRACT_NOT_BILLABLE');

    const siteBSuspended = await createSite(opsToken, 'Bill Site B2', 'E2E-BIL-B2');
    const suspendedContract = await seedContract(siteBSuspended, '+905558882001', {
      status: 'SUSPENDED',
    });
    const suspendedReject = await request(server)
      .post(`/api/v1/contracts/${suspendedContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-50, -20))
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(suspendedReject.body, 'INVOICE_CONTRACT_NOT_BILLABLE');

    // EXPIRED gecmise donuk fatura -> 201.
    const siteC = await createSite(opsToken, 'Bill Site C', 'E2E-BIL-C');
    const expiredContract = await seedContract(siteC, '+905558882001', {
      startDate: new Date(`${isoDaysFromToday(-200)}T00:00:00Z`),
      endDate: new Date(`${isoDaysFromToday(-1)}T00:00:00Z`),
      status: 'EXPIRED',
    });
    await request(server)
      .post(`/api/v1/contracts/${expiredContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-60, -30))
      .expect(HttpStatus.CREATED);

    // TERMINATED LEAST siniri: 30 gun once feshedilmis sozlesme; pencere
    // terminatedAt gunu + 1'de biter -> tam sinir 201, oteси 422.
    const siteD = await createSite(opsToken, 'Bill Site D', 'E2E-BIL-D');
    const terminatedContract = await seedContract(siteD, '+905558882001', {
      status: 'TERMINATED',
      terminatedAt: new Date(`${isoDaysFromToday(-30)}T12:00:00Z`),
      terminationReason: 'e2e fesih',
    });
    await request(server)
      .post(`/api/v1/contracts/${terminatedContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-60, -29))
      .expect(HttpStatus.CREATED);
    const beyondTermination = await request(server)
      .post(`/api/v1/contracts/${terminatedContract}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-90, -28))
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(beyondTermination.body, 'INVOICE_PERIOD_OUT_OF_CONTRACT');
  }, 180000);

  it('fatura durum gecisleri: ISSUED/PAID kurallari, manuel OVERDUE reddi, cancel+recreate', async () => {
    const opsToken = await createOperationsAndLogin('+905558883001');
    const siteA = await createSite(opsToken, 'Bill Site S', 'E2E-BIL-S');
    const contractId = await seedContract(siteA, '+905558883001');

    const created = await request(server)
      .post(`/api/v1/contracts/${contractId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-50, -20))
      .expect(HttpStatus.CREATED);
    const invoiceId = created.body.id as string;

    // PAID disi hedefle odeme alani gonderilirse -> 422 VALIDATION_ERROR.
    const paymentWithIssued = await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ISSUED', paymentMethod: 'CASH' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(paymentWithIssued.body, 'VALIDATION_ERROR');

    // paidAt DTO'da yoktur; gonderilirse forbidNonWhitelisted 422 uretir.
    await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'PAID', paymentMethod: 'CASH', paidAt: new Date().toISOString() })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);

    // DRAFT -> PAID dogrudan gecis yok.
    const draftToPaid = await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'PAID', paymentMethod: 'CASH' })
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(draftToPaid.body, 'INVOICE_INVALID_STATUS_TRANSITION');

    // ISSUED.
    await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ISSUED' })
      .expect(HttpStatus.OK);

    // Manuel OVERDUE Faz 7'de reddedilir.
    const overdueRes = await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'OVERDUE' })
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(overdueRes.body, 'INVOICE_INVALID_STATUS_TRANSITION');

    // BANK_TRANSFER referans zorunlu -> 422; CASH referanssiz -> 200.
    const bankNoRef = await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'PAID', paymentMethod: 'BANK_TRANSFER' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(bankNoRef.body, 'INVOICE_PAYMENT_DETAILS_REQUIRED');

    const paid = await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'PAID', paymentMethod: 'CASH' })
      .expect(HttpStatus.OK);
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.paidAt).not.toBeNull();
    expect(paid.body.paymentMethod).toBe('CASH');

    // PAID terminal: iptal reddedilir.
    await request(server)
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'CANCELLED' })
      .expect(HttpStatus.CONFLICT);

    // Cancel + recreate: yeni DRAFT fatura iptal edilir, ayni donem yeniden
    // olusturulabilir.
    const second = await request(server)
      .post(`/api/v1/contracts/${contractId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-15, -5))
      .expect(HttpStatus.CREATED);
    await request(server)
      .patch(`/api/v1/invoices/${second.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'CANCELLED' })
      .expect(HttpStatus.OK);
    const recreated = await request(server)
      .post(`/api/v1/contracts/${contractId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(-15, -5))
      .expect(HttpStatus.CREATED);
    expect(recreated.body.id).not.toBe(second.body.id);

    // BANK_TRANSFER + gecerli referans mutlu yolu (recreated uzerinden).
    await request(server)
      .patch(`/api/v1/invoices/${recreated.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ISSUED' })
      .expect(HttpStatus.OK);
    const bankPaid = await request(server)
      .patch(`/api/v1/invoices/${recreated.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'PAID', paymentMethod: 'BANK_TRANSFER', referenceNumber: ' TR-REF-7 ' })
      .expect(HttpStatus.OK);
    expect(bankPaid.body.referenceNumber).toBe('TR-REF-7');
  }, 180000);

  it('fesih-fatura cakismasi + roller/tenant + pagination/filtreler + IDOR', async () => {
    const opsToken = await createOperationsAndLogin('+905558884001');
    const siteA = await createSite(opsToken, 'Bill Site P', 'E2E-BIL-P');
    const siteB = await createSite(opsToken, 'Bill Site Q', 'E2E-BIL-Q');
    const smAToken = await createSiteManagerAndLogin('+905558884002', siteA);
    const smBToken = await createSiteManagerAndLogin('+905558884003', siteB);
    const residentToken = await createRoleUserAndLogin('+905558884004', 'RESIDENT', siteA);
    const techToken = await createRoleUserAndLogin('+905558884005', 'TECHNICIAN');
    const contractId = await seedContract(siteA, '+905558884001');
    const otherSiteContract = await seedContract(siteB, '+905558884001');

    // Gelecek donemli fatura varken fesih -> 409; iptal sonrasi fesih -> 200.
    const futureInvoice = await request(server)
      .post(`/api/v1/contracts/${contractId}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send(invoiceDto(30, 60))
      .expect(HttpStatus.CREATED);
    const terminateConflict = await request(server)
      .patch(`/api/v1/contracts/${contractId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'TERMINATED', terminationReason: 'erken fesih' })
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(terminateConflict.body, 'CONTRACT_TERMINATION_INVOICE_CONFLICT');

    await request(server)
      .patch(`/api/v1/invoices/${futureInvoice.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'CANCELLED' })
      .expect(HttpStatus.OK);
    await request(server)
      .patch(`/api/v1/contracts/${contractId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'TERMINATED', terminationReason: 'erken fesih' })
      .expect(HttpStatus.OK);

    // Pagination/filtre icin TERMINATED sozlesmeye pencere-ici uc fatura.
    const periods: Array<[number, number]> = [
      [-90, -75],
      [-70, -55],
      [-50, -35],
    ];
    const invoiceIds: string[] = [];
    for (const [s, e] of periods) {
      const res = await request(server)
        .post(`/api/v1/contracts/${contractId}/invoices`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send(invoiceDto(s, e))
        .expect(HttpStatus.CREATED);
      invoiceIds.push(res.body.id as string);
    }
    await request(server)
      .patch(`/api/v1/invoices/${invoiceIds[0]}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ISSUED' })
      .expect(HttpStatus.OK);

    // Cursor pagination: limit=2 -> 2 kayit + nextCursor; ikinci sayfa kalanlar.
    const page1 = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices?limit=2`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(page1.body.items.length).toBe(2);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(page2.body.items.length).toBeGreaterThanOrEqual(2); // kalan 2 (iptal edilen dahil degil: CANCELLED da listelenir)
    const page1Ids = page1.body.items.map((i: { id: string }) => i.id);
    const page2Ids = page2.body.items.map((i: { id: string }) => i.id);
    for (const id of page1Ids) expect(page2Ids).not.toContain(id);

    // status filtresi.
    const issuedOnly = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices?status=ISSUED`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(issuedOnly.body.items.length).toBe(1);
    expect(issuedOnly.body.items[0].id).toBe(invoiceIds[0]);

    // contractId filtresi (siteA'daki tek sozlesme).
    const byContract = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices?contractId=${contractId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(
      byContract.body.items.every((i: { contractId: string }) => i.contractId === contractId),
    ).toBe(true);

    // SM kendi sitesini okur; fatura mutasyonu yapamaz (403).
    const smList = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices`)
      .set('Authorization', `Bearer ${smAToken}`)
      .expect(HttpStatus.OK);
    expect(smList.body.items.length).toBeGreaterThan(0);
    await request(server)
      .patch(`/api/v1/invoices/${invoiceIds[0]}/status`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ status: 'CANCELLED' })
      .expect(HttpStatus.FORBIDDEN);
    await request(server)
      .post(`/api/v1/contracts/${contractId}/invoices`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send(invoiceDto(-30, -20))
      .expect(HttpStatus.FORBIDDEN);

    // Tenant/IDOR: SM-B, siteA listesine 404 alir; yanitta siteA verisi sizmaz.
    const crossRes = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices`)
      .set('Authorization', `Bearer ${smBToken}`)
      .expect(HttpStatus.NOT_FOUND);
    expectErrorEnvelope(crossRes.body, 'SITE_NOT_FOUND');
    for (const id of invoiceIds) {
      expect(JSON.stringify(crossRes.body)).not.toContain(id);
    }
    // SM-A, siteB listesine de erisemez (karsit yon).
    await request(server)
      .get(`/api/v1/sites/${siteB}/invoices`)
      .set('Authorization', `Bearer ${smAToken}`)
      .expect(HttpStatus.NOT_FOUND);
    // siteB sozlesmesi siteA listesinde gorunmez (site kapsami contract
    // uzerinden uygulanir).
    const opsListA = await request(server)
      .get(`/api/v1/sites/${siteA}/invoices`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(
      opsListA.body.items.some(
        (i: { contractId: string }) => i.contractId === otherSiteContract,
      ),
    ).toBe(false);

    // RESIDENT/TECHNICIAN tum Faz 7 fatura endpointlerinde 403.
    await request(server)
      .get(`/api/v1/sites/${siteA}/invoices`)
      .set('Authorization', `Bearer ${residentToken}`)
      .expect(HttpStatus.FORBIDDEN);
    await request(server)
      .post(`/api/v1/contracts/${contractId}/invoices`)
      .set('Authorization', `Bearer ${techToken}`)
      .send(invoiceDto(-30, -20))
      .expect(HttpStatus.FORBIDDEN);

    // Gecersiz UUID -> 422.
    await request(server)
      .patch('/api/v1/invoices/gecersiz-uuid/status')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ISSUED' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
  }, 180000);
});
