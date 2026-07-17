import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan docs/phase-8-plan.md Bolum 5.1/5.3/9: FOR UPDATE SKIP LOCKED
// claim'inin ve lease-tabanli reclaim'in gercek PostgreSQL uzerinde
// dogrulanmasi - bu davranis mock'la test edilemez (SKIP LOCKED semantigi
// gercek satir kilitlenmesine dayanir).
describe('OutboxRelay claim/reclaim (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let relay: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatcher: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { OutboxRelay } = await import('../../../src/modules/notifications/outbox-relay.service');
    const { NotificationDispatcher } = await import(
      '../../../src/modules/notifications/notification-dispatcher.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    dispatcher = app.get(NotificationDispatcher);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  async function insertEmergencyEvent(status: 'PENDING' | 'PROCESSING' = 'PENDING'): Promise<string> {
    const created = await prisma.outboxEvent.create({
      data: {
        eventType: 'EmergencyTicketCreated',
        aggregateType: 'Ticket',
        aggregateId: '11111111-1111-4111-8111-111111111111',
        payload: {
          ticketId: '11111111-1111-4111-8111-111111111111',
          ticketCode: 'TKT-2026-000001',
          siteId: '22222222-2222-4222-8222-222222222222',
          facilityId: '33333333-3333-4333-8333-333333333333',
          category: 'PLUMBING',
          urgency: 'EMERGENCY',
          createdByUserId: '44444444-4444-4444-8444-444444444444',
        },
        status,
      },
    });
    return created.id;
  }

  it('iki eszamanli pollOnce() cagrisi ayni satiri asla iki kez claim etmez (FOR UPDATE SKIP LOCKED)', async () => {
    await insertEmergencyEvent();
    const fanOutSpy = jest.spyOn(dispatcher, 'fanOut');
    fanOutSpy.mockClear();

    await Promise.all([relay.pollOnce(), relay.pollOnce()]);

    // Satir yalniz bir kez claim edilip dispatch edilmis olmali - iki
    // pollOnce() ayni satiri paylasamaz.
    expect(fanOutSpy).toHaveBeenCalledTimes(1);
  });

  it('lease suresi dolmamis PROCESSING satir reclaim EDILMEZ', async () => {
    const id = await insertEmergencyEvent('PROCESSING');
    await prisma.outboxEvent.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) }, // gelecekte - lease hala gecerli
    });
    const fanOutSpy = jest.spyOn(dispatcher, 'fanOut');
    fanOutSpy.mockClear();

    await relay.pollOnce();

    expect(fanOutSpy).not.toHaveBeenCalled();
    const row = await prisma.outboxEvent.findUnique({ where: { id } });
    expect(row.status).toBe('PROCESSING');
  });

  it('lease suresi dolmus PROCESSING satir reclaim EDILIR', async () => {
    const id = await insertEmergencyEvent('PROCESSING');
    await prisma.outboxEvent.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 60_000) }, // gecmiste - lease dolmus
    });
    const fanOutSpy = jest.spyOn(dispatcher, 'fanOut');
    fanOutSpy.mockClear();

    await relay.pollOnce();

    expect(fanOutSpy).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it('eski Faz 4-7 backlog kaydi (bu testte: zaten PROCESSED bir satir) yeniden claim edilip SMS uretmez', async () => {
    const id = await insertEmergencyEvent();
    await prisma.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    const fanOutSpy = jest.spyOn(dispatcher, 'fanOut');
    fanOutSpy.mockClear();

    await relay.pollOnce();

    expect(fanOutSpy).not.toHaveBeenCalledWith(expect.objectContaining({ id }));
  });
});
