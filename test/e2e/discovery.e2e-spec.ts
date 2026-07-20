import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

// Frontend enablement plani (docs/frontend-enablement-plan.md Bolum 8):
// dort kesif ucunun rol/tenant/uniform-404 sozlesmeleri + vertical slice'in
// yalniz API'den kesfedilen id'lerle kosulabildiginin kaniti.
describe('Discovery E2E (tam uygulama + Testcontainers)', () => {
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
      .send({ name: `Site ${prefix}`, code: `DS-${prefix}` })
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
        contractNumber: `DS-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
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
    const onboardRes = await request(server)
      .post(`/api/v1/sites/${siteId}/residents`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ phoneNumber: phone, firstName: 'Sakin', lastName: 'Bir', unitId })
      .expect(HttpStatus.CREATED);
    const { accessToken } = await loginViaOtp(phone);
    return { accessToken, userId: onboardRes.body.id as string };
  }

  it('GET /materials: yalniz aktif katalog, cursor sayfalama, rol ve cursor hatalari', async () => {
    const { accessToken: techToken } = await createTechnicianAndLogin('81');
    const { accessToken: opsToken } = await createOperationsAndLogin('82');

    const activeOld = await prisma.material.create({
      data: { name: 'Aktif Eski', code: 'DSE-M1', unit: 'adet', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const activeNew = await prisma.material.create({
      data: { name: 'Aktif Yeni', code: 'DSE-M2', unit: 'metre', description: 'PPRC', createdAt: new Date('2026-02-01T00:00:00.000Z') },
    });
    await prisma.material.create({
      data: { name: 'Pasif', code: 'DSE-M3', unit: 'adet', isActive: false },
    });

    const listRes = await request(server)
      .get('/api/v1/materials')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(HttpStatus.OK);

    const codes = listRes.body.items.map((item: { code: string }) => item.code);
    expect(codes).toContain('DSE-M1');
    expect(codes).toContain('DSE-M2');
    expect(codes).not.toContain('DSE-M3');
    const newest = listRes.body.items.find((item: { id: string }) => item.id === activeNew.id);
    expect(Object.keys(newest).sort()).toEqual([
      'code',
      'createdAt',
      'description',
      'id',
      'name',
      'unit',
    ]);

    // OPERATIONS da erisebilir; limit=1 ile nextCursor uretilir ve ikinci
    // sayfada eski kayit gelir (cursor opak string olarak geri verilir).
    const page1 = await request(server)
      .get('/api/v1/materials?limit=1')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.items[0].id).toBe(activeNew.id);
    expect(typeof page1.body.nextCursor).toBe('string');

    const page2 = await request(server)
      .get(`/api/v1/materials?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(page2.body.items[0].id).toBe(activeOld.id);

    await request(server)
      .get('/api/v1/materials?cursor=%25bozuk%25')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => expect(res.body.error.code).toBe('VALIDATION_ERROR'));

    // RESIDENT/SITE_MANAGER kataloga erisemez (403 FORBIDDEN).
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: 'Mgr Site', code: 'DSE-S1' },
    });
    const mgrPhone = randomPhone('83');
    await prisma.user.create({
      data: { phoneNumber: mgrPhone, firstName: 'Site', lastName: 'Mgr', role: 'SITE_MANAGER' },
    });
    const mgr = await prisma.user.findFirst({ where: { phoneNumber: mgrPhone } });
    await prisma.siteMembership.create({
      data: { userId: mgr.id, siteId: site.id, membershipRole: 'MANAGER', isActive: true },
    });
    const { accessToken: mgrToken } = await loginViaOtp(mgrPhone);
    await request(server)
      .get('/api/v1/materials')
      .set('Authorization', `Bearer ${mgrToken}`)
      .expect(HttpStatus.FORBIDDEN)
      .expect((res) => expect(res.body.error.code).toBe('FORBIDDEN'));
  });

  it('GET /users/technicians: yalniz aktif teknisyenler, telefon donmez, pasiflesen duser, rol kisiti', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('84');
    const { accessToken: techToken, userId: activeTechId } = await createTechnicianAndLogin('85');
    const inactiveTech = await prisma.user.create({
      data: {
        phoneNumber: randomPhone('86'),
        firstName: 'Pasif',
        lastName: 'Teknisyen',
        role: 'TECHNICIAN',
        isActive: false,
      },
    });

    const listRes = await request(server)
      .get('/api/v1/users/technicians')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);

    const ids = listRes.body.map((row: { id: string }) => row.id);
    expect(ids).toContain(activeTechId);
    expect(ids).not.toContain(inactiveTech.id);
    for (const row of listRes.body) {
      expect(Object.keys(row).sort()).toEqual(['firstName', 'id', 'lastName']);
    }

    // TECHNICIAN kendisi listeye erisemez (403) - pasiflestirmeden ONCE
    // kontrol edilir; global pasiflestirme token'i 401'e dusurur.
    await request(server)
      .get('/api/v1/users/technicians')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(HttpStatus.FORBIDDEN);

    // Global pasiflestirme sonrasi listeden duser.
    await request(server)
      .post(`/api/v1/users/${activeTechId}/deactivate`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ reason: 'Ayrildi' })
      .expect(HttpStatus.NO_CONTENT);

    const afterRes = await request(server)
      .get('/api/v1/users/technicians')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(afterRes.body.map((row: { id: string }) => row.id)).not.toContain(activeTechId);
  });

  it('GET /users/me/units: yalniz kendi aktif uniti, pasiflestirme sonrasi bos liste, rol kisiti', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('87');
    const { site, unit } = await createSiteWithUnit(opsToken, 'E1');
    const resident = await onboardResidentAndLogin(opsToken, site.id, unit.id, '88');

    // Ayni sitede ikinci daire + ikinci resident: listeler karismaz.
    const unit2Res = await request(server)
      .post(`/api/v1/facilities/blocks/${(await prisma.facility.findFirst({ where: { siteId: site.id, type: 'BLOCK' } })).id}/units`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ code: 'D-2' })
      .expect(HttpStatus.CREATED);
    const resident2 = await onboardResidentAndLogin(opsToken, site.id, unit2Res.body.id, '89');

    const myUnits = await request(server)
      .get('/api/v1/users/me/units')
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .expect(HttpStatus.OK);

    expect(myUnits.body).toHaveLength(1);
    expect(myUnits.body[0]).toMatchObject({
      unitId: unit.id,
      isPrimary: true,
      unit: { id: unit.id, code: 'D-1', siteId: site.id },
    });
    expect(Object.keys(myUnits.body[0]).sort()).toEqual([
      'id',
      'isPrimary',
      'startsAt',
      'unit',
      'unitId',
    ]);

    const otherUnits = await request(server)
      .get('/api/v1/users/me/units')
      .set('Authorization', `Bearer ${resident2.accessToken}`)
      .expect(HttpStatus.OK);
    expect(otherUnits.body).toHaveLength(1);
    expect(otherUnits.body[0].unitId).toBe(unit2Res.body.id);

    // OPERATIONS bu uca erisemez (403) - resident-only kesif ucu.
    await request(server)
      .get('/api/v1/users/me/units')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.FORBIDDEN);

    // Site-scoped pasiflestirme unit assignment'lari da kapatir -> bos liste.
    await request(server)
      .post(`/api/v1/sites/${site.id}/users/${resident.userId}/deactivate`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ reason: 'Tasindi' })
      .expect(HttpStatus.NO_CONTENT);

    const afterDeactivate = await request(server)
      .get('/api/v1/users/me/units')
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .expect(HttpStatus.OK);
    expect(afterDeactivate.body).toEqual([]);
  });

  it('GET /tickets/:ticketId/assignments/current: uniform 404, atama/reassign kesfi, rol kisiti', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('91');
    const { site, unit } = await createSiteWithUnit(opsToken, 'E2');
    const opsMe = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    await createActiveContract(site.id, opsMe.body.id, 'E2');
    const resident = await onboardResidentAndLogin(opsToken, site.id, unit.id, '92');
    const tech1 = await createTechnicianAndLogin('93');
    const tech2 = await createTechnicianAndLogin('94');

    // Bilinmeyen ticket -> uniform 404 TICKET_NOT_FOUND.
    await request(server)
      .get('/api/v1/tickets/00000000-0000-4000-8000-000000000000/assignments/current')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('TICKET_NOT_FOUND'));

    const ticketRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .send({
        facilityId: unit.id,
        title: 'Discovery ariza',
        description: 'Current assignment kesif E2E kaydi.',
        category: 'ELECTRICAL',
      })
      .expect(HttpStatus.CREATED);
    const ticketId = ticketRes.body.id;

    // Henuz atama yok -> 404 ASSIGNMENT_NOT_FOUND (normal akis durumu).
    await request(server)
      .get(`/api/v1/tickets/${ticketId}/assignments/current`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND'));

    await request(server)
      .post(`/api/v1/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'TRIAGED' })
      .expect(HttpStatus.CREATED);

    const assignRes = await request(server)
      .post(`/api/v1/tickets/${ticketId}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech1.userId })
      .expect(HttpStatus.CREATED);

    const current1 = await request(server)
      .get(`/api/v1/tickets/${ticketId}/assignments/current`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(current1.body).toMatchObject({
      id: assignRes.body.id,
      ticketId,
      technicianId: tech1.userId,
      assignmentStatus: 'PENDING',
      isCurrent: true,
    });

    // Reassign: yeni current doner, eski id degil.
    const reassignRes = await request(server)
      .post(`/api/v1/tickets/${ticketId}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech2.userId })
      .expect(HttpStatus.CREATED);

    const current2 = await request(server)
      .get(`/api/v1/tickets/${ticketId}/assignments/current`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    expect(current2.body.id).toBe(reassignRes.body.id);
    expect(current2.body.technicianId).toBe(tech2.userId);

    // Yalniz OPERATIONS: teknisyen ve resident 403 alir.
    await request(server)
      .get(`/api/v1/tickets/${ticketId}/assignments/current`)
      .set('Authorization', `Bearer ${tech2.accessToken}`)
      .expect(HttpStatus.FORBIDDEN);
    await request(server)
      .get(`/api/v1/tickets/${ticketId}/assignments/current`)
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .expect(HttpStatus.FORBIDDEN);
  });

  it('vertical slice discovery varyanti: tum id degerleri yalniz API kesif uclarindan alinarak akis tamamlanir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('95');
    const { site, unit } = await createSiteWithUnit(opsToken, 'E3');
    const opsMe = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    await createActiveContract(site.id, opsMe.body.id, 'E3');
    const resident = await onboardResidentAndLogin(opsToken, site.id, unit.id, '96');
    const tech = await createTechnicianAndLogin('97');
    await prisma.material.create({
      data: { name: 'Kesif Malzemesi', code: 'DSE-VS1', unit: 'adet' },
    });

    // 1) Resident unit'ini KESFEDER (id'yi disaridan bilmez).
    const myUnits = await request(server)
      .get('/api/v1/users/me/units')
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .expect(HttpStatus.OK);
    const discoveredUnitId = myUnits.body[0].unitId;

    // 2) Ticket olusturur.
    const ticketRes = await request(server)
      .post('/api/v1/tickets')
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .send({
        facilityId: discoveredUnitId,
        title: 'Priz yanmis kokuyor',
        description: 'Salondaki priz kararmis, yanik kokusu var.',
        category: 'ELECTRICAL',
      })
      .expect(HttpStatus.CREATED);
    const ticketId = ticketRes.body.id;

    // 3) Ops triage eder ve teknisyeni KESFEDEREK atar.
    await request(server)
      .post(`/api/v1/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'TRIAGED' })
      .expect(HttpStatus.CREATED);

    const technicians = await request(server)
      .get('/api/v1/users/technicians')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    const discoveredTechId = technicians.body.find(
      (row: { id: string }) => row.id === tech.userId,
    ).id;

    await request(server)
      .post(`/api/v1/tickets/${ticketId}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: discoveredTechId })
      .expect(HttpStatus.CREATED);

    // 4) Teknisyen isini kendi listesinden bulur, kabul eder, ilerletir.
    const myAssignments = await request(server)
      .get('/api/v1/assignments/my')
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.OK);
    const assignmentId = myAssignments.body.items[0].id;

    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/accept`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.CREATED);
    for (const event of ['EN_ROUTE', 'ARRIVED', 'START']) {
      await request(server)
        .post(`/api/v1/assignments/${assignmentId}/status`)
        .set('Authorization', `Bearer ${tech.accessToken}`)
        .send({ event })
        .expect(HttpStatus.CREATED);
    }

    // 5) Malzemeyi KESFEDEREK ekler.
    const materials = await request(server)
      .get('/api/v1/materials')
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .expect(HttpStatus.OK);
    const discoveredMaterial = materials.body.items.find(
      (item: { code: string }) => item.code === 'DSE-VS1',
    );
    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/materials`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .send({ materialId: discoveredMaterial.id, quantity: '1', unitPrice: '10.00', suppliedBy: 'COMPANY' })
      .expect(HttpStatus.CREATED);

    // 6) Tamamlar; ops current'i sorgular (COMPLETE sonrasi isCurrent=false
    //    oldugu icin 404) ve ticket'i kapatir; resident sonucu gorur.
    await request(server)
      .post(`/api/v1/assignments/${assignmentId}/status`)
      .set('Authorization', `Bearer ${tech.accessToken}`)
      .send({ event: 'COMPLETE', note: 'Priz degistirildi.' })
      .expect(HttpStatus.CREATED);

    await request(server)
      .get(`/api/v1/tickets/${ticketId}/assignments/current`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND'));

    await request(server)
      .post(`/api/v1/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toStatus: 'CLOSED' })
      .expect(HttpStatus.CREATED);

    const finalTicket = await request(server)
      .get(`/api/v1/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${resident.accessToken}`)
      .expect(HttpStatus.OK);
    expect(finalTicket.body.status).toBe('CLOSED');
  });
});
