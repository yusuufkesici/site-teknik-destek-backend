import type { UserRow } from '../repositories/user.repository';
import { UsersService } from './users.service';

const operations = { id: 'ops-1', role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
const siteManager = { id: 'sm-1', role: 'SITE_MANAGER', sessionId: 's', tokenVersion: 0 } as const;

function buildUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
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

function buildFacility(overrides: Record<string, unknown> = {}) {
  return {
    id: 'unit-1',
    type: 'UNIT',
    name: 'D-1',
    code: 'D-1',
    parentId: 'block-1',
    siteId: 'site-1',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildService() {
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn('tx')) };
  const userRepo = {
    acquirePhoneLock: jest.fn().mockResolvedValue(undefined),
    findByPhone: jest.fn().mockResolvedValue(null),
    findAliveById: jest.fn(),
    create: jest.fn().mockResolvedValue(buildUser()),
    update: jest.fn().mockResolvedValue(buildUser()),
    deactivateGlobally: jest.fn().mockResolvedValue(buildUser({ isActive: false })),
    listBySite: jest.fn().mockResolvedValue([]),
  };
  const accessPolicy = {
    assertManagerCanAccessResident: jest.fn().mockResolvedValue(undefined),
    assertSiteManagerCanUpdateGlobalProfile: jest.fn().mockResolvedValue(undefined),
  };
  const membershipQuery = {
    hasActiveSiteMembership: jest.fn().mockResolvedValue(true),
    listActiveMembershipsForUser: jest.fn().mockResolvedValue([]),
  };
  const siteMembershipRepo = {
    upsertActive: jest.fn().mockResolvedValue({}),
    deactivateForSite: jest.fn().mockResolvedValue(1),
  };
  const residentUnitAssignmentRepo = {
    findActiveForUser: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    deactivateAllForUserInSite: jest.fn().mockResolvedValue(1),
    findScopedForUpdate: jest.fn(),
    deactivate: jest.fn().mockResolvedValue(undefined),
  };
  const facilityRepo = { findAliveById: jest.fn().mockResolvedValue(buildFacility()) };
  const authSessionRevocation = { revokeAllForUser: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new UsersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessPolicy as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    membershipQuery as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    siteMembershipRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    residentUnitAssignmentRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facilityRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authSessionRevocation as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
  );

  return {
    service,
    userRepo,
    accessPolicy,
    membershipQuery,
    siteMembershipRepo,
    residentUnitAssignmentRepo,
    facilityRepo,
    authSessionRevocation,
    audit,
  };
}

const createResidentDto = {
  phoneNumber: '+905551112233',
  firstName: 'Yeni',
  lastName: 'Sakin',
  unitId: 'unit-1',
};

describe('UsersService.onboardResident', () => {
  it('kayitli olmayan telefon icin yeni kullanici olusturur', async () => {
    const { service, userRepo, siteMembershipRepo, residentUnitAssignmentRepo, audit } =
      buildService();

    await service.onboardResident('site-1', createResidentDto, siteManager);

    expect(userRepo.create).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ phoneNumber: createResidentDto.phoneNumber, role: 'RESIDENT' }),
    );
    expect(siteMembershipRepo.upsertActive).toHaveBeenCalledWith('tx', {
      userId: 'user-1',
      siteId: 'site-1',
      membershipRole: 'RESIDENT',
    });
    expect(residentUnitAssignmentRepo.create).toHaveBeenCalledWith('tx', {
      userId: 'user-1',
      unitId: 'unit-1',
      isPrimary: true,
    });
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'RESIDENT_ONBOARDED' }),
    );
  });

  it('mevcut aktif RESIDENT bulunursa firstName/lastName SESSIZCE guncellenmez', async () => {
    const { service, userRepo } = buildService();
    const existing = buildUser({ firstName: 'Eski', lastName: 'Isim' });
    userRepo.findByPhone.mockResolvedValue(existing);

    await service.onboardResident('site-1', createResidentDto, siteManager);

    expect(userRepo.create).not.toHaveBeenCalled();
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('telefon baska rolde/silinmis kullanicidaysa USER_PHONE_ALREADY_EXISTS firlatir', async () => {
    const { service, userRepo } = buildService();
    userRepo.findByPhone.mockResolvedValue(buildUser({ role: 'TECHNICIAN' }));

    await expect(
      service.onboardResident('site-1', createResidentDto, siteManager),
    ).rejects.toMatchObject({ code: 'USER_PHONE_ALREADY_EXISTS' });
  });

  it("unit bulunamazsa veya baska site'a aitse UNIT_NOT_FOUND firlatir", async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);

    await expect(
      service.onboardResident('site-1', createResidentDto, siteManager),
    ).rejects.toMatchObject({ code: 'UNIT_NOT_FOUND' });
  });

  it("kullanicinin farkli bir unit'te aktif ikameti varsa RESIDENT_UNIT_ASSIGNMENT_CONFLICT firlatir", async () => {
    const { service, userRepo, residentUnitAssignmentRepo } = buildService();
    userRepo.findByPhone.mockResolvedValue(buildUser());
    residentUnitAssignmentRepo.findActiveForUser.mockResolvedValue({
      id: 'a1',
      userId: 'user-1',
      unitId: 'other-unit',
      isPrimary: true,
      isActive: true,
      startsAt: new Date(),
      endsAt: null,
    });

    await expect(
      service.onboardResident('site-1', createResidentDto, siteManager),
    ).rejects.toMatchObject({ code: 'RESIDENT_UNIT_ASSIGNMENT_CONFLICT' });
  });

  it("ayni unit'te zaten aktif ikamet varsa idempotent davranir, yeni satir acmaz", async () => {
    const { service, userRepo, residentUnitAssignmentRepo } = buildService();
    userRepo.findByPhone.mockResolvedValue(buildUser());
    residentUnitAssignmentRepo.findActiveForUser.mockResolvedValue({
      id: 'a1',
      userId: 'user-1',
      unitId: 'unit-1',
      isPrimary: true,
      isActive: true,
      startsAt: new Date(),
      endsAt: null,
    });

    await service.onboardResident('site-1', createResidentDto, siteManager);

    expect(residentUnitAssignmentRepo.create).not.toHaveBeenCalled();
  });
});

describe('UsersService.update', () => {
  it('OPERATIONS phoneNumber gondermeye calisirsa genel FORBIDDEN firlatir', async () => {
    const { service } = buildService();

    await expect(
      service.update('user-1', { phoneNumber: '+905559998877' }, operations),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('OPERATIONS firstName/lastName degistirebilir', async () => {
    const { service, userRepo, audit } = buildService();
    userRepo.findAliveById.mockResolvedValue(buildUser());

    await service.update('user-1', { firstName: 'Yeni' }, operations);

    expect(userRepo.update).toHaveBeenCalledWith(
      'tx',
      'user-1',
      expect.objectContaining({ firstName: 'Yeni', incrementTokenVersion: false }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'USER_UPDATED' }),
    );
  });

  it('hedef bulunamazsa USER_NOT_FOUND firlatir', async () => {
    const { service, userRepo } = buildService();
    userRepo.findAliveById.mockResolvedValue(null);

    await expect(service.update('missing', { firstName: 'X' }, operations)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('SITE_MANAGER yetki dahilindeyse telefon degisikligini tokenVersion++ ile uygular', async () => {
    const { service, userRepo, audit } = buildService();
    const target = buildUser();
    userRepo.findAliveById.mockResolvedValue(target);
    userRepo.update.mockResolvedValue(buildUser({ phoneNumber: '+905559998877' }));

    await service.update('user-1', { phoneNumber: '+905559998877' }, siteManager);

    expect(userRepo.update).toHaveBeenCalledWith(
      'tx',
      'user-1',
      expect.objectContaining({ phoneNumber: '+905559998877', incrementTokenVersion: true }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'USER_PHONE_CHANGED' }),
    );
  });

  it('SITE_MANAGER yetki disindaysa (subset degil) accessPolicy USER_PROFILE_CHANGE_FORBIDDEN firlatir', async () => {
    const { service, userRepo, accessPolicy } = buildService();
    userRepo.findAliveById.mockResolvedValue(buildUser());
    accessPolicy.assertSiteManagerCanUpdateGlobalProfile.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 'USER_PROFILE_CHANGE_FORBIDDEN' }),
    );

    await expect(
      service.update('user-1', { firstName: 'Yeni' }, siteManager),
    ).rejects.toMatchObject({ code: 'USER_PROFILE_CHANGE_FORBIDDEN' });
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('hem ad/soyad hem telefon degisirse iki ayri audit kaydi yazar', async () => {
    const { service, userRepo, audit } = buildService();
    userRepo.findAliveById.mockResolvedValue(buildUser());

    await service.update(
      'user-1',
      { firstName: 'Yeni', phoneNumber: '+905559998877' },
      siteManager,
    );

    const actions = audit.log.mock.calls.map((call) => (call[1] as { action: string }).action);
    expect(actions).toEqual(expect.arrayContaining(['USER_PHONE_CHANGED', 'USER_UPDATED']));
  });
});

describe('UsersService.deactivateSiteMembership', () => {
  it("User.isActive'e dokunmaz, yalniz site membership + assignment kapatir", async () => {
    const { service, userRepo, siteMembershipRepo, residentUnitAssignmentRepo, audit } =
      buildService();
    userRepo.findAliveById.mockResolvedValue(buildUser());

    await service.deactivateSiteMembership('site-1', 'user-1', 'tasindi', siteManager);

    expect(userRepo.update).not.toHaveBeenCalled();
    expect(siteMembershipRepo.deactivateForSite).toHaveBeenCalledWith('tx', {
      userId: 'user-1',
      siteId: 'site-1',
    });
    expect(residentUnitAssignmentRepo.deactivateAllForUserInSite).toHaveBeenCalledWith('tx', {
      userId: 'user-1',
      siteId: 'site-1',
    });
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'SITE_MEMBERSHIP_DEACTIVATED' }),
    );
  });

  it('hedefin bu sitede aktif uyeligi yoksa USER_NOT_FOUND firlatir', async () => {
    const { service, userRepo, membershipQuery } = buildService();
    userRepo.findAliveById.mockResolvedValue(buildUser());
    membershipQuery.hasActiveSiteMembership.mockResolvedValue(false);

    await expect(
      service.deactivateSiteMembership('site-1', 'user-1', 'reason', siteManager),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('UsersService.deactivateGlobally', () => {
  it("User.isActive=false yapar ve tum refresh session'lari ayni transaction'da iptal eder", async () => {
    const { service, userRepo, authSessionRevocation, audit } = buildService();
    userRepo.findAliveById.mockResolvedValue(buildUser());

    await service.deactivateGlobally('user-1', 'kural ihlali', operations);

    expect(userRepo.deactivateGlobally).toHaveBeenCalledWith('tx', 'user-1');
    expect(authSessionRevocation.revokeAllForUser).toHaveBeenCalledWith('tx', 'user-1');
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'USER_DEACTIVATED' }),
    );
  });
});

describe('UsersService.listBySite', () => {
  it('site facility olarak bulunamazsa SITE_NOT_FOUND firlatir', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);

    await expect(service.listBySite('site-1', {})).rejects.toMatchObject({
      code: 'SITE_NOT_FOUND',
    });
  });

  it('facility SITE tipinde degilse SITE_NOT_FOUND firlatir', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(buildFacility({ type: 'BLOCK' }));

    await expect(service.listBySite('site-1', {})).rejects.toMatchObject({
      code: 'SITE_NOT_FOUND',
    });
  });

  it('gecersiz cursor icin VALIDATION_ERROR firlatir', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(buildFacility({ type: 'SITE' }));

    await expect(
      service.listBySite('site-1', { cursor: 'not-base64url-cursor!' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('UsersService.deactivateAssignment', () => {
  it('scoped satir bulunamazsa RESIDENT_UNIT_ASSIGNMENT_NOT_FOUND firlatir', async () => {
    const { service, residentUnitAssignmentRepo } = buildService();
    residentUnitAssignmentRepo.findScopedForUpdate.mockResolvedValue(null);

    await expect(
      service.deactivateAssignment('site-1', 'unit-1', 'assignment-1', siteManager),
    ).rejects.toMatchObject({ code: 'RESIDENT_UNIT_ASSIGNMENT_NOT_FOUND' });
  });

  it('aktif satiri pasiflestirir ve audit yazar', async () => {
    const { service, residentUnitAssignmentRepo, audit } = buildService();
    residentUnitAssignmentRepo.findScopedForUpdate.mockResolvedValue({
      id: 'assignment-1',
      userId: 'user-1',
      unitId: 'unit-1',
      isPrimary: true,
      isActive: true,
      startsAt: new Date(),
      endsAt: null,
    });

    await service.deactivateAssignment('site-1', 'unit-1', 'assignment-1', siteManager);

    expect(residentUnitAssignmentRepo.deactivate).toHaveBeenCalledWith('tx', 'assignment-1');
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'RESIDENT_UNIT_ASSIGNMENT_DEACTIVATED' }),
    );
  });

  it('zaten pasif satir icin idempotent davranir, ikinci deactivate/audit yapmaz', async () => {
    const { service, residentUnitAssignmentRepo, audit } = buildService();
    residentUnitAssignmentRepo.findScopedForUpdate.mockResolvedValue({
      id: 'assignment-1',
      userId: 'user-1',
      unitId: 'unit-1',
      isPrimary: true,
      isActive: false,
      startsAt: new Date(),
      endsAt: new Date(),
    });

    await service.deactivateAssignment('site-1', 'unit-1', 'assignment-1', siteManager);

    expect(residentUnitAssignmentRepo.deactivate).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
