import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan docs/phase-8-plan.md Bolum 3.1/6.2: fan-out'un EXACTLY-ONCE
// olma garantisi - N delivery satiri + kaynak event PROCESSED tek
// transaction'da yazilir. Bu, gercek Postgres transaction/unique
// constraint davranisina dayandigindan mock'la test edilemez.
describe('NotificationDispatcher.fanOut atomikligi (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatcher: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { NotificationDispatcher } = await import(
      '../../../src/modules/notifications/notification-dispatcher.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    dispatcher = app.get(NotificationDispatcher);

    await prisma.user.create({
      data: {
        phoneNumber: '+905557778001',
        firstName: 'Ops',
        lastName: 'FanoutTest',
        role: 'OPERATIONS',
      },
    });
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  async function insertEmergencyEvent() {
    return prisma.outboxEvent.create({
      data: {
        eventType: 'EmergencyTicketCreated',
        aggregateType: 'Ticket',
        aggregateId: '11111111-1111-4111-8111-111111111111',
        payload: {
          ticketId: '11111111-1111-4111-8111-111111111111',
          ticketCode: 'TKT-2026-000002',
          siteId: '22222222-2222-4222-8222-222222222222',
          facilityId: '33333333-3333-4333-8333-333333333333',
          category: 'ELECTRICAL',
          urgency: 'EMERGENCY',
          createdByUserId: '44444444-4444-4444-8444-444444444444',
        },
      },
    });
  }

  it('ayni event icin iki eszamanli fanOut() cagrisi: yalniz biri basarili olur, delivery satiri MUKERRER OLUSMAZ', async () => {
    const event = await insertEmergencyEvent();

    const results = await Promise.allSettled([dispatcher.fanOut(event), dispatcher.fanOut(event)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Unique constraint (source_event_id, recipient_phone, channel) ikinci
    // transaction'in INSERT'ini reddeder, o transaction TAMAMEN geri alinir.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const deliveries = await prisma.notificationDelivery.findMany({
      where: { sourceEventId: event.id },
    });
    expect(deliveries).toHaveLength(1);

    const updatedEvent = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(updatedEvent.status).toBe('PROCESSED');
  });

  it('fan-out basariyla tamamlaninca kaynak event PROCESSED, delivery PENDING olarak baslar (henuz SMS gonderilmedi)', async () => {
    const event = await insertEmergencyEvent();

    await dispatcher.fanOut(event);

    const updatedEvent = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
    expect(updatedEvent.status).toBe('PROCESSED');
    expect(updatedEvent.processedAt).not.toBeNull();

    const deliveries = await prisma.notificationDelivery.findMany({
      where: { sourceEventId: event.id },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('PENDING');
    expect(deliveries[0].recipientPhone).toBe('+905557778001');
    expect(deliveries[0].channel).toBe('SMS');
    expect(deliveries[0].smsMethod).toBe('EMERGENCY_ALERT');
  });

  it('TechnicianAssigned: teknisyen bulunamazsa (telefonu olmayan/var olmayan alici) event PROCESSED olur ama hic delivery olusmaz', async () => {
    const created = await prisma.outboxEvent.create({
      data: {
        eventType: 'TechnicianAssigned',
        aggregateType: 'Assignment',
        aggregateId: '55555555-5555-4555-8555-555555555555',
        payload: {
          ticketId: '11111111-1111-4111-8111-111111111111',
          assignmentId: '55555555-5555-4555-8555-555555555555',
          technicianId: '99999999-9999-4999-8999-999999999999',
          reassigned: false,
        },
      },
    });

    await dispatcher.fanOut(created);

    const updatedEvent = await prisma.outboxEvent.findUnique({ where: { id: created.id } });
    expect(updatedEvent.status).toBe('PROCESSED');
    const deliveries = await prisma.notificationDelivery.findMany({
      where: { sourceEventId: created.id },
    });
    expect(deliveries).toHaveLength(0);
  });
});
