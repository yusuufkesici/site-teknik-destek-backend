import type { UserRow } from '../repositories/user.repository';
import { UserAccessPolicy } from './user-access.policy';

const operations = { id: 'ops-1', role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
const siteManager = { id: 'sm-1', role: 'SITE_MANAGER', sessionId: 's', tokenVersion: 0 } as const;

function buildTarget(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'target-1',
    phoneNumber: '+905551112233',
    firstName: 'Ali',
    lastName: 'Veli',
    role: 'RESIDENT',
    isActive: true,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildPolicy(options: { managedSiteIds?: string[]; targetSiteIds?: string[] } = {}) {
  const membershipQuery = {
    listManagedSiteIds: jest.fn().mockResolvedValue(options.managedSiteIds ?? []),
    listActiveMembershipsForUser: jest
      .fn()
      .mockResolvedValue(
        (options.targetSiteIds ?? []).map((siteId) => ({ siteId, membershipRole: 'RESIDENT' })),
      ),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const policy = new UserAccessPolicy(membershipQuery as any);
  return { policy, membershipQuery };
}

describe('UserAccessPolicy.assertManagerCanAccessResident', () => {
  it('hedef RESIDENT degilse USER_NOT_FOUND firlatir (OPERATIONS icin bile)', async () => {
    const { policy } = buildPolicy();
    const target = buildTarget({ role: 'SITE_MANAGER' });

    await expect(
      policy.assertManagerCanAccessResident(operations, target, {} as never),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('OPERATIONS icin site kesisimi kontrol edilmeden gecer', async () => {
    const { policy, membershipQuery } = buildPolicy();
    const target = buildTarget();

    await expect(
      policy.assertManagerCanAccessResident(operations, target, {} as never),
    ).resolves.toBeUndefined();
    expect(membershipQuery.listManagedSiteIds).not.toHaveBeenCalled();
  });

  it('SITE_MANAGER, hedefle site kesisimi varsa gecer', async () => {
    const { policy } = buildPolicy({
      managedSiteIds: ['site-1', 'site-2'],
      targetSiteIds: ['site-2'],
    });
    const target = buildTarget();

    await expect(
      policy.assertManagerCanAccessResident(siteManager, target, {} as never),
    ).resolves.toBeUndefined();
  });

  it('SITE_MANAGER, hedefle site kesisimi yoksa USER_NOT_FOUND (404) firlatir', async () => {
    const { policy } = buildPolicy({ managedSiteIds: ['site-1'], targetSiteIds: ['site-9'] });
    const target = buildTarget();

    await expect(
      policy.assertManagerCanAccessResident(siteManager, target, {} as never),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('UserAccessPolicy.assertSiteManagerCanUpdateGlobalProfile', () => {
  it('OPERATIONS icin subset kontrolu yapilmadan gecer', async () => {
    const { policy, membershipQuery } = buildPolicy();
    const target = buildTarget();

    await expect(
      policy.assertSiteManagerCanUpdateGlobalProfile(operations, target, {} as never),
    ).resolves.toBeUndefined();
    expect(membershipQuery.listManagedSiteIds).not.toHaveBeenCalled();
  });

  it('hedefin tum siteleri SM yonetimindeyse (subset) izin verir', async () => {
    const { policy } = buildPolicy({
      managedSiteIds: ['site-1', 'site-2'],
      targetSiteIds: ['site-1', 'site-2'],
    });
    const target = buildTarget();

    await expect(
      policy.assertSiteManagerCanUpdateGlobalProfile(siteManager, target, {} as never),
    ).resolves.toBeUndefined();
  });

  it('kesisim var ama subset degilse USER_PROFILE_CHANGE_FORBIDDEN (403) firlatir', async () => {
    const { policy } = buildPolicy({
      managedSiteIds: ['site-1'],
      targetSiteIds: ['site-1', 'site-2'],
    });
    const target = buildTarget();

    await expect(
      policy.assertSiteManagerCanUpdateGlobalProfile(siteManager, target, {} as never),
    ).rejects.toMatchObject({ code: 'USER_PROFILE_CHANGE_FORBIDDEN' });
  });

  it('hic kesisim yoksa USER_NOT_FOUND (404) firlatir', async () => {
    const { policy } = buildPolicy({ managedSiteIds: ['site-1'], targetSiteIds: ['site-9'] });
    const target = buildTarget();

    await expect(
      policy.assertSiteManagerCanUpdateGlobalProfile(siteManager, target, {} as never),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('hedef RESIDENT degilse USER_NOT_FOUND firlatir', async () => {
    const { policy } = buildPolicy({ managedSiteIds: ['site-1'], targetSiteIds: ['site-1'] });
    const target = buildTarget({ role: 'TECHNICIAN' });

    await expect(
      policy.assertSiteManagerCanUpdateGlobalProfile(siteManager, target, {} as never),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});
