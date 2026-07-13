import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('UsersService site-scoped ve global deactivate - gercek PostgreSQL', () => {
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

  async function createSiteWithManager(prefix: string) {
    const opsUser = await prisma.user.create({
      data: {
        phoneNumber: `+9055520${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Ops',
        lastName: 'Actor',
        role: 'OPERATIONS',
      },
    });
    const opsActor = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `SD-${prefix}` }, opsActor);
    const manager = await prisma.user.create({
      data: {
        phoneNumber: `+9055502${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Yonetici',
        lastName: 'X',
        role: 'SITE_MANAGER',
      },
    });
    await prisma.siteMembership.create({
      data: { userId: manager.id, siteId: site.id, membershipRole: 'MANAGER', isActive: true },
    });
    const actor = { id: manager.id, role: 'SITE_MANAGER', sessionId: 's', tokenVersion: 0 } as const;
    return { site, actor };
  }

  it('site-scoped pasiflestirme: User.isActive true kalir, refresh_sessions etkilenmez, diger site erisimi korunur', async () => {
    const { site: siteA, actor: actorA } = await createSiteWithManager('D1A');
    const { site: siteB } = await createSiteWithManager('D1B');

    const resident = await prisma.user.create({
      data: {
        phoneNumber: `+9055503${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Iki',
        lastName: 'Siteli',
        role: 'RESIDENT',
      },
    });
    await prisma.siteMembership.create({
      data: { userId: resident.id, siteId: siteA.id, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.siteMembership.create({
      data: { userId: resident.id, siteId: siteB.id, membershipRole: 'RESIDENT', isActive: true },
    });
    const session = await prisma.refreshSession.create({
      data: {
        userId: resident.id,
        tokenHash: 'a'.repeat(64),
        ipAddress: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await usersService.deactivateSiteMembership(siteA.id, resident.id, 'tasindi', actorA);

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(updatedUser.isActive).toBe(true);

    const untouchedSession = await prisma.refreshSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(untouchedSession.revokedAt).toBeNull();

    const siteAMembership = await prisma.siteMembership.findFirstOrThrow({
      where: { userId: resident.id, siteId: siteA.id },
    });
    expect(siteAMembership.isActive).toBe(false);

    const siteBMembership = await prisma.siteMembership.findFirstOrThrow({
      where: { userId: resident.id, siteId: siteB.id },
    });
    expect(siteBMembership.isActive).toBe(true);
  });

  it('global pasiflestirme: User.isActive=false olur ve tum refresh session\'lar ayni transaction\'da revoke edilir', async () => {
    const opsUser = await prisma.user.create({
      data: {
        phoneNumber: `+9055521${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Ops',
        lastName: 'Actor2',
        role: 'OPERATIONS',
      },
    });
    const opsActor = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
    const resident = await prisma.user.create({
      data: {
        phoneNumber: `+9055504${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Global',
        lastName: 'Pasif',
        role: 'RESIDENT',
      },
    });
    const session = await prisma.refreshSession.create({
      data: {
        userId: resident.id,
        tokenHash: 'b'.repeat(64),
        ipAddress: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await usersService.deactivateGlobally(resident.id, 'kural ihlali', opsActor);

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: resident.id } });
    expect(updatedUser.isActive).toBe(false);

    const revokedSession = await prisma.refreshSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(revokedSession.revokedAt).not.toBeNull();
  });
});
