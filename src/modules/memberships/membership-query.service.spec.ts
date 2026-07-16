import { MembershipQueryService } from './membership-query.service';

function buildService() {
  const prisma = {};
  const siteMembershipRepo = {
    hasAnyActiveMembership: jest.fn().mockResolvedValue(false),
    hasActiveForSite: jest.fn().mockResolvedValue(false),
    hasActiveManagerForSite: jest.fn().mockResolvedValue(false),
    listActiveForUser: jest.fn().mockResolvedValue([]),
    findManagedSiteIds: jest.fn().mockResolvedValue([]),
    findActiveManagerUserIdsForSite: jest.fn().mockResolvedValue([]),
  };

  const service = new MembershipQueryService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    siteMembershipRepo as any,
  );

  return { service, prisma, siteMembershipRepo };
}

describe('MembershipQueryService', () => {
  it('hasAnyActiveSiteMembership: client belirtilmezse kok PrismaService kullanilir', async () => {
    const { service, prisma, siteMembershipRepo } = buildService();
    siteMembershipRepo.hasAnyActiveMembership.mockResolvedValue(true);

    const result = await service.hasAnyActiveSiteMembership('user-1');

    expect(result).toBe(true);
    expect(siteMembershipRepo.hasAnyActiveMembership).toHaveBeenCalledWith(
      prisma,
      'user-1',
      expect.any(Date),
    );
  });

  it('hasAnyActiveSiteMembership: opts.client verilirse transaction client kullanilir', async () => {
    const { service, siteMembershipRepo } = buildService();
    const tx = { marker: 'tx' };

    await service.hasAnyActiveSiteMembership('user-1', { client: tx as never });

    expect(siteMembershipRepo.hasAnyActiveMembership).toHaveBeenCalledWith(
      tx,
      'user-1',
      expect.any(Date),
    );
  });

  it('hasActiveSiteMembership repository.hasActiveForSite metoduna delege eder', async () => {
    const { service, siteMembershipRepo } = buildService();
    siteMembershipRepo.hasActiveForSite.mockResolvedValue(true);

    const result = await service.hasActiveSiteMembership('user-1', 'site-1');

    expect(result).toBe(true);
    expect(siteMembershipRepo.hasActiveForSite).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'site-1',
      expect.any(Date),
    );
  });

  it('hasActiveManagerMembership repository.hasActiveManagerForSite metoduna delege eder', async () => {
    const { service, siteMembershipRepo } = buildService();
    siteMembershipRepo.hasActiveManagerForSite.mockResolvedValue(true);

    const result = await service.hasActiveManagerMembership('user-1', 'site-1');

    expect(result).toBe(true);
    expect(siteMembershipRepo.hasActiveManagerForSite).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'site-1',
      expect.any(Date),
    );
  });

  it('listActiveMembershipsForUser repository.listActiveForUser sonucunu doner', async () => {
    const { service, siteMembershipRepo } = buildService();
    const memberships = [{ siteId: 'site-1', membershipRole: 'RESIDENT' }];
    siteMembershipRepo.listActiveForUser.mockResolvedValue(memberships);

    const result = await service.listActiveMembershipsForUser('user-1');

    expect(result).toBe(memberships);
  });

  it('listManagedSiteIds repository.findManagedSiteIds sonucunu doner', async () => {
    const { service, siteMembershipRepo } = buildService();
    siteMembershipRepo.findManagedSiteIds.mockResolvedValue(['site-1', 'site-2']);

    const result = await service.listManagedSiteIds('manager-1');

    expect(result).toEqual(['site-1', 'site-2']);
  });

  // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.2/6.4): bildirim
  // alicisi cozumlemesi - yalniz ilgili site'nin aktif MANAGER'larini doner.
  it('listActiveManagerUserIds repository.findActiveManagerUserIdsForSite metoduna siteId ile delege eder', async () => {
    const { service, siteMembershipRepo } = buildService();
    siteMembershipRepo.findActiveManagerUserIdsForSite.mockResolvedValue([
      'manager-1',
      'manager-2',
    ]);

    const result = await service.listActiveManagerUserIds('site-1');

    expect(result).toEqual(['manager-1', 'manager-2']);
    expect(siteMembershipRepo.findActiveManagerUserIdsForSite).toHaveBeenCalledWith(
      expect.anything(),
      'site-1',
      expect.any(Date),
    );
  });
});
