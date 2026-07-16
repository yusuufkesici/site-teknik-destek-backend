import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../integration/setup/postgres-testcontainer';
import { CapturingSmsProvider } from './support/capturing-sms.provider';

// Onaylanan docs/phase-8-plan.md Bolum 3.1/10: acil ticket olustur -> outbox
// event -> OutboxRelay.pollOnce() (fan-out) -> notification_deliveries ->
// NotificationDeliveryRelay.pollOnce() -> gercek SmsProvider cagrisi zinciri
// uctan uca, gercek HTTP + gercek Postgres uzerinden dogrulanir. Zamanlayici
// tick'leri beklenmez - testler ilgili relay metotlarini DOGRUDAN cagirir
// (plan Bolum 10.1: test ortaminda flaky zamanlama riski istenmez).
describe('Notifications E2E (tam uygulama + Testcontainers)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let smsProvider: CapturingSmsProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outboxRelay: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deliveryRelay: any;
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
    const { OutboxRelay } = await import('../../src/modules/notifications/outbox-relay.service');
    const { NotificationDeliveryRelay } = await import(
      '../../src/modules/notifications/notification-delivery-relay.service'
    );

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
    outboxRelay = app.get(OutboxRelay);
    deliveryRelay = app.get(NotificationDeliveryRelay);
    server = app.getHttpServer();
  }, 60000);

  afterEach(async () => {
    await app.close();
  });

  function randomPhone(prefix: string): string {
    return `+9055${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  async function loginViaOtp(phone: string): Promise<{ accessToken: string }> {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phoneNumber: phone })
      .expect(HttpStatus.OK);
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

  async function getOpsUserId(opsToken: string): Promise<string> {
    const res = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(HttpStatus.OK);
    return res.body.id;
  }

  async function createSiteWithUnit(opsToken: string, prefix: string) {
    const siteRes = await request(server)
      .post('/api/v1/facilities/sites')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: `Site ${prefix}`, code: `NT-${prefix}` })
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
    return { site: siteRes.body, unit: unitRes.body };
  }

  async function createActiveContract(siteId: string, createdByUserId: string, prefix: string) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    return prisma.contract.create({
      data: {
        siteId,
        contractNumber: `NT-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
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

  async function onboardResidentAndLogin(
    opsToken: string,
    siteId: string,
    unitId: string,
    prefix: string,
  ) {
    const phone = randomPhone(prefix);
    await request(server)
      .post(`/api/v1/sites/${siteId}/residents`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ phoneNumber: phone, firstName: 'Sakin', lastName: 'Bir', unitId })
      .expect(HttpStatus.CREATED);
    return loginViaOtp(phone);
  }

  it('EMERGENCY ticket olusturulunca outbox -> fan-out -> delivery -> gercek SmsProvider zinciri uctan uca calisir', async () => {
    const { accessToken: opsToken } = await createOperationsAndLogin('90');
    const opsUserId = await getOpsUserId(opsToken);
    const { site, unit } = await createSiteWithUnit(opsToken, 'E9');
    await createActiveContract(site.id, opsUserId, 'E9');
    const { accessToken: residentToken } = await onboardResidentAndLogin(
      opsToken,
      site.id,
      unit.id,
      '91',
    );

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

    // 1) OutboxRelay bir tick calistirir: EmergencyTicketCreated event'ini
    // claim edip fan-out yapar - notification_deliveries'e OPERATIONS
    // kullanicisi icin 1 satir yazar, kaynak event'i PROCESSED isaretler.
    await outboxRelay.pollOnce();

    const outboxRow = await prisma.outboxEvent.findFirst({
      where: { eventType: 'EmergencyTicketCreated', aggregateId: createRes.body.id },
    });
    expect(outboxRow.status).toBe('PROCESSED');

    const deliveries = await prisma.notificationDelivery.findMany({
      where: { sourceEventId: outboxRow.id },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].recipientUserId).toBe(opsUserId);
    expect(deliveries[0].smsMethod).toBe('EMERGENCY_ALERT');
    expect(deliveries[0].status).toBe('PENDING');

    // 2) NotificationDeliveryRelay bir tick calistirir: delivery satirini
    // claim edip gercek (test double) SmsProvider.sendEmergencyAlert()'i
    // cagirir.
    await deliveryRelay.pollOnce();

    const alerts = smsProvider.getEmergencyAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain('ACIL ARIZA');

    const updatedDelivery = await prisma.notificationDelivery.findUnique({
      where: { id: deliveries[0].id },
    });
    expect(updatedDelivery.status).toBe('PROCESSED');
  }, 60000);

  it('test ortaminda gercek zamanlayicilar otomatik baslamaz (NODE_ENV=test relay/delivery-relay interval kaydini engeller)', async () => {
    // configureBaseTestEnv() NODE_ENV=test set eder; config-loader bunu
    // OUTBOX_RELAY_ENABLED degerinden bagimsiz olarak otomatik
    // outboxRelay.enabled=false'a cevirir (Rev 1.1 bulgu F) - relay/delivery
    // relay OnModuleInit'te interval kaydi hic yapmaz.
    const { SchedulerRegistry } = await import('@nestjs/schedule');
    const schedulerRegistry = app.get(SchedulerRegistry);

    expect(schedulerRegistry.getIntervals()).toHaveLength(0);
  });
});
