import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('UsersService.update - coklu-site subset kontrolu (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let usersService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { UsersService } = await import('../../../src/modules/users/services/users.service');
    const { FacilityService } = await import(
      '../../../src/modules/facilities/services/facility.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    usersService = app.get(UsersService);
    facilityService = app.get(FacilityService);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  async function createSite(prefix: string) {
    const opsUser = await prisma.user.create({
      data: {
        phoneNumber: `+9055530${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Ops',
        lastName: 'Actor',
        role: 'OPERATIONS',
      },
    });
    const opsActor = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
    return facilityService.createSite({ name: `Site ${prefix}`, code: `GP-${prefix}` }, opsActor);
  }

  async function createManager(siteIds: string[]) {
    const manager = await prisma.user.create({
      data: {
        phoneNumber: `+9055505${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Yonetici',
        lastName: 'X',
        role: 'SITE_MANAGER',
      },
    });
    for (const siteId of siteIds) {
      await prisma.siteMembership.create({
        data: { userId: manager.id, siteId, membershipRole: 'MANAGER', isActive: true },
      });
    }
    return { id: manager.id, role: 'SITE_MANAGER', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createResidentInSites(siteIds: string[]) {
    const resident = await prisma.user.create({
      data: {
        phoneNumber: `+9055506${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Orijinal',
        lastName: 'Isim',
        role: 'RESIDENT',
      },
    });
    for (const siteId of siteIds) {
      await prisma.siteMembership.create({
        data: { userId: resident.id, siteId, membershipRole: 'RESIDENT', isActive: true },
      });
    }
    return resident;
  }

  it('SM yalniz bir siteyi yonetiyorsa ve hedef iki siteye uyeyse 403 USER_PROFILE_CHANGE_FORBIDDEN doner, isim degismez', async () => {
    const siteA = await createSite('U1A');
    const siteB = await createSite('U1B');
    const sm = await createManager([siteA.id]);
    const resident = await createResidentInSites([siteA.id, siteB.id]);

    await expect(
      usersService.update(resident.id, { firstName: 'Degisti' }, sm),
    ).rejects.toMatchObject({ code: 'USER_PROFILE_CHANGE_FORBIDDEN' });

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(unchanged.firstName).toBe('Orijinal');
  });

  it('SM hedefin tum sitelerini yonetiyorsa 200 doner, isim degisir ve USER_UPDATED audit ham veri icermez', async () => {
    const siteA = await createSite('U2A');
    const siteB = await createSite('U2B');
    const sm = await createManager([siteA.id, siteB.id]);
    const resident = await createResidentInSites([siteA.id, siteB.id]);

    const updated = await usersService.update(resident.id, { firstName: 'Yeni', lastName: 'Soyad' }, sm);
    expect(updated.firstName).toBe('Yeni');
    expect(updated.lastName).toBe('Soyad');

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(persisted.firstName).toBe('Yeni');

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: resident.id, action: 'USER_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    const metadataStr = JSON.stringify(auditRow.metadata);
    expect(metadataStr).not.toContain('Yeni');
    expect(metadataStr).not.toContain('Soyad');
    expect(auditRow.metadata).toMatchObject({ changedFields: expect.arrayContaining(['firstName', 'lastName']) });
  });

  it('telefon degisikligi tokenVersion arttirir ve audit metadata\'sinda ham numara bulunmaz', async () => {
    const siteA = await createSite('U3A');
    const sm = await createManager([siteA.id]);
    const resident = await createResidentInSites([siteA.id]);
    const newPhone = '+905559990001';

    await usersService.update(resident.id, { phoneNumber: newPhone }, sm);

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(persisted.phoneNumber).toBe(newPhone);
    expect(persisted.tokenVersion).toBe(1);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: resident.id, action: 'USER_PHONE_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    const metadataStr = JSON.stringify(auditRow.metadata);
    expect(metadataStr).not.toContain(newPhone);
  });

  it('OPERATIONS phoneNumber gondermeye calisirsa 403 FORBIDDEN doner ve telefon degismez', async () => {
    const siteA = await createSite('U4A');
    const resident = await createResidentInSites([siteA.id]);
    const opsUser = await prisma.user.create({
      data: {
        phoneNumber: `+9055531${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Ops',
        lastName: 'Actor2',
        role: 'OPERATIONS',
      },
    });
    const opsActor = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;

    await expect(
      usersService.update(resident.id, { phoneNumber: '+905559990002' }, opsActor),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(unchanged.phoneNumber).toBe(resident.phoneNumber);
  });
});
