import { NotificationDeliveryRelay } from './notification-delivery-relay.service';

function buildRelay(overrides: { maxAttempts?: number; enabled?: boolean } = {}) {
  const maxAttempts = overrides.maxAttempts ?? 10;
  const configValues: Record<string, unknown> = {
    'outboxRelay.pollIntervalMs': 5000,
    'outboxRelay.batchSize': 20,
    'outboxRelay.maxAttempts': maxAttempts,
    'outboxRelay.claimLeaseMs': 60000,
    'outboxRelay.enabled': overrides.enabled ?? true,
  };
  const config = { getOrThrow: jest.fn((key: string) => configValues[key]) };
  const schedulerRegistry = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    notificationDelivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    notificationDelivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const sms = {
    sendOtp: jest.fn().mockResolvedValue(undefined),
    sendTicketNotification: jest.fn().mockResolvedValue(undefined),
    sendEmergencyAlert: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const relay = new NotificationDeliveryRelay(
    prisma as never,
    config as never,
    schedulerRegistry as never,
    sms as never,
    audit as never,
  );

  return { relay, prisma, tx, sms, audit, schedulerRegistry };
}

function claimedDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    sourceEventId: 'event-1',
    sourceEventType: 'EmergencyTicketCreated',
    smsMethod: 'EMERGENCY_ALERT',
    recipientPhone: '+905551110001',
    message: 'ACIL ARIZA: Ticket TKT-1',
    attemptCount: 1,
    ...overrides,
  };
}

async function waitUntilCalled(fn: jest.Mock, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && fn.mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
}

describe('NotificationDeliveryRelay.pollOnce', () => {
  it('smsMethod=EMERGENCY_ALERT icin sendEmergencyAlert cagirir, basari sonrasi PROCESSED yazar', async () => {
    const { relay, prisma, sms } = buildRelay();
    prisma.$queryRaw.mockResolvedValue([claimedDelivery()]);

    await relay.pollOnce();

    expect(sms.sendEmergencyAlert).toHaveBeenCalledWith(
      '+905551110001',
      'ACIL ARIZA: Ticket TKT-1',
    );
    expect(sms.sendTicketNotification).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'PROCESSED', lastError: null }),
    });
  });

  it('smsMethod=TICKET_NOTIFICATION icin sendTicketNotification cagirir', async () => {
    const { relay, prisma, sms } = buildRelay();
    prisma.$queryRaw.mockResolvedValue([
      claimedDelivery({ smsMethod: 'TICKET_NOTIFICATION', message: 'Yeni is atamasi' }),
    ]);

    await relay.pollOnce();

    expect(sms.sendTicketNotification).toHaveBeenCalledWith('+905551110001', 'Yeni is atamasi');
    expect(sms.sendEmergencyAlert).not.toHaveBeenCalled();
  });

  it('SMS provider hatasinda + butce kaldiginda delivery PENDING durumuna doner (retry)', async () => {
    const { relay, prisma, sms } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedDelivery({ attemptCount: 2 })]);
    sms.sendEmergencyAlert.mockRejectedValue(new Error('saglayici zaman asimi'));

    await relay.pollOnce();

    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'PENDING' }),
    });
    const updateData = prisma.notificationDelivery.updateMany.mock.calls[0][0].data;
    expect(updateData.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('SMS provider hatasinda + butce tukendiginde FAILED + failedAt yazilir, audit NOTIFICATION_DELIVERY_FAILED ile', async () => {
    const { relay, prisma, tx, sms, audit } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedDelivery({ attemptCount: 10 })]);
    sms.sendEmergencyAlert.mockRejectedValue(new Error('kalici hata'));

    await relay.pollOnce();

    expect(tx.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    const updateData = tx.notificationDelivery.updateMany.mock.calls[0][0].data;
    expect(updateData.failedAt).toBeInstanceOf(Date);
    expect(updateData).not.toHaveProperty('processedAt');
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'NOTIFICATION_DELIVERY_FAILED' }),
    );
  });

  it('iki claim edilen satirdan biri basarisiz olsa digeri (basarili) PROCESSED olarak kalir - biri diğerini durdurmaz', async () => {
    const { relay, prisma, sms } = buildRelay({ maxAttempts: 10 });
    const rowA = claimedDelivery({ id: 'delivery-a', recipientPhone: '+905551110001' });
    const rowB = claimedDelivery({ id: 'delivery-b', recipientPhone: '+905551110002' });
    prisma.$queryRaw.mockResolvedValue([rowA, rowB]);
    sms.sendEmergencyAlert.mockImplementation(async (phone: string) => {
      if (phone === '+905551110001') throw new Error('delivery-a basarisiz');
    });

    await relay.pollOnce();

    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery-b', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    );
    // delivery-a basarisiz oldugu icin PENDING/FAILED yoluna gitti, PROCESSED olmadi.
    expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery-a', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    );
  });

  it('claim SQL metni attempt_count artisini ve SKIP LOCKED kosulunu icerir', async () => {
    const { relay, prisma } = buildRelay();
    prisma.$queryRaw.mockResolvedValue([]);

    await relay.pollOnce();

    const claimStrings = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('');
    expect(claimStrings).toContain('attempt_count = attempt_count + 1');
    expect(claimStrings).toContain('FOR UPDATE SKIP LOCKED');
  });

  // Pre-commit denetimi bulgusu: iki worker (lease-expiry reclaim yarisi)
  // ayni satiri isleyebilir. status='PROCESSING' sartli updateMany, kaybeden
  // tarafin yazisini count=0 ile sessizce iptal eder - kazananin sonucunun
  // uzerine yazilmaz, hata/audit uretilmez.
  it('kaybeden taraf: satir baska worker tarafindan zaten sonuclandirilmissa (updateMany count=0), uzerine yazilmaz', async () => {
    const { relay, prisma, tx, sms, audit } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedDelivery({ attemptCount: 10 })]);
    tx.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
    sms.sendEmergencyAlert.mockRejectedValue(new Error('kalici hata'));

    await expect(relay.pollOnce()).resolves.toBeUndefined();

    expect(tx.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('NotificationDeliveryRelay lifecycle (onModuleInit / onModuleDestroy)', () => {
  it('enabled=true: onModuleInit interval kaydeder', () => {
    const { relay, schedulerRegistry } = buildRelay();

    relay.onModuleInit();

    expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
      'notification-delivery-relay-poll',
      expect.anything(),
    );
    clearInterval(schedulerRegistry.addInterval.mock.calls[0][1] as NodeJS.Timeout);
  });

  it('enabled=false: onModuleInit HICBIR interval kaydetmez', () => {
    const { relay, schedulerRegistry } = buildRelay({ enabled: false });

    relay.onModuleInit();

    expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
  });

  it('onModuleDestroy: interval kayitliysa deleteInterval cagirir', async () => {
    const { relay, schedulerRegistry } = buildRelay();
    schedulerRegistry.doesExist.mockReturnValue(true);

    await relay.onModuleDestroy();

    expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith(
      'notification-delivery-relay-poll',
    );
  });

  it('onModuleDestroy: interval hic kayitli degilse deleteInterval cagirmaz', async () => {
    const { relay, schedulerRegistry } = buildRelay();
    schedulerRegistry.doesExist.mockReturnValue(false);

    await relay.onModuleDestroy();

    expect(schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
  });

  it('onModuleDestroy: devam eden bir pollOnce() tamamlanana kadar BEKLER', async () => {
    const { relay, prisma, sms, schedulerRegistry } = buildRelay();
    let resolveSend!: () => void;
    sms.sendEmergencyAlert.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    prisma.$queryRaw.mockResolvedValue([claimedDelivery()]);
    schedulerRegistry.doesExist.mockReturnValue(true);

    (relay as unknown as { scheduleTick: () => void }).scheduleTick();
    await waitUntilCalled(sms.sendEmergencyAlert);

    let destroyResolved = false;
    const destroyPromise = relay.onModuleDestroy().then(() => {
      destroyResolved = true;
    });

    expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith(
      'notification-delivery-relay-poll',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyResolved).toBe(false);

    resolveSend();
    await destroyPromise;

    expect(destroyResolved).toBe(true);
  });
});
