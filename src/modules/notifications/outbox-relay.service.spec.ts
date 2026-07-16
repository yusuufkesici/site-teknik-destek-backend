import { NonRetryableDispatchError } from './errors/dispatch-error';
import { OutboxRelay } from './outbox-relay.service';

// DIKKAT: sweepExhausted() `tx.$queryRaw` uzerinden calisir ($transaction
// callback'i icinde), claimBatch() ise `prisma.$queryRaw`'i DOGRUDAN
// cagirir - ikisi FARKLI mock fonksiyonlaridir. tx.$queryRaw varsayilan
// olarak bos dizi doner (asagida), bu yuzden testlerde yalniz claim
// sonucunu prisma.$queryRaw uzerinde ayarlamak yeterlidir.
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
    outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const dispatcher = { fanOut: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const relay = new OutboxRelay(
    prisma as never,
    config as never,
    schedulerRegistry as never,
    dispatcher as never,
    audit as never,
  );

  return { relay, prisma, tx, config, schedulerRegistry, dispatcher, audit };
}

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    eventType: 'EmergencyTicketCreated',
    aggregateType: 'Ticket',
    aggregateId: 'ticket-1',
    payload: {},
    attemptCount: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

// Bir jest.fn()'in en az bir kez cagrilmasini mikrotask kuyrugunu
// ilerleterek bekler - sabit sayida `await Promise.resolve()` tahmin
// etmek yerine (ic ice await zincirinin derinligi degisebilir), gercekten
// cagrilana kadar (guvenlik siniri ile) mikrotask'lari bosaltir.
async function waitUntilCalled(fn: jest.Mock, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && fn.mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
}

describe('OutboxRelay.pollOnce - claim sorgusu', () => {
  it('claim SQL metni attempt_count artisini VE SKIP LOCKED reclaim kosulunu icerir', async () => {
    const { relay, prisma } = buildRelay();
    prisma.$queryRaw.mockResolvedValue([]);

    await relay.pollOnce();

    // $queryRaw tagged-template cagrisi: ilk arg strings dizisi.
    const claimCallStrings = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('');
    expect(claimCallStrings).toContain('attempt_count = attempt_count + 1');
    expect(claimCallStrings).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimCallStrings).toContain("status IN ('PENDING', 'PROCESSING')");
  });

  it('claim sonrasi crash senaryosu: attemptCount, dispatch SONUCUNDAN bagimsiz olarak claim SQL tarafindan zaten artirilmis halde gelir', async () => {
    const { relay, prisma, dispatcher } = buildRelay();
    // Gercek bir crash'te fanOut() hic cagrilamaz/hic sonuclanmaz - ama bu
    // durumda dahi deneme hakki zaten TUKETILMIS olur, cunku attempt_count
    // artisi claim SQL'inin kendisinde (Postgres tarafinda, atomik) olur,
    // relay'in sonradan calisan bir "sonuc-isleme" adimina bagli degildir.
    // Bunu birim testte dogrudan simule etmek (hic sonuclanmayan bir
    // promise ile) Promise.allSettled'i sonsuza dek bekletir; onun yerine
    // claim'in DONDURDUGU attemptCount'un zaten post-increment deger
    // oldugunu ve relay'in bu degere HICBIR sekilde kendi tarafinda tekrar
    // dokunmadigini (ne basaride ne hatada) dogrudan dogruluyoruz.
    prisma.$queryRaw.mockResolvedValue([claimedRow({ attemptCount: 4 })]);
    dispatcher.fanOut.mockResolvedValue(undefined);

    await relay.pollOnce();

    expect(dispatcher.fanOut).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 4 }));
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });
});

describe('OutboxRelay.pollOnce - sonuc isleme', () => {
  it('basari: fanOut() basariyla donerse relay HICBIR ek yazma yapmaz (PROCESSED zaten fanOut transaction inda yazildi)', async () => {
    const { relay, prisma, dispatcher, tx } = buildRelay();
    prisma.$queryRaw.mockResolvedValue([claimedRow()]);
    dispatcher.fanOut.mockResolvedValue(undefined);

    await relay.pollOnce();

    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('NonRetryableDispatchError: kalan deneme hakki olsa bile dogrudan FAILED + failedAt, audit NON_RETRYABLE_PAYLOAD ile yazilir', async () => {
    const { relay, prisma, dispatcher, tx, audit } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedRow({ attemptCount: 1 })]); // butce cok var
    dispatcher.fanOut.mockRejectedValue(new NonRetryableDispatchError('payload gecersiz'));

    await relay.pollOnce();

    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'FAILED', nextAttemptAt: null }),
    });
    const updateData = tx.outboxEvent.updateMany.mock.calls[0][0].data;
    expect(updateData.failedAt).toBeInstanceOf(Date);
    expect(updateData).not.toHaveProperty('processedAt');
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'NON_RETRYABLE_PAYLOAD' }),
      }),
    );
  });

  it('retryable hata + butce kaldi: PENDING + nextAttemptAt ileri bir zamana ayarlanir, processedAt/failedAt yazilmaz', async () => {
    const { relay, prisma, dispatcher } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedRow({ attemptCount: 3 })]);
    dispatcher.fanOut.mockRejectedValue(new Error('SMS saglayici zaman asimi'));

    const before = Date.now();
    await relay.pollOnce();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'PENDING' }),
    });
    const updateData = prisma.outboxEvent.updateMany.mock.calls[0][0].data;
    expect(updateData.nextAttemptAt).toBeInstanceOf(Date);
    expect(updateData.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updateData).not.toHaveProperty('failedAt');
  });

  it('retryable hata + butce tukendi (attemptCount >= maxAttempts): FAILED + failedAt yazilir (processedAt DEGIL)', async () => {
    const { relay, prisma, dispatcher, tx } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedRow({ attemptCount: 10 })]); // son deneme
    dispatcher.fanOut.mockRejectedValue(new Error('kalici hata'));

    await relay.pollOnce();

    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    const updateData = tx.outboxEvent.updateMany.mock.calls[0][0].data;
    expect(updateData.failedAt).toBeInstanceOf(Date);
    expect(updateData).not.toHaveProperty('processedAt');
  });

  it('bir batch icindeki bir satirin hatasi digerlerini durdurmaz (Promise.allSettled)', async () => {
    const { relay, prisma, dispatcher } = buildRelay({ maxAttempts: 10 });
    const rowA = claimedRow({ id: 'event-a', attemptCount: 1 });
    const rowB = claimedRow({ id: 'event-b', attemptCount: 1 });
    prisma.$queryRaw.mockResolvedValue([rowA, rowB]);
    dispatcher.fanOut.mockImplementation(async (row: unknown) => {
      if ((row as { id: string }).id === 'event-a') throw new Error('event-a basarisiz');
    });

    await relay.pollOnce();

    expect(dispatcher.fanOut).toHaveBeenCalledTimes(2);
    expect(dispatcher.fanOut).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-a' }));
    expect(dispatcher.fanOut).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-b' }));
    // event-b basarili oldugu icin relay tarafindan hic guncellenmemeli.
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'event-a', status: 'PROCESSING' } }),
    );
  });

  // Pre-commit denetimi bulgusu: iki eszamanli fanOut() cagrisindan
  // kaybeden taraf unique-constraint hatasiyla reddedilir, ama kazanan
  // taraf satiri ZATEN PROCESSED yapmis olabilir. status='PROCESSING'
  // sartli updateMany bu durumda 0 satir gunceller (count=0) - relay bunu
  // "baskasi zaten sonuclandirmis" olarak yorumlamali, HATA/audit
  // uretmemeli ve zaten-basarili satiri PENDING/FAILED'e cekmemelidir.
  it('kaybeden taraf: satir baska bir worker tarafindan zaten PROCESSED yapilmissa (updateMany count=0), audit YAZILMAZ ve hata yutulur', async () => {
    const { relay, prisma, dispatcher, tx, audit } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedRow({ attemptCount: 10 })]); // son deneme dali (FAILED yolu)
    tx.outboxEvent.updateMany.mockResolvedValue({ count: 0 }); // kazanan taraf zaten PROCESSED yapti
    dispatcher.fanOut.mockRejectedValue(new Error('unique constraint ihlali (P2002 benzeri)'));

    await expect(relay.pollOnce()).resolves.toBeUndefined();

    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    // count=0 oldugu icin audit YAZILMAMALI - satir gercekte FAILED olmadi.
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('kaybeden taraf (retryable/PENDING dali): count=0 donerse sessizce gecilir, hata firlatilmaz', async () => {
    const { relay, prisma, dispatcher } = buildRelay({ maxAttempts: 10 });
    prisma.$queryRaw.mockResolvedValue([claimedRow({ attemptCount: 2 })]);
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    dispatcher.fanOut.mockRejectedValue(new Error('unique constraint ihlali'));

    await expect(relay.pollOnce()).resolves.toBeUndefined();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'event-1', status: 'PROCESSING' } }),
    );
  });
});

describe('OutboxRelay.pollOnce - sweep', () => {
  it('claim aninda butcesi tukenmis satirlar sweep ile FAILED e cekilir ve her biri icin audit yazilir', async () => {
    const { relay, prisma, tx, audit } = buildRelay({ maxAttempts: 10 });
    tx.$queryRaw.mockResolvedValueOnce([
      {
        id: 'stuck-1',
        eventType: 'TechnicianAssigned',
        aggregateType: 'Assignment',
        aggregateId: 'a-1',
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]); // sweep sonrasi claim - bos

    await relay.pollOnce();

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sweepStrings = (tx.$queryRaw.mock.calls[0][0] as string[]).join('');
    expect(sweepStrings).toContain("status = 'FAILED'");
    expect(sweepStrings).toContain('attempt_count >= ');
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'OUTBOX_EVENT_FAILED',
        entityType: 'Assignment',
        entityId: 'a-1',
        metadata: expect.objectContaining({ reason: 'MAX_ATTEMPTS_REACHED_AT_CLAIM' }),
      }),
    );
  });
});

describe('OutboxRelay lifecycle (onModuleInit / onModuleDestroy)', () => {
  it('enabled=true: onModuleInit interval kaydeder', () => {
    const { relay, schedulerRegistry } = buildRelay();

    relay.onModuleInit();

    expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
      'outbox-relay-poll',
      expect.anything(),
    );
    // onModuleInit gercek (mock'lanmamis) global setInterval'i kullanir -
    // schedulerRegistry yalniz mock oldugundan (deleteInterval gercek
    // clearInterval'i tetiklemez), test surecinin acik biraktigi gercek
    // zamanlayiciyi burada elle temizliyoruz.
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

    expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith('outbox-relay-poll');
  });

  it('onModuleDestroy: interval hic kayitli degilse (ör. baslangicta devre disiydi) deleteInterval cagirmaz', async () => {
    const { relay, schedulerRegistry } = buildRelay();
    schedulerRegistry.doesExist.mockReturnValue(false);

    await relay.onModuleDestroy();

    expect(schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
  });

  it('onModuleDestroy: devam eden bir pollOnce() tamamlanana kadar BEKLER (yeni claim baslamaz, mevcut is yarida kesilmez)', async () => {
    const { relay, prisma, dispatcher, schedulerRegistry } = buildRelay();
    let resolveFanOut!: () => void;
    dispatcher.fanOut.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFanOut = resolve;
        }),
    );
    prisma.$queryRaw.mockResolvedValue([claimedRow()]);
    schedulerRegistry.doesExist.mockReturnValue(true);

    // scheduleTick private'tir - gercek interval-tetiklemeli davranisi
    // (isPolling guard + currentPoll atamasi) test etmek icin dogrudan
    // cagrilir (TS private'ligi yalniz derleme-zamaninda gecerlidir).

    (relay as unknown as { scheduleTick: () => void }).scheduleTick();
    await waitUntilCalled(dispatcher.fanOut);

    let destroyResolved = false;
    const destroyPromise = relay.onModuleDestroy().then(() => {
      destroyResolved = true;
    });

    // deleteInterval SENKRON/HEMEN cagrilmis olmali - yeni tick artik
    // planlanamaz - ama devam eden pollOnce() henuz bitmedi.
    expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith('outbox-relay-poll');
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyResolved).toBe(false);

    resolveFanOut();
    await destroyPromise;

    expect(destroyResolved).toBe(true);
  });
});
