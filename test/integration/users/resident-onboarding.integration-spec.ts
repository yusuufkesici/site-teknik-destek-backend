import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('UsersService.onboardResident - gercek PostgreSQL', () => {
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

  async function createSiteWithUnit(prefix: string) {
    const opsUser = await prisma.user.create({
      data: {
        phoneNumber: `+9055500${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Ops',
        lastName: 'Actor',
        role: 'OPERATIONS',
      },
    });
    const opsActor = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `RO-${prefix}` }, opsActor);
    const block = await facilityService.createBlock(site.id, { name: 'Blok 1', code: 'B1' }, opsActor);
    const unit = await facilityService.createUnit(block.id, { code: 'D-1' }, opsActor);
    return { site, unit };
  }

  async function createSiteManager(siteId: string) {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+9055501${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'Yonetici',
        lastName: 'Bir',
        role: 'SITE_MANAGER',
      },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'MANAGER', isActive: true },
    });
    return { id: user.id, role: 'SITE_MANAGER', sessionId: 's', tokenVersion: 0 } as const;
  }

  it('ayni telefon + ayni unit icin paralel iki istekten sadece biri kayit acar (advisory lock)', async () => {
    const { site, unit } = await createSiteWithUnit('C1');
    const actor = await createSiteManager(site.id);
    const phone = '+905552220001';

    const dto = { phoneNumber: phone, firstName: 'Es', lastName: 'Zamanli', unitId: unit.id };

    const results = await Promise.allSettled([
      usersService.onboardResident(site.id, dto, actor),
      usersService.onboardResident(site.id, dto, actor),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const users = await prisma.user.findMany({ where: { phoneNumber: phone } });
    expect(users).toHaveLength(1);

    const memberships = await prisma.siteMembership.findMany({
      where: { userId: users[0].id, siteId: site.id, isActive: true },
    });
    expect(memberships).toHaveLength(1);

    const assignments = await prisma.residentUnitAssignment.findMany({
      where: { userId: users[0].id, isActive: true },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].unitId).toBe(unit.id);
  });

  it('siteden ayrilip tekrar onboard edilen kullanicinin site_memberships tarihcesi korunur', async () => {
    const { site, unit } = await createSiteWithUnit('C2');
    const actor = await createSiteManager(site.id);
    const phone = '+905552220002';
    const dto = { phoneNumber: phone, firstName: 'Ayrilan', lastName: 'Sakin', unitId: unit.id };

    await usersService.onboardResident(site.id, dto, actor);
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });

    const oldMembership = await prisma.siteMembership.findFirstOrThrow({
      where: { userId: user.id, siteId: site.id },
    });
    const endsAt = new Date();
    await prisma.siteMembership.update({
      where: { id: oldMembership.id },
      data: { isActive: false, endsAt },
    });
    await prisma.residentUnitAssignment.updateMany({
      where: { userId: user.id, isActive: true },
      data: { isActive: false, endsAt },
    });

    await usersService.onboardResident(site.id, dto, actor);

    const memberships = await prisma.siteMembership.findMany({
      where: { userId: user.id, siteId: site.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(memberships).toHaveLength(2);
    expect(memberships[0].isActive).toBe(false);
    expect(memberships[0].endsAt?.getTime()).toBe(endsAt.getTime());
    expect(memberships[1].isActive).toBe(true);
  });

  it('kullanici farkli bir unit\'te aktifken RESIDENT_UNIT_ASSIGNMENT_CONFLICT firlatir ve site membership rollback olur', async () => {
    const { site: siteA, unit: unitA } = await createSiteWithUnit('C3A');
    const { site: siteB, unit: unitB } = await createSiteWithUnit('C3B');
    const actorA = await createSiteManager(siteA.id);
    const actorB = await createSiteManager(siteB.id);
    const phone = '+905552220003';

    await usersService.onboardResident(
      siteA.id,
      { phoneNumber: phone, firstName: 'Cakisan', lastName: 'Kullanici', unitId: unitA.id },
      actorA,
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });

    await expect(
      usersService.onboardResident(
        siteB.id,
        { phoneNumber: phone, firstName: 'Cakisan', lastName: 'Kullanici', unitId: unitB.id },
        actorB,
      ),
    ).rejects.toMatchObject({ code: 'RESIDENT_UNIT_ASSIGNMENT_CONFLICT' });

    // Transaction atomikligi: siteB icin siteMembership de rollback olmus olmali.
    const siteBMemberships = await prisma.siteMembership.findMany({
      where: { userId: user.id, siteId: siteB.id },
    });
    expect(siteBMemberships).toHaveLength(0);
  });

  it('mevcut aktif RESIDENT ayni unit\'e farkli ad/soyadla tekrar onboard edilse de global profil degismez', async () => {
    const { site, unit } = await createSiteWithUnit('C4');
    const actor = await createSiteManager(site.id);
    const phone = '+905552220004';

    await usersService.onboardResident(
      site.id,
      { phoneNumber: phone, firstName: 'Orijinal', lastName: 'Isim', unitId: unit.id },
      actor,
    );

    await usersService.onboardResident(
      site.id,
      { phoneNumber: phone, firstName: 'Farkli', lastName: 'Isim2', unitId: unit.id },
      actor,
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });
    expect(user.firstName).toBe('Orijinal');
    expect(user.lastName).toBe('Isim');

    const memberships = await prisma.siteMembership.findMany({
      where: { userId: user.id, siteId: site.id, isActive: true },
    });
    expect(memberships).toHaveLength(1);
    const assignments = await prisma.residentUnitAssignment.findMany({
      where: { userId: user.id, isActive: true },
    });
    expect(assignments).toHaveLength(1);
  });

  it('kullanicinin siteden ayrildiktan sonra farkli bir sitede farkli unit\'e onboard edilebilmesi (coklu-site, tek-aktif-unit)', async () => {
    const { site: siteA, unit: unitA } = await createSiteWithUnit('C5A');
    const { site: siteB, unit: unitB } = await createSiteWithUnit('C5B');
    const actorA = await createSiteManager(siteA.id);
    const actorB = await createSiteManager(siteB.id);
    const phone = '+905552220005';

    await usersService.onboardResident(
      siteA.id,
      { phoneNumber: phone, firstName: 'Tasinan', lastName: 'Sakin', unitId: unitA.id },
      actorA,
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { phoneNumber: phone } });

    // Faz 3 kapsaminda tek-aktif-unit varsayimi (duzeltme #6): once Site A'daki
    // assignment/membership site-scoped deactivate ile kapatilir.
    await usersService.deactivateSiteMembership(siteA.id, user.id, 'tasindi', actorA);

    await usersService.onboardResident(
      siteB.id,
      { phoneNumber: phone, firstName: 'Tasinan', lastName: 'Sakin', unitId: unitB.id },
      actorB,
    );

    const activeAssignments = await prisma.residentUnitAssignment.findMany({
      where: { userId: user.id, isActive: true },
    });
    expect(activeAssignments).toHaveLength(1);
    expect(activeAssignments[0].unitId).toBe(unitB.id);

    const activeMemberships = await prisma.siteMembership.findMany({
      where: { userId: user.id, isActive: true },
    });
    expect(activeMemberships).toHaveLength(1);
    expect(activeMemberships[0].siteId).toBe(siteB.id);
  });
});
