import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

describe('Tickets E2E (tam uygulama + Testcontainers)', () => {
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
    const { PrismaService } = await import('../../src/infrastructure/database/prisma/prisma.service');
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

  function randomPhone(prefix: string): string {
    return `+9055${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  async function loginViaOtp(phone: string): Promise<{ accessToken: string; refreshToken: string }> {
    await request(server).post('/api/v1/auth/otp/request').send({ phoneNumber: phone }).expect(HttpStatus.OK);
    const code = smsProvider.getLastCode(phone);
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: phone, code })
      .expect(HttpStatus.OK);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
  }

  async function createOperationsAndLogin(prefix: string) {
    const phone = randomPhone(prefix);
    await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Ops', lastName: 'User', role: 'OPERATIONS' },
    });
    return loginViaOtp(phone);
  }

  async function createSiteWithUnit(opsToken: string, prefix: string) {
    const siteRes = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: `Site ${prefix}`, code: `TK-${prefix}` })
      .expect(HttpStatus.CREATED);
    const blockRes = await request(server)
      .post(`/api/v1/facilities/sites/${siteRes.body.id}/blocks`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Blok 1', code: 'B1' })
      .expect(HttpStatus.CREATED);
    const unitRes = await request(server)
      .post(`/api/v1/facilities/blocks/${blockRes.body.id}/units`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ code: 'D-1' })
      .expect(HttpStatus.CREATED);
    return { site: siteRes.body, block: blockRes.body, unit: unitRes.body };
  }

  async function createActiveContract(
    siteId: string,
    createdByUserId: string,
    prefix: string,
    overrides: Record<string, unknown> = {},
  ) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const end = new Date(today);
    end.setDate(end.getDate() + 30);

    await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `E2E-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId,
        ...overrides,
      },
    });
  }

  async function onboardResidentAndLogin(opsToken: string, siteId: string, unitId: string, prefix: string) {
    const phone = randomPhone(prefix);
    await request(server)
      .post(`/api/v1/sites/${siteId}/residents`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ phoneNumber: phone, firstName: 'Sakin', lastName: 'Bir', unitId })
      .expect(HttpStatus.CREATED);
    return loginViaOtp(phone);
  }

  async function getOpsUserId(opsToken: string): Promise<string> {
    const res = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    return res.body.id;
  }

  it('resident kendi dairesi icin ticket olusturur, resident B goremez, history OPEN kaydi icerir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('01');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E1');
    await createActiveContract(site.id, opsUserId, 'E1');

    const { accessToken: residentAToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '10');
    const { accessToken: residentBToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '11');

    const createRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentAToken}`)
      .send({
        facilityId: unit.id,
        title: 'Musluk arizasi',
        description: 'Mutfak muslugu surekli akitiyor, tamir gerekli',
        category: 'PLUMBING',
      })
      .expect(HttpStatus.CREATED);

    expect(createRes.body.status).toBe('OPEN');
    expect(createRes.body.code).toMatch(/^TKT-\d{4}-\d{6}$/);

    const historyRes = await request(server)
      .get(`/api/v1/tickets/${createRes.body.id}/history`)
      .set('Authorization', `Bearer ${residentAToken}`)
      .expect(HttpStatus.OK);
    expect(historyRes.body).toEqual([
      expect.objectContaining({ previousStatus: null, newStatus: 'OPEN' }),
    ]);

    await request(server)
      .get(`/api/v1/tickets/${createRes.body.id}`)
      .set('Authorization', `Bearer ${residentBToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('TICKET_NOT_FOUND');
      });
  }, 60000);

  it('site manager kendi sitesini listeler; baska sitenin siteId sinda 404 SITE_NOT_FOUND alir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('02');
    const opsUserId = await getOpsUserId(opsToken);
    const { site: siteA, unit: unitA } = await createSiteWithUnit(opsToken, 'E2A');
    const { site: siteB } = await createSiteWithUnit(opsToken, 'E2B');
    await createActiveContract(siteA.id, opsUserId, 'E2A');

    const smPhone = randomPhone('20');
    const smUser = await prisma.user.create({
      data: { phoneNumber: smPhone, firstName: 'Site', lastName: 'Manager', role: 'SITE_MANAGER' },
    });
    await prisma.siteMembership.create({
      data: { userId: smUser.id, siteId: siteA.id, membershipRole: 'MANAGER', isActive: true },
    });
    const { accessToken: smToken } = await loginViaOtp(smPhone);

    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, siteA.id, unitA.id, '21');
    await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unitA.id,
        title: 'Elektrik arizasi',
        description: 'Salon prizinde elektrik yok, kontrol gerekli lutfen',
        category: 'ELECTRICAL',
      })
      .expect(HttpStatus.CREATED);

    await request(server)
      .get(`/api/v1/tickets?siteId=${siteA.id}`)
      .set('Authorization', `Bearer ${smToken}`)
      .expect(HttpStatus.OK)
      .expect((res) => {
        expect(res.body.items.length).toBeGreaterThan(0);
      });

    await request(server)
      .get(`/api/v1/tickets?siteId=${siteB.id}`)
      .set('Authorization', `Bearer ${smToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('SITE_NOT_FOUND');
      });
  }, 60000);

  it('resident kendi OPEN ticketini PATCH eder, ayni version ile ikinci PATCH 409 CONCURRENT_MODIFICATION alir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('03');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E3');
    await createActiveContract(site.id, opsUserId, 'E3');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '30');

    const createRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unit.id,
        title: 'Kombi arizasi',
        description: 'Kombi ates almiyor, sicak su yok durumda',
        category: 'HVAC',
      })
      .expect(HttpStatus.CREATED);

    await request(server)
      .patch(`/api/v1/tickets/${createRes.body.id}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ title: 'Kombi arizasi (guncel)', version: createRes.body.version })
      .expect(HttpStatus.OK)
      .expect((res) => {
        expect(res.body.version).toBe(createRes.body.version + 1);
      });

    await request(server)
      .patch(`/api/v1/tickets/${createRes.body.id}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ title: 'Tekrar deneme', version: createRes.body.version })
      .expect(HttpStatus.CONFLICT)
      .expect((res) => {
        expect(res.body.error.code).toBe('CONCURRENT_MODIFICATION');
      });

    await request(server)
      .patch(`/api/v1/tickets/${createRes.body.id}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ version: createRes.body.version + 1 })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => {
        expect(res.body.error.code).toBe('TICKET_UPDATE_EMPTY');
      });
  }, 60000);

  it('resident kendi ticketini reason olmadan iptal edemez, reasonla iptal eder', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('04');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E4');
    await createActiveContract(site.id, opsUserId, 'E4');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '40');

    const createRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unit.id,
        title: 'Havuz pompasi',
        description: 'Havuz pompasindan garip ses geliyor, bakim lazim',
        category: 'POOL',
      })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${createRes.body.id}/cancel`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({})
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);

    await request(server)
      .post(`/api/v1/tickets/${createRes.body.id}/cancel`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ reason: 'Vazgectim' })
      .expect(HttpStatus.CREATED)
      .expect((res) => {
        expect(res.body.status).toBe('CANCELLED');
      });

    const historyRes = await request(server)
      .get(`/api/v1/tickets/${createRes.body.id}/history`)
      .set('Authorization', `Bearer ${residentToken}`)
      .expect(HttpStatus.OK);
    expect(historyRes.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ newStatus: 'CANCELLED', reason: 'Vazgectim' })]),
    );
  }, 60000);

  it('operations OPEN->TRIAGED yapar, ayni istegi tekrar gonderirse 409 TICKET_STATUS_UNCHANGED alir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('05');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E5');
    await createActiveContract(site.id, opsUserId, 'E5');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '50');

    const createRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unit.id,
        title: 'Guvenlik kamerasi',
        description: 'Otopark kamerasi calismiyor, kontrol edilmeli lutfen',
        category: 'SECURITY_SYSTEM',
      })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${createRes.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'TRIAGED' })
      .expect(HttpStatus.CREATED)
      .expect((res) => {
        expect(res.body.status).toBe('TRIAGED');
      });

    await request(server)
      .post(`/api/v1/tickets/${createRes.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'TRIAGED' })
      .expect(HttpStatus.CONFLICT)
      .expect((res) => {
        expect(res.body.error.code).toBe('TICKET_STATUS_UNCHANGED');
      });
  }, 60000);

  it('aktif sozlesmesi olmayan bir sitede ticket olusturma 409 TICKET_SITE_CONTRACT_INACTIVE doner', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('06');
    const { site, unit } = await createSiteWithUnit(opsToken, 'E6');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '60');

    await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unit.id,
        title: 'Genel bakim',
        description: 'Rutin genel bakim talebi, once yapilmasi gerekiyor',
        category: 'GENERAL_MAINTENANCE',
      })
      .expect(HttpStatus.CONFLICT)
      .expect((res) => {
        expect(res.body.error.code).toBe('TICKET_SITE_CONTRACT_INACTIVE');
      });
  }, 60000);

  it('EMERGENCY ticket slaTargetAt EMERGENCY_SLA_HOURS ile hesaplanir, urgency STANDARDa cekilince yeniden hesaplanir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('07');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E7');
    await createActiveContract(site.id, opsUserId, 'E7', { emergencyCoverage: true, standardResponseTargetHours: 48 });
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '70');

    const createRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unit.id,
        title: 'Yangin alarmi',
        description: 'Bina yangin alarmi calismiyor, aciliyet var',
        category: 'SECURITY_SYSTEM',
        urgency: 'EMERGENCY',
      })
      .expect(HttpStatus.CREATED);

    const createdAt = new Date(createRes.body.createdAt).getTime();
    const emergencySla = new Date(createRes.body.slaTargetAt).getTime();
    expect(emergencySla - createdAt).toBe(2 * 3_600_000);

    const updateRes = await request(server)
      .patch(`/api/v1/tickets/${createRes.body.id}`)
      .set('Authorization', `Bearer ${residentToken}`)
      .send({ urgency: 'STANDARD', version: createRes.body.version })
      .expect(HttpStatus.OK);

    const standardSla = new Date(updateRes.body.slaTargetAt).getTime();
    expect(standardSla - createdAt).toBe(48 * 3_600_000);
  }, 60000);

  it('resident olmayan/kendine ait olmayan bir facilityId ile ticket olusturursa 404 FACILITY_NOT_FOUND alir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('08');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E8A');
    await createActiveContract(site.id, opsUserId, 'E8A');
    const { site: otherSite, unit: otherUnit } = await createSiteWithUnit(opsToken, 'E8B');
    await createActiveContract(otherSite.id, opsUserId, 'E8B');

    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '80');

    await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: otherUnit.id,
        title: 'Baska site dairesi',
        description: 'Baska sitedeki bir daire icin ticket denemesi burada',
        category: 'OTHER',
      })
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('FACILITY_NOT_FOUND');
      });

    await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: '11111111-1111-4111-8111-111111111111',
        title: 'Olmayan facility',
        description: 'Var olmayan bir facility icin ticket denemesi burada',
        category: 'OTHER',
      })
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('FACILITY_NOT_FOUND');
      });
  }, 60000);
});
