import { PrismaPg } from '@prisma/adapter-pg';
import { SEED_IDS, assertSeedAllowed, runSeed } from '../../prisma/seed';
import { PrismaClient } from '../../src/generated/prisma-client/client';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './setup/postgres-testcontainer';

interface SeedCounts {
  users: number;
  facilities: number;
  memberships: number;
  unitAssignments: number;
  materials: number;
  contracts: number;
}

async function countSeededTables(prisma: PrismaClient): Promise<SeedCounts> {
  return {
    users: await prisma.user.count(),
    facilities: await prisma.facility.count(),
    memberships: await prisma.siteMembership.count(),
    unitAssignments: await prisma.residentUnitAssignment.count(),
    materials: await prisma.material.count(),
    contracts: await prisma.contract.count(),
  };
}

// Gun hassasiyetinde bugunun UTC karsiligi (@db.Date alanlariyla kiyas icin).
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days),
  );
}

describe('prisma/seed (integration)', () => {
  describe('assertSeedAllowed (production guard)', () => {
    it('production ortaminda hata firlatir', () => {
      expect(() => assertSeedAllowed('production')).toThrow(/NODE_ENV=production reddedildi/);
    });

    it('NODE_ENV tanimsizsa hata firlatir', () => {
      expect(() => assertSeedAllowed(undefined)).toThrow(/tanimsiz/);
    });

    it('development ve test ortamlarina izin verir', () => {
      expect(() => assertSeedAllowed('development')).not.toThrow();
      expect(() => assertSeedAllowed('test')).not.toThrow();
    });
  });

  describe('runSeed (Testcontainers)', () => {
    let testDb: TestDatabase;
    let prisma: PrismaClient;

    beforeAll(async () => {
      testDb = await startTestDatabase();

      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('startTestDatabase DATABASE_URL set etmedi.');
      }
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    }, 120000);

    afterAll(async () => {
      await prisma.$disconnect();
      await stopTestDatabase(testDb);
    });

    it('idempotent calisir: ikinci kosum satir sayilarini degistirmez, veri silmez', async () => {
      await runSeed(prisma);
      const afterFirstRun = await countSeededTables(prisma);

      // Beklenen asgari icerik: 6 kullanici, 8 facility, 4 membership,
      // 3 unit assignment, 3 materyal, 2 sozlesme.
      expect(afterFirstRun.users).toBe(6);
      expect(afterFirstRun.facilities).toBe(8);
      expect(afterFirstRun.memberships).toBe(4);
      expect(afterFirstRun.unitAssignments).toBe(3);
      expect(afterFirstRun.materials).toBe(3);
      expect(afterFirstRun.contracts).toBe(2);

      await runSeed(prisma);
      const afterSecondRun = await countSeededTables(prisma);

      expect(afterSecondRun).toEqual(afterFirstRun);
    });

    it('ikinci kosumdan sonra sozlesme senaryolari gecerli kalir: aktif sozlesme bugunu kapsar, expiring sozlesme yakin bitisli ve expiryNotifiedAt=null', async () => {
      // Bozulmus/eskimis durumu simule et: bildirilmis ve bitis tarihi
      // "bugune dusmus" sozlesmeler. (endDate startDate'in gerisine
      // cekilmez - yil basinda calistirildiginda DB tarih araligi kisitini
      // bozmamak icin guvenli sinir bugundur.)
      const staleDate = utcToday();
      await prisma.contract.update({
        where: { id: SEED_IDS.contractMarinaExpiring },
        data: { expiryNotifiedAt: new Date(), endDate: staleDate },
      });
      await prisma.contract.update({
        where: { id: SEED_IDS.contractPanoramaActive },
        data: { expiryNotifiedAt: new Date(), endDate: staleDate },
      });

      await runSeed(prisma);

      const today = utcToday();

      const active = await prisma.contract.findUniqueOrThrow({
        where: { id: SEED_IDS.contractPanoramaActive },
      });
      expect(active.status).toBe('ACTIVE');
      expect(active.expiryNotifiedAt).toBeNull();
      expect(active.startDate.getTime()).toBeLessThanOrEqual(today.getTime());
      expect(active.endDate.getTime()).toBeGreaterThanOrEqual(today.getTime());

      const expiring = await prisma.contract.findUniqueOrThrow({
        where: { id: SEED_IDS.contractMarinaExpiring },
      });
      expect(expiring.status).toBe('ACTIVE');
      expect(expiring.expiryNotifiedAt).toBeNull();
      // ContractExpiring job kapsami: bugunden ileride ama varsayilan
      // CONTRACT_EXPIRY_LEAD_DAYS (30 gun) penceresi icinde.
      expect(expiring.endDate.getTime()).toBeGreaterThanOrEqual(today.getTime());
      expect(expiring.endDate.getTime()).toBeLessThanOrEqual(addUtcDays(today, 30).getTime());
    });

    it('mevcut (seed disi) veriyi silmez', async () => {
      const extraUser = await prisma.user.create({
        data: {
          phoneNumber: '+905550009901',
          firstName: 'Harici',
          lastName: 'Kayit',
          role: 'OPERATIONS',
        },
      });

      await runSeed(prisma);

      const stillThere = await prisma.user.findUnique({ where: { id: extraUser.id } });
      expect(stillThere).not.toBeNull();
    });

    it('gecici kullaniciyi, uyeligini ve unit eslesmesini yeniden aktif eder (manuel senaryo tekrar edilebilir)', async () => {
      const endedAt = new Date();
      await prisma.user.update({
        where: { id: SEED_IDS.userDisposableResident },
        data: { isActive: false },
      });
      await prisma.siteMembership.update({
        where: { id: SEED_IDS.membershipDisposableResident },
        data: { isActive: false, endsAt: endedAt },
      });
      await prisma.residentUnitAssignment.update({
        where: { id: SEED_IDS.unitAssignmentDisposable },
        data: { isActive: false, endsAt: endedAt },
      });

      await runSeed(prisma);

      const disposable = await prisma.user.findUniqueOrThrow({
        where: { id: SEED_IDS.userDisposableResident },
      });
      expect(disposable.isActive).toBe(true);
      expect(disposable.deletedAt).toBeNull();

      const membership = await prisma.siteMembership.findUniqueOrThrow({
        where: { id: SEED_IDS.membershipDisposableResident },
      });
      expect(membership.isActive).toBe(true);
      expect(membership.endsAt).toBeNull();

      const unitAssignment = await prisma.residentUnitAssignment.findUniqueOrThrow({
        where: { id: SEED_IDS.unitAssignmentDisposable },
      });
      expect(unitAssignment.isActive).toBe(true);
      expect(unitAssignment.endsAt).toBeNull();
    });
  });
});
