import { ContractExpiringScanJob } from './contract-expiring-scan.job';

function buildJob(overrides: { backgroundJobsEnabled?: boolean; leadDays?: number } = {}) {
  const configValues: Record<string, unknown> = {
    'backgroundJobs.enabled': overrides.backgroundJobsEnabled ?? true,
    'contracts.expiryLeadDays': overrides.leadDays ?? 30,
  };
  const config = { getOrThrow: jest.fn((key: string) => configValues[key]) };
  const schedulerRegistry = {
    addCronJob: jest.fn(),
    deleteCronJob: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
    getCronJob: jest.fn().mockReturnValue({ stop: jest.fn() }),
  };
  const contractRepo = {
    findExpiringSoonAcrossSites: jest.fn().mockResolvedValue([]),
  };
  const contractService = {
    markExpiringNotifiedBySystem: jest.fn().mockResolvedValue(null),
  };
  const prisma = {};

  const job = new ContractExpiringScanJob(
    prisma as never,
    config as never,
    schedulerRegistry as never,
    contractRepo as never,
    contractService as never,
  );

  return { job, config, schedulerRegistry, contractRepo, contractService };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contract-1',
    siteId: 'site-1',
    contractNumber: 'CNT-2026-000001',
    endDate: new Date('2026-08-15T00:00:00Z'),
    ...overrides,
  };
}

describe('ContractExpiringScanJob.runOnce', () => {
  it('her aday icin markExpiringNotifiedBySystem(id, siteId, leadDays) cagirir', async () => {
    const { job, contractRepo, contractService } = buildJob({ leadDays: 30 });
    contractRepo.findExpiringSoonAcrossSites.mockResolvedValueOnce([
      candidate({ id: 'contract-1', siteId: 'site-1' }),
      candidate({ id: 'contract-2', siteId: 'site-2' }),
    ]);

    await job.runOnce();

    expect(contractService.markExpiringNotifiedBySystem).toHaveBeenCalledWith(
      'contract-1',
      'site-1',
      30,
    );
    expect(contractService.markExpiringNotifiedBySystem).toHaveBeenCalledWith(
      'contract-2',
      'site-2',
      30,
    );
  });

  it('config.contracts.expiryLeadDays her runOnce cagrisinda tekrar okunur', async () => {
    const { job, config } = buildJob({ leadDays: 45 });
    await job.runOnce();
    expect(config.getOrThrow).toHaveBeenCalledWith('contracts.expiryLeadDays');
  });

  it('bir turda donen aday sayisi CHUNK_LIMIT (200) altindaysa dongu tek turda sonlanir', async () => {
    const { job, contractRepo } = buildJob();
    contractRepo.findExpiringSoonAcrossSites.mockResolvedValueOnce([candidate()]);

    await job.runOnce();

    expect(contractRepo.findExpiringSoonAcrossSites).toHaveBeenCalledTimes(1);
  });

  it('bir tur tam CHUNK_LIMIT (200) doner, ikinci tur tukenene kadar tekrar sorgular', async () => {
    const { job, contractRepo } = buildJob();
    const fullChunk = Array.from({ length: 200 }, (_, i) => candidate({ id: `contract-${i}` }));
    contractRepo.findExpiringSoonAcrossSites
      .mockResolvedValueOnce(fullChunk)
      .mockResolvedValueOnce([]);

    await job.runOnce();

    expect(contractRepo.findExpiringSoonAcrossSites).toHaveBeenCalledTimes(2);
  });

  it('bir adayin markExpiringNotifiedBySystem hatasi diger adaylarin islenmesini durdurmaz', async () => {
    const { job, contractRepo, contractService } = buildJob();
    contractRepo.findExpiringSoonAcrossSites.mockResolvedValueOnce([
      candidate({ id: 'contract-bad', siteId: 'site-1' }),
      candidate({ id: 'contract-good', siteId: 'site-1' }),
    ]);
    contractService.markExpiringNotifiedBySystem.mockImplementation(async (id: string) => {
      if (id === 'contract-bad') throw new Error('DB baglanti hatasi');
      return null;
    });

    await expect(job.runOnce()).resolves.toBeUndefined();

    expect(contractService.markExpiringNotifiedBySystem).toHaveBeenCalledWith(
      'contract-bad',
      'site-1',
      30,
    );
    expect(contractService.markExpiringNotifiedBySystem).toHaveBeenCalledWith(
      'contract-good',
      'site-1',
      30,
    );
  });

  it('markExpiringNotifiedBySystem null donerse (pencere disi/zaten bildirilmis) hatasiz devam eder', async () => {
    const { job, contractRepo, contractService } = buildJob();
    contractRepo.findExpiringSoonAcrossSites.mockResolvedValueOnce([candidate()]);
    contractService.markExpiringNotifiedBySystem.mockResolvedValue(null);

    await expect(job.runOnce()).resolves.toBeUndefined();
  });

  it('aday sorgusu utcToday() ve leadDays ile cagrilir', async () => {
    const { job, contractRepo } = buildJob({ leadDays: 30 });
    await job.runOnce();

    const callArg = contractRepo.findExpiringSoonAcrossSites.mock.calls[0][1];
    expect(callArg.today).toBeInstanceOf(Date);
    expect(callArg.leadDays).toBe(30);
    expect(callArg.limit).toBe(200);
  });
});

describe('ContractExpiringScanJob lifecycle (onModuleInit / onModuleDestroy)', () => {
  it('backgroundJobs.enabled=true: onModuleInit cron kaydeder', () => {
    const { job, schedulerRegistry } = buildJob();

    job.onModuleInit();

    expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
      'contract-expiring-scan',
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

    expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('contract-expiring-scan');
  });

  it('onModuleDestroy: cron hic kayitli degilse deleteCronJob cagrilmaz', async () => {
    const { job, schedulerRegistry } = buildJob();
    schedulerRegistry.doesExist.mockReturnValue(false);

    await job.onModuleDestroy();

    expect(schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
  });
});
