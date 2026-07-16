import { InvoiceOverdueScanJob } from './invoice-overdue-scan.job';

function buildJob(overrides: { backgroundJobsEnabled?: boolean } = {}) {
  const configValues: Record<string, unknown> = {
    'backgroundJobs.enabled': overrides.backgroundJobsEnabled ?? true,
  };
  const config = { getOrThrow: jest.fn((key: string) => configValues[key]) };
  const schedulerRegistry = {
    addCronJob: jest.fn(),
    deleteCronJob: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
    getCronJob: jest.fn().mockReturnValue({ stop: jest.fn() }),
  };
  const invoiceRepo = {
    findOverdueCandidatesAcrossSites: jest.fn().mockResolvedValue([]),
  };
  const invoiceService = {
    markOverdueBySystem: jest.fn().mockResolvedValue(null),
  };
  const prisma = {};

  const job = new InvoiceOverdueScanJob(
    prisma as never,
    config as never,
    schedulerRegistry as never,
    invoiceRepo as never,
    invoiceService as never,
  );

  return { job, config, schedulerRegistry, invoiceRepo, invoiceService };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return { id: 'invoice-1', siteId: 'site-1', contractId: 'contract-1', ...overrides };
}

describe('InvoiceOverdueScanJob.runOnce', () => {
  it('her aday icin markOverdueBySystem(id, siteId) cagirir', async () => {
    const { job, invoiceRepo, invoiceService } = buildJob();
    invoiceRepo.findOverdueCandidatesAcrossSites.mockResolvedValueOnce([
      candidate({ id: 'invoice-1', siteId: 'site-1' }),
      candidate({ id: 'invoice-2', siteId: 'site-2' }),
    ]);

    await job.runOnce();

    expect(invoiceService.markOverdueBySystem).toHaveBeenCalledWith('invoice-1', 'site-1');
    expect(invoiceService.markOverdueBySystem).toHaveBeenCalledWith('invoice-2', 'site-2');
  });

  it('bir turda donen aday sayisi CHUNK_LIMIT (200) altindaysa dongu tek turda sonlanir', async () => {
    const { job, invoiceRepo } = buildJob();
    invoiceRepo.findOverdueCandidatesAcrossSites.mockResolvedValueOnce([candidate()]);

    await job.runOnce();

    expect(invoiceRepo.findOverdueCandidatesAcrossSites).toHaveBeenCalledTimes(1);
  });

  it('bir tur tam CHUNK_LIMIT (200) doner, ikinci tur tukenene kadar tekrar sorgular', async () => {
    const { job, invoiceRepo } = buildJob();
    const fullChunk = Array.from({ length: 200 }, (_, i) => candidate({ id: `invoice-${i}` }));
    invoiceRepo.findOverdueCandidatesAcrossSites
      .mockResolvedValueOnce(fullChunk)
      .mockResolvedValueOnce([]);

    await job.runOnce();

    expect(invoiceRepo.findOverdueCandidatesAcrossSites).toHaveBeenCalledTimes(2);
  });

  it('bir adayin markOverdueBySystem hatasi diger adaylarin islenmesini durdurmaz', async () => {
    const { job, invoiceRepo, invoiceService } = buildJob();
    invoiceRepo.findOverdueCandidatesAcrossSites.mockResolvedValueOnce([
      candidate({ id: 'invoice-bad', siteId: 'site-1' }),
      candidate({ id: 'invoice-good', siteId: 'site-1' }),
    ]);
    invoiceService.markOverdueBySystem.mockImplementation(async (id: string) => {
      if (id === 'invoice-bad') throw new Error('DB baglanti hatasi');
      return null;
    });

    await expect(job.runOnce()).resolves.toBeUndefined();

    expect(invoiceService.markOverdueBySystem).toHaveBeenCalledWith('invoice-bad', 'site-1');
    expect(invoiceService.markOverdueBySystem).toHaveBeenCalledWith('invoice-good', 'site-1');
  });

  it('markOverdueBySystem null donerse (baska worker/actor zaten cozmus) hatasiz devam eder', async () => {
    const { job, invoiceRepo, invoiceService } = buildJob();
    invoiceRepo.findOverdueCandidatesAcrossSites.mockResolvedValueOnce([candidate()]);
    invoiceService.markOverdueBySystem.mockResolvedValue(null);

    await expect(job.runOnce()).resolves.toBeUndefined();
  });

  it('aday sorgusu utcToday() ile bugunku UTC tarihini gonderir', async () => {
    const { job, invoiceRepo } = buildJob();
    await job.runOnce();

    const callArg = invoiceRepo.findOverdueCandidatesAcrossSites.mock.calls[0][1];
    expect(callArg.today).toBeInstanceOf(Date);
    expect(callArg.limit).toBe(200);
  });
});

describe('InvoiceOverdueScanJob lifecycle (onModuleInit / onModuleDestroy)', () => {
  it('backgroundJobs.enabled=true: onModuleInit cron kaydeder', () => {
    const { job, schedulerRegistry } = buildJob();

    job.onModuleInit();

    expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
      'invoice-overdue-scan',
      expect.anything(),
    );
    // onModuleInit gercek (mock'lanmamis) cron.CronJob'u kullanir -
    // schedulerRegistry yalniz mock oldugundan test surecinin acik
    // biraktigi gercek zamanlayiciyi burada elle durduruyoruz.
    (schedulerRegistry.addCronJob.mock.calls[0][1] as { stop: () => void }).stop();
  });

  it('backgroundJobs.enabled=false: onModuleInit HICBIR cron kaydetmez', () => {
    const { job, schedulerRegistry } = buildJob({ backgroundJobsEnabled: false });

    job.onModuleInit();

    expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
  });

  it('onModuleDestroy: cron kayitliysa durdurur ve kaydini siler', async () => {
    const { job, schedulerRegistry } = buildJob();
    schedulerRegistry.doesExist.mockReturnValue(true);

    await job.onModuleDestroy();

    expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('invoice-overdue-scan');
  });

  it('onModuleDestroy: cron hic kayitli degilse deleteCronJob cagrilmaz', async () => {
    const { job, schedulerRegistry } = buildJob();
    schedulerRegistry.doesExist.mockReturnValue(false);

    await job.onModuleDestroy();

    expect(schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
  });
});
