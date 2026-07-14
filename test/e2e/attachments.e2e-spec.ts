import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

const JPEG_FIXTURE = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF fixture content for Faz 6 e2e test', 'ascii'),
]);

describe('Attachments E2E (tam uygulama + Testcontainers)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let smsProvider: CapturingSmsProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let localPath: string;

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
    localPath = app.get(ConfigService).getOrThrow<string>('storage.localPath');
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
      .send({ name: `Site ${prefix}`, code: `AA-${prefix}` })
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
        contractNumber: `AA-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
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

  function countFilesUnder(dirName: 'tmp' | 'attachments'): number {
    const dir = path.join(localPath, dirName);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).length;
  }

  it('gecerli JPEG upload -> 201, listeleme -> 200, download -> dogru header ve byte icerik', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('01');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A1');
    await createActiveContract(site.id, opsUserId, 'A1');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '02');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'A1');

    const uploadRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.CREATED);

    expect(uploadRes.body.ticketId).toBe(ticket.id);
    expect(uploadRes.body.mimeType).toBe('image/jpeg');
    expect(uploadRes.body).not.toHaveProperty('storageKey');
    expect(uploadRes.body).not.toHaveProperty('storageProvider');

    const listRes = await request(server)
      .get(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .expect(HttpStatus.OK);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].id).toBe(uploadRes.body.id);

    const downloadRes = await request(server)
      .get(`/api/v1/attachments/${uploadRes.body.id}/download`)
      .set('Authorization', `Bearer ${residentToken}`)
      .expect(HttpStatus.OK);
    expect(downloadRes.headers['content-type']).toBe('image/jpeg');
    expect(downloadRes.headers['content-disposition']).toContain('foto.jpg');
    expect(downloadRes.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(downloadRes.body as Buffer, JPEG_FIXTURE)).toBe(0);
  }, 60000);

  it('cross-site (baska sitenin residenti) -> 404 TICKET_NOT_FOUND', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('03');
    const opsUserId = await getOpsUserId(opsToken);
    const { site: siteA, unit: unitA } = await createSiteWithUnit(opsToken, 'A2');
    await createActiveContract(siteA.id, opsUserId, 'A2');
    const { accessToken: residentA } = await onboardResidentAndLogin(opsToken, siteA.id, unitA.id, '04');
    const { site: siteB, unit: unitB } = await createSiteWithUnit(opsToken, 'A3');
    await createActiveContract(siteB.id, opsUserId, 'A3');
    const { accessToken: residentB } = await onboardResidentAndLogin(opsToken, siteB.id, unitB.id, '05');

    const ticket = await createTriagedTicket(opsToken, residentA, unitA.id, 'A2');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentB}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('TICKET_NOT_FOUND'));
  }, 60000);

  it('baska teknisyenin assignment i ile upload -> 404 ASSIGNMENT_NOT_FOUND', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('06');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A4');
    await createActiveContract(site.id, opsUserId, 'A4');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '07');
    const tech1 = await createTechnicianAndLogin('08');
    const tech2 = await createTechnicianAndLogin('09');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'A4');

    // tech2'nin ticket'i okuyabilmesi icin once tech2 atanir, sonra tech1'e
    // reassign edilir (tech2'nin eski atamasi ticket okuma erisimini korur).
    // Reassign, ticket ASSIGNED durumundayken (henuz kabul edilmemisken)
    // yapilmalidir - ACCEPTED durumundan itibaren yeniden atama kabul
    // edilmez (ASSIGNABLE_TICKET_STATUSES), bu yuzden accept EN SON yapilir.
    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech2.userId })
      .expect(HttpStatus.CREATED);
    const reassignRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech1.userId })
      .expect(HttpStatus.CREATED);
    await request(server)
      .post(`/api/v1/assignments/${reassignRes.body.id}/accept`)
      .set('Authorization', `Bearer ${tech1.accessToken}`)
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${tech2.accessToken}`)
      .field('attachmentType', 'BEFORE_WORK')
      .field('assignmentId', reassignRes.body.id)
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('ASSIGNMENT_NOT_FOUND'));
  }, 60000);

  it('RESIDENT kendi ticket ina 201, baskasinin ticket ina 404 alir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('10');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A5');
    await createActiveContract(site.id, opsUserId, 'A5');
    const { accessToken: owner } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '11');
    const { accessToken: stranger } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '12');
    const ticket = await createTriagedTicket(opsToken, owner, unit.id, 'A5');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${owner}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${stranger}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('TICKET_NOT_FOUND'));
  }, 60000);

  it('RESIDENT assignmentId gonderirse -> 403 ATTACHMENT_UPLOAD_NOT_ALLOWED', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('13');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A6');
    await createActiveContract(site.id, opsUserId, 'A6');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '14');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'A6');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .field('assignmentId', '00000000-0000-0000-0000-000000000000')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.FORBIDDEN)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_UPLOAD_NOT_ALLOWED'));
  }, 60000);

  it('RESIDENT CANCELLED ticket a upload -> 403 TICKET_UPDATE_FORBIDDEN', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('15');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A7');
    await createActiveContract(site.id, opsUserId, 'A7');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '16');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'A7');

    // TRIAGED->CLOSED direkt gecis allowlist'te degil (yalniz
    // COMPLETED->CLOSED); CANCELLED ise TRIAGED'tan direkt ulasilabilen bir
    // terminal durum oldugu icin bu test onu kullanir - ikisi de
    // UPLOAD_FORBIDDEN_TICKET_STATUSES icinde ayni sonucu vermelidir.
    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ reason: 'Test icin iptal' })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.FORBIDDEN)
      .expect((res) => expect(res.body.error.code).toBe('TICKET_UPDATE_FORBIDDEN'));
  }, 60000);

  it('10 MB üzerinde dosya -> 413 ATTACHMENT_TOO_LARGE, tmp dosyasi diskte kalmaz', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('17');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A8');
    await createActiveContract(site.id, opsUserId, 'A8');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '18');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'A8');

    const before = countFilesUnder('tmp');
    const oversized = Buffer.alloc(11 * 1024 * 1024, 0);

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', oversized, 'buyuk.jpg')
      .expect(HttpStatus.PAYLOAD_TOO_LARGE)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_TOO_LARGE'));

    expect(countFilesUnder('tmp')).toBe(before);
  }, 60000);

  it('izin verilmeyen MIME (text/plain) -> 415 ATTACHMENT_UNSUPPORTED_TYPE', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('19');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'A9');
    await createActiveContract(site.id, opsUserId, 'A9');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '20');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'A9');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', Buffer.from('sadece metin icerigi'), {
        filename: 'not-a-photo.txt',
        contentType: 'text/plain',
      })
      .expect(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_UNSUPPORTED_TYPE'));
  }, 60000);

  it('bos dosya -> 422 ATTACHMENT_FILE_REQUIRED', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('21');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B1');
    await createActiveContract(site.id, opsUserId, 'B1');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '22');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'B1');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', Buffer.alloc(0), 'bos.jpg')
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_FILE_REQUIRED'));
  }, 60000);

  it('bilinmeyen multipart alani -> 422 VALIDATION_ERROR, tmp dosyasi temizlenir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('23');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B2');
    await createActiveContract(site.id, opsUserId, 'B2');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '24');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'B2');

    const before = countFilesUnder('tmp');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .field('bilinmeyenAlan', 'deger')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => expect(res.body.error.code).toBe('VALIDATION_ERROR'));

    expect(countFilesUnder('tmp')).toBe(before);
  }, 60000);

  it('gecersiz attachmentType -> 422 VALIDATION_ERROR, tmp dosyasi temizlenir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('25');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B3');
    await createActiveContract(site.id, opsUserId, 'B3');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '26');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'B3');

    const before = countFilesUnder('tmp');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'GECERSIZ_TIP')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => expect(res.body.error.code).toBe('VALIDATION_ERROR'));

    expect(countFilesUnder('tmp')).toBe(before);
  }, 60000);

  it('gecersiz UUID (assignmentId) -> 422 VALIDATION_ERROR, tmp dosyasi temizlenir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('36');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B7');
    await createActiveContract(site.id, opsUserId, 'B7');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '37');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'B7');

    const before = countFilesUnder('tmp');

    await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .field('assignmentId', 'bu-bir-uuid-degil')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.UNPROCESSABLE_ENTITY)
      .expect((res) => expect(res.body.error.code).toBe('VALIDATION_ERROR'));

    expect(countFilesUnder('tmp')).toBe(before);
  }, 60000);

  it('assignment-ticket mismatch -> 409 ATTACHMENT_ASSIGNMENT_MISMATCH', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('27');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B4');
    await createActiveContract(site.id, opsUserId, 'B4');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '28');
    const tech1 = await createTechnicianAndLogin('29');
    const tech3 = await createTechnicianAndLogin('30');
    const ticketA = await createTriagedTicket(opsToken, residentToken, unit.id, 'B4a');
    const ticketB = await createTriagedTicket(opsToken, residentToken, unit.id, 'B4b');

    const assignOnA = await request(server)
      .post(`/api/v1/tickets/${ticketA.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech1.userId })
      .expect(HttpStatus.CREATED);
    await request(server)
      .post(`/api/v1/assignments/${assignOnA.body.id}/accept`)
      .set('Authorization', `Bearer ${tech1.accessToken}`)
      .expect(HttpStatus.CREATED);

    // tech1'e ticketB uzerinde okuma erisimi kazandirmak icin once atanir,
    // sonra baskasina (tech3) reassign edilir.
    await request(server)
      .post(`/api/v1/tickets/${ticketB.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech1.userId })
      .expect(HttpStatus.CREATED);
    await request(server)
      .post(`/api/v1/tickets/${ticketB.id}/assignments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ technicianId: tech3.userId })
      .expect(HttpStatus.CREATED);

    await request(server)
      .post(`/api/v1/tickets/${ticketB.id}/attachments`)
      .set('Authorization', `Bearer ${tech1.accessToken}`)
      .field('attachmentType', 'BEFORE_WORK')
      .field('assignmentId', assignOnA.body.id)
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.CONFLICT)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_ASSIGNMENT_MISMATCH'));
  }, 60000);

  it('download: attachment yok / soft-deleted / ticket okunamiyor - ucu de 404 ATTACHMENT_NOT_FOUND', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('31');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B5');
    await createActiveContract(site.id, opsUserId, 'B5');
    const { accessToken: owner } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '32');
    const { accessToken: stranger } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '33');
    const ticket = await createTriagedTicket(opsToken, owner, unit.id, 'B5');

    const uploadRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${owner}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.CREATED);

    // (a) hic olmayan id
    await request(server)
      .get(`/api/v1/attachments/00000000-0000-0000-0000-000000000000/download`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND'));

    // (b) ticket'i okuyamayan baska bir resident icin de ayni kod
    await request(server)
      .get(`/api/v1/attachments/${uploadRes.body.id}/download`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND'));

    // (c) soft-deleted
    await prisma.ticketAttachment.update({
      where: { id: uploadRes.body.id },
      data: { deletedAt: new Date() },
    });
    await request(server)
      .get(`/api/v1/attachments/${uploadRes.body.id}/download`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect((res) => expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND'));
  }, 60000);

  it('storage dosyasi gercekten diskte olusur ve final key altinda kalir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('34');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'B6');
    await createActiveContract(site.id, opsUserId, 'B6');
    const { accessToken: residentToken } = await onboardResidentAndLogin(opsToken, site.id, unit.id, '35');
    const ticket = await createTriagedTicket(opsToken, residentToken, unit.id, 'B6');

    const uploadRes = await request(server)
      .post(`/api/v1/tickets/${ticket.id}/attachments`)
      .set('Authorization', `Bearer ${residentToken}`)
      .field('attachmentType', 'ISSUE')
      .attach('file', JPEG_FIXTURE, 'foto.jpg')
      .expect(HttpStatus.CREATED);

    const row = await prisma.ticketAttachment.findUniqueOrThrow({ where: { id: uploadRes.body.id } });
    expect(existsSync(path.join(localPath, row.storageKey))).toBe(true);
    expect(row.storageKey.startsWith('attachments/')).toBe(true);
  }, 60000);
});
