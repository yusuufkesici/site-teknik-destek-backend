import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

describe('Assignments E2E (tam uygulama + Testcontainers)', () => {
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

  async function loginViaOtp(phone: string): Promise<{ accessToken: string }> {
    await request(server).post('/api/v1/auth/otp/request').send({ phoneNumber: phone }).expect(HttpStatus.OK);
    const code = smsProvider.getLastCode(phone);
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phoneNumber: phone, code })
      .expect(HttpStatus.OK);
    return { accessToken: res.body.accessToken };
  }

  async function createOperationsAndLogin(prefix: string) {
    const phone = randomPhone(prefix);
    await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Ops', lastName: 'User', role: 'OPERATIONS' },
    });
    return loginViaOtp(phone);
  }

  async function createTechnicianAndLogin(prefix: string) {
    const phone = randomPhone(prefix);
    const user = await prisma.user.create({
      data: { phoneNumber: phone, firstName: 'Tekni', lastName: 'Syen', role: 'TECHNICIAN' },
    });
    const { accessToken } = await loginViaOtp(phone);
    return { accessToken, userId: user.id };
  }

  async function createSiteWithUnit(opsToken: string, prefix: string) {
    const siteRes = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: `Site ${prefix}`, code: `AS-${prefix}` })
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

  async function createActiveContract(siteId: string, createdByUserId: string, prefix: string) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const end = new Date(today);
    end.setDate(end.getDate() + 30);

    await prisma.contract.create({
      data: {
        siteId,
        contractNumber: `AS-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId,
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

  async function createTriagedTicket(
    opsToken: string,
    residentToken: string,
    unitId: string,
    prefix: string,
  ): Promise<{ id: string; code: string }> {
    const createRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${residentToken}`)
      .send({
        facilityId: unitId,
        title: `Ariza ${prefix}`,
        description: `E2E test icin olusturulan ariza kaydi ${prefix}`,
        category: 'ELECTRICAL',
      })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${createRes.body.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'TRIAGED' })
      .expect(HttpStatus.CREATED);

    return { id: createRes.body.id, code: createRes.body.code };
  }

  it('tam mutlu yol: atama -> kabul -> EN_ROUTE -> ARRIVED -> IN_PROGRESS -> malzeme -> COMPLETE -> CLOSED', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('91');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'F1');
    await createActiveContract(site.id, opsUserId, 'F1');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '92');
    const tech = await createTechnicianAndLogin('93');

    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'F1');

    const assignRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech.userId })
      .expect(HttpStatus.CREATED);
    expect(assignRes.body.assignmentStatus).toBe('PENDING');
    const assignmentId = assignRes.body.id;

    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/accept`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.CREATED)
      .expect((res) => {
        expect(res.body.assignmentStatus).toBe('ACCEPTED');
      });

    for (const [event, expectedAssignmentStatus] of [
      ['EN_ROUTE', 'ACTIVE'],
      ['ARRIVED', 'ACTIVE'],
      ['START', 'ACTIVE'],
    ] as const) {
      await request(server)
        .post(`/api/v1/assignments/${assignmentId}/status`)
        .set('Authorization', `Bearer ${tech.accessToken}`)
        .send({ event })
        .expect(HttpStatus.CREATED)
        .expect((res) => {
          expect(res.body.assignmentStatus).toBe(expectedAssignmentStatus);
        });
    }

    const ticketAfterStart = await request(server)
      .get(`/api/v1/tickets/${ticket.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(ticketAfterStart.body.status).toBe('IN_PROGRESS');

    const material = await prisma.material.create({
      data: { name: 'Kablo', code: 'MAT-E2E-F1', unit: 'metre', isActive: true },
    });

    const materialRes = await request(server)
      .post(`/api/v1/assignments/${assignmentId}/materials`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .send({ materialId: material.id, quantity: '3', unitPrice: '12.50', suppliedBy: 'COMPANY' })
      .expect(HttpStatus.CREATED);
    expect(materialRes.body.totalPrice).toBe('37.50');

    await request(server)
      .get(`/api/v1/assignments/${assignmentId}/materials`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.OK)
      .expect((res) => {
        expect(res.body).toHaveLength(1);
        expect(res.body[0].material.code).toBe('MAT-E2E-F1');
      });

    const myRes = await request(server)
      .get('/api/v1/assignments/my')
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.OK);
    expect(myRes.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignmentId })]),
    );
    expect(JSON.stringify(myRes.body)).not.toMatch(/\+90\d+/);

    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/status`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .send({ event: 'COMPLETE', note: 'Ariza giderildi' })
      .expect(HttpStatus.CREATED)
      .expect((res) => {
        expect(res.body.assignmentStatus).toBe('COMPLETED');
      });

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'CLOSED' })
      .expect(HttpStatus.CREATED)
      .expect((res) => {
        expect(res.body.status).toBe('CLOSED');
      });
  }, 60000);

  it('baska teknisyenin accept denemesi 404 ASSIGNMENT_NOT_FOUND alir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('94');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'F2');
    await createActiveContract(site.id, opsUserId, 'F2');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '95');
    const tech1 = await createTechnicianAndLogin('96');
    const tech2 = await createTechnicianAndLogin('97');

    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'F2');
    const assignRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech1.userId })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/assignments/${assignRes.body.id}/accept`)
      .set('Authorization', `Bearer ${tech2.accessToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => {
        expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
      });
  }, 60000);

  it('ASSIGNED ticket iptali (karar #1): OPERATIONS /assignments/:id/cancel ile ticket + assignment birlikte CANCELLED olur', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('98');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'F3');
    await createActiveContract(site.id, opsUserId, 'F3');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '99');
    const tech = await createTechnicianAndLogin('100');

    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'F3');
    const assignRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech.userId })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/assignments/${assignRes.body.id}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ reason: 'Musteri iptal etti' })
      .expect(HttpStatus.CREATED)
      .expect((res) => {
        expect(res.body.assignmentStatus).toBe('CANCELLED');
      });

    await request(server)
      .get(`/api/v1/tickets/${ticket.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK)
      .expect((res) => {
        expect(res.body.status).toBe('CANCELLED');
      });
  }, 60000);

  it('COMPLETED->IN_PROGRESS (reopen) karar #2 geregi genel uctan reddedilir (409)', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('101');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'F4');
    await createActiveContract(site.id, opsUserId, 'F4');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '102');
    const tech = await createTechnicianAndLogin('103');

    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'F4');
    const assignRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech.userId })
      .expect(HttpStatus.CREATED);
    const assignmentId = assignRes.body.id;

    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/accept`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.CREATED);
    for (const event of ['EN_ROUTE', 'ARRIVED', 'START'] as const) {
      await request(server)
        .post(`/api/v1/assignments/${assignmentId}/status`)
        .set('Authorization', `Bearer ${tech.accessToken}`)
        .send({ event })
        .expect(HttpStatus.CREATED);
    }
    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/status`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .send({ event: 'COMPLETE' })
      .expect(HttpStatus.CREATED);

    // ChangeTicketStatusDto yalniz TRIAGED/CLOSED kabul eder (DTO seviyesi
    // ilk savunma hatti) - IN_PROGRESS bu ucun kapsaminda olmadigi icin 422
    // VALIDATION_ERROR ile reddedilir. Policy seviyesindeki ikinci savunma
    // hatti (TicketDirectTransitionPolicy.assertAllowedDirectly reddi, 409
    // TICKET_INVALID_STATUS_TRANSITION) ayrica
    // ticket-direct-transition.policy.spec.ts'de dogrudan test edilir.
    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'IN_PROGRESS', reason: 'yeniden acilsin' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => {
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
  }, 60000);

  it('RESIDENT /assignments/my erisemez (403)', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('104');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'F5');
    await createActiveContract(site.id, opsUserId, 'F5');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '105');

    await request(server)
      .get('/api/v1/assignments/my')
      .set('Authorization', `Bearer ${residentToken}`)
      .expect(HttpStatus.FORBIDDEN);
  }, 60000);
});
