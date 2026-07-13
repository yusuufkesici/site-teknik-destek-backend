import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('MembershipQueryService / SiteMembershipRepository - gercek PostgreSQL', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let membershipQuery: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let siteMembershipRepo: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { MembershipQueryService } = await import(
      '../../../src/modules/memberships/membership-query.service'
    );
    const { SiteMembershipRepository } = await import(
      '../../../src/modules/memberships/repositories/site-membership.repository'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    membershipQuery = app.get(MembershipQueryService);
    siteMembershipRepo = app.get(SiteMembershipRepository);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  async function createSiteAndUser(sitePrefix: string) {
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Site ${sitePrefix}`, code: `MQ-${sitePrefix}` },
    });
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+9055500${Math.floor(Math.random() * 90000 + 10000)}`,
        firstName: 'A',
        lastName: 'B',
        role: 'RESIDENT',
      },
    });
    return { site, user };
  }

  it('hasActiveSiteMembership / hasActiveManagerMembership gercek DB satirini yansitir', async () => {
    const { site, user } = await createSiteAndUser('Q1');
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId: site.id, membershipRole: 'MANAGER', isActive: true },
    });

    await expect(membershipQuery.hasActiveSiteMembership(user.id, site.id)).resolves.toBe(true);
    await expect(membershipQuery.hasActiveManagerMembership(user.id, site.id)).resolves.toBe(true);
    await expect(
      membershipQuery.hasActiveSiteMembership(user.id, '11111111-1111-4111-8111-111111111111'),
    ).resolves.toBe(false);
  });

  it('listManagedSiteIds yalniz MANAGER rolundeki aktif siteleri doner', async () => {
    const { site: managed, user } = await createSiteAndUser('Q2A');
    const { site: resident } = await createSiteAndUser('Q2B');
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId: managed.id, membershipRole: 'MANAGER', isActive: true },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId: resident.id, membershipRole: 'RESIDENT', isActive: true },
    });

    const managedSiteIds = await membershipQuery.listManagedSiteIds(user.id);

    expect(managedSiteIds).toEqual([managed.id]);
  });

  it('upsertActive: ayni user/site/role icin idempotenttir, ikinci cagri yeni satir acmaz', async () => {
    const { site, user } = await createSiteAndUser('Q3');

    const first = await siteMembershipRepo.upsertActive(prisma, {
      userId: user.id,
      siteId: site.id,
      membershipRole: 'RESIDENT',
    });
    const second = await siteMembershipRepo.upsertActive(prisma, {
      userId: user.id,
      siteId: site.id,
      membershipRole: 'RESIDENT',
    });

    expect(second.id).toBe(first.id);
    const rows = await prisma.siteMembership.findMany({
      where: { userId: user.id, siteId: site.id, membershipRole: 'RESIDENT' },
    });
    expect(rows).toHaveLength(1);
  });

  it('upsertActive: gecmis (pasif) satir yeniden aktif edilmez, yeni satir acilir, tarihce korunur', async () => {
    const { site, user } = await createSiteAndUser('Q4');

    const original = await siteMembershipRepo.upsertActive(prisma, {
      userId: user.id,
      siteId: site.id,
      membershipRole: 'RESIDENT',
    });
    const endsAt = new Date();
    await prisma.siteMembership.update({
      where: { id: original.id },
      data: { isActive: false, endsAt },
    });

    const reactivated = await siteMembershipRepo.upsertActive(prisma, {
      userId: user.id,
      siteId: site.id,
      membershipRole: 'RESIDENT',
    });

    expect(reactivated.id).not.toBe(original.id);
    const originalRow = await prisma.siteMembership.findUniqueOrThrow({ where: { id: original.id } });
    expect(originalRow.isActive).toBe(false);
    expect(originalRow.endsAt?.getTime()).toBe(endsAt.getTime());

    const rows = await prisma.siteMembership.findMany({
      where: { userId: user.id, siteId: site.id, membershipRole: 'RESIDENT' },
    });
    expect(rows).toHaveLength(2);
  });
});
