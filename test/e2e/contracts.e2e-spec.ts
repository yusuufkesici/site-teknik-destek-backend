import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

// Onaylanan Faz 7 plani Bolum 21: gercek HTTP + gercek PostgreSQL.
// OPERATIONS contract create/update/list, SITE_MANAGER kendi-site salt-okuma,
// cross-site 404, RESIDENT/TECHNICIAN 403, gecersiz UUID/DTO 422, overlap,
// KATI EXPIRED today/yesterday siniri, uniform hata zarfi.
describe('Contracts E2E (tam uygulama + Testcontainers)', () => {
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
      data: { phoneNumber: phone, firstName: 'Ops', lastName: 'E2E', role: 'OPERATIONS' },
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

  function expectErrorEnvelope(body: Record<string, unknown>, code: string): void {
    expect(body.success).toBe(false);
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe(code);
    expect(typeof error.message).toBe('string');
    expect(typeof error.requestId).toBe('string');
    expect(typeof error.timestamp).toBe('string');
  }

  it('contract CRUD + roller + tenant izolasyonu + overlap + uniform hata zarfi', async () => {
    const opsToken = await createOperationsAndLogin('+905558880001');
    const siteA = await createSite(opsToken, 'Site A', 'E2E-CNT-A');
    const siteB = await createSite(opsToken, 'Site B', 'E2E-CNT-B');
    const smAToken = await createSiteManagerAndLogin('+905558880002', siteA);
    const smBToken = await createSiteManagerAndLogin('+905558880003', siteB);
    const residentToken = await createRoleUserAndLogin('+905558880004', 'RESIDENT', siteA);
    const techToken = await createRoleUserAndLogin('+905558880005', 'TECHNICIAN');

    // OPERATIONS olusturur: siteId body'de, her zaman DRAFT, numara server-side.
    const createRes = await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        siteId: siteA,
        startDate: isoDaysFromToday(-10),
        endDate: isoDaysFromToday(180),
        monthlyFee: '1500.00',
        billingDay: 5,
        serviceScope: 'genel bakim',
      })
      .expect(HttpStatus.CREATED);
    const contract = createRes.body;
    expect(contract.status).toBe('DRAFT');
    expect(contract.contractNumber).toMatch(/^CNT-\d{4}-\d{6}$/);
    expect(contract.monthlyFee).toBe('1500.00');
    expect(contract.startDate).toBe(isoDaysFromToday(-10));

    // Bilinmeyen alan (contractNumber client'tan verilemez) -> 422.
    const unknownFieldRes = await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        siteId: siteA,
        startDate: isoDaysFromToday(200),
        endDate: isoDaysFromToday(300),
        monthlyFee: '100.00',
        billingDay: 1,
        contractNumber: 'CLIENT-VERILEMEZ',
      })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(unknownFieldRes.body, 'VALIDATION_ERROR');

    // Gecersiz UUID -> 422.
    const badUuidRes = await request(server)
      .patch('/api/v1/contracts/gecersiz-uuid')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ notes: 'x' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(badUuidRes.body.error.code).toBe('VALIDATION_ERROR');

    // Rol reddi: SM/RESIDENT/TECHNICIAN mutasyon yapamaz (403).
    await request(server)
      .patch(`/api/v1/contracts/${contract.id}`)
      .set('Authorization', `Bearer ${smAToken}`)
      .send({ notes: 'yasak' })
      .expect(HttpStatus.FORBIDDEN);
    await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${techToken}`)
      .send({
        siteId: siteA,
        startDate: isoDaysFromToday(0),
        endDate: isoDaysFromToday(10),
        monthlyFee: '1.00',
        billingDay: 1,
      })
      .expect(HttpStatus.FORBIDDEN);
    // RESIDENT liste dahi goremez (403).
    await request(server)
      .get(`/api/v1/sites/${siteA}/contracts`)
      .set('Authorization', `Bearer ${residentToken}`)
      .expect(HttpStatus.FORBIDDEN);

    // Tenant izolasyonu: baska sitenin SM'i 404 alir, varlik sizdirilmaz.
    const crossRes = await request(server)
      .get(`/api/v1/sites/${siteA}/contracts`)
      .set('Authorization', `Bearer ${smBToken}`)
      .expect(HttpStatus.NOT_FOUND);
    expectErrorEnvelope(crossRes.body, 'SITE_NOT_FOUND');
    expect(JSON.stringify(crossRes.body)).not.toContain(contract.id);

    // SM kendi sitesini salt-okur.
    const smListRes = await request(server)
      .get(`/api/v1/sites/${siteA}/contracts`)
      .set('Authorization', `Bearer ${smAToken}`)
      .expect(HttpStatus.OK);
    expect(smListRes.body.items.map((c: { id: string }) => c.id)).toContain(contract.id);
    expect(smListRes.body).toHaveProperty('nextCursor');

    // Aktivasyon.
    const activateRes = await request(server)
      .patch(`/api/v1/contracts/${contract.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ACTIVE' })
      .expect(HttpStatus.OK);
    expect(activateRes.body.status).toBe('ACTIVE');

    // ACTIVE varken cakisan yeni sozlesme (create on-kontrolu) -> 409.
    const overlapRes = await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        siteId: siteA,
        startDate: isoDaysFromToday(30),
        endDate: isoDaysFromToday(400),
        monthlyFee: '2000.00',
        billingDay: 1,
      })
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(overlapRes.body, 'CONTRACT_OVERLAP');

    // Iki DRAFT (farkli site'ta ardisik aktivasyon icin): siteB'de cakisan
    // iki taslak olustur, ardisik HTTP aktivasyonunda ikincisi 409.
    const draft1 = await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        siteId: siteB,
        startDate: isoDaysFromToday(-5),
        endDate: isoDaysFromToday(100),
        monthlyFee: '900.00',
        billingDay: 1,
      })
      .expect(HttpStatus.CREATED);
    const draft2 = await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        siteId: siteB,
        startDate: isoDaysFromToday(20),
        endDate: isoDaysFromToday(200),
        monthlyFee: '950.00',
        billingDay: 1,
      })
      .expect(HttpStatus.CREATED);

    await request(server)
      .patch(`/api/v1/contracts/${draft1.body.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ACTIVE' })
      .expect(HttpStatus.OK);
    const secondActivate = await request(server)
      .patch(`/api/v1/contracts/${draft2.body.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'ACTIVE' })
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(secondActivate.body, 'CONTRACT_OVERLAP');

    // Immutable alan: ACTIVE sozlesmede monthlyFee -> 422.
    const immutableRes = await request(server)
      .patch(`/api/v1/contracts/${contract.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ monthlyFee: '9999.00' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(immutableRes.body, 'CONTRACT_IMMUTABLE_FIELD');
  }, 120000);

  it('KATI EXPIRED siniri + fesih dogrulamalari + bos govde', async () => {
    const opsToken = await createOperationsAndLogin('+905558881001');
    const siteC = await createSite(opsToken, 'Site C', 'E2E-CNT-C');
    const siteD = await createSite(opsToken, 'Site D', 'E2E-CNT-D');
    const opsUser = await prisma.user.findUnique({ where: { phoneNumber: '+905558881001' } });

    // endDate = BUGUN: EXPIRED reddedilir (sozlesme o gun boyunca gecerli).
    const endsToday = await prisma.contract.create({
      data: {
        siteId: siteC,
        contractNumber: 'E2E-CN-TODAY',
        startDate: new Date(`${isoDaysFromToday(-100)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(0)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsUser.id,
      },
    });
    const todayRes = await request(server)
      .patch(`/api/v1/contracts/${endsToday.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'EXPIRED' })
      .expect(HttpStatus.CONFLICT);
    expectErrorEnvelope(todayRes.body, 'CONTRACT_INVALID_STATUS_TRANSITION');

    // endDate = DUN: EXPIRED basarili.
    const endedYesterday = await prisma.contract.create({
      data: {
        siteId: siteD,
        contractNumber: 'E2E-CN-YESTERDAY',
        startDate: new Date(`${isoDaysFromToday(-100)}T00:00:00Z`),
        endDate: new Date(`${isoDaysFromToday(-1)}T00:00:00Z`),
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        createdByUserId: opsUser.id,
      },
    });
    const yesterdayRes = await request(server)
      .patch(`/api/v1/contracts/${endedYesterday.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'EXPIRED' })
      .expect(HttpStatus.OK);
    expect(yesterdayRes.body.status).toBe('EXPIRED');

    // Fesih: reason'siz -> 422 VALIDATION_ERROR (DTO); yalniz-bosluk -> 422.
    const draft = await request(server)
      .post('/api/v1/contracts')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        siteId: siteC,
        startDate: isoDaysFromToday(10),
        endDate: isoDaysFromToday(100),
        monthlyFee: '500.00',
        billingDay: 1,
      })
      .expect(HttpStatus.CREATED);

    const noReason = await request(server)
      .patch(`/api/v1/contracts/${draft.body.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'TERMINATED' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(noReason.body, 'VALIDATION_ERROR');
    await request(server)
      .patch(`/api/v1/contracts/${draft.body.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'TERMINATED', terminationReason: '    ' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);

    // Bos govde -> 422 CONTRACT_UPDATE_EMPTY.
    const emptyRes = await request(server)
      .patch(`/api/v1/contracts/${draft.body.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({})
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expectErrorEnvelope(emptyRes.body, 'CONTRACT_UPDATE_EMPTY');

    // Gecerli fesih: terminatedAt server-set olarak response'a yansir.
    const terminated = await request(server)
      .patch(`/api/v1/contracts/${draft.body.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ status: 'TERMINATED', terminationReason: 'anlasmali iptal' })
      .expect(HttpStatus.OK);
    expect(terminated.body.status).toBe('TERMINATED');
    expect(terminated.body.terminatedAt).not.toBeNull();
    expect(terminated.body.terminationReason).toBe('anlasmali iptal');
  }, 120000);
});
