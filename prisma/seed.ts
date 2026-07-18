// prisma/seed.ts — Faz 9 (onaylanan docs/phase-9-plan.md Bolum 6).
//
// Idempotent development seed:
// - YALNIZ development/test ortaminda calisir; production'da (veya NODE_ENV
//   tanimsizsa) veritabanina dokunmadan hata ile durur.
// - Sabit UUID'lerle upsert yapar: tekrar calistirildiginda duplicate uretmez,
//   mevcut veriyi silmez.
// - Telefonlar kurgusaldir (+9055500000xx), gercek kisisel veri icermez.
// - OTP seed'lenmez; OTP akisi mock SMS + dev-only SMS inbox ile denenir.
// - Ticket/invoice seed'lenmez: manuel kabul akisi bunlari API uzerinden
//   uretir (docs/manual-acceptance.md).
//
// Dogrudan Prisma client kullanilir (servis katmani degil): amac bilinen
// baslangic durumunu kurmaktir; DB butunlugu custom_constraints
// migration'indaki kisitlarla korunur.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma-client/client';
import {
  ContractStatus,
  FacilityType,
  MembershipRole,
  UserRole,
} from '../src/generated/prisma-client/enums';

export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `Seed yalniz development/test ortaminda calisir; NODE_ENV=${nodeEnv ?? '(tanimsiz)'} reddedildi.`,
    );
  }
}

// Manuel kabul koleksiyonu (manual-tests/bruno) bu sabit degerlere referans
// verir; degistirilirlerse koleksiyon environment'i da guncellenmelidir.
export const SEED_PHONES = {
  operations: '+905550000001',
  technician: '+905550000002',
  panoramaManager: '+905550000003',
  panoramaResident: '+905550000004',
  marinaResident: '+905550000005',
  disposableResident: '+905550000006',
} as const;

export const SEED_IDS = {
  userOperations: '33333333-3333-4333-8333-333333333301',
  userTechnician: '33333333-3333-4333-8333-333333333302',
  userPanoramaManager: '33333333-3333-4333-8333-333333333303',
  userPanoramaResident: '33333333-3333-4333-8333-333333333304',
  userMarinaResident: '33333333-3333-4333-8333-333333333305',
  userDisposableResident: '33333333-3333-4333-8333-333333333306',

  panoramaSite: '11111111-1111-4111-8111-111111111101',
  panoramaBlockA: '11111111-1111-4111-8111-111111111102',
  panoramaUnitA1: '11111111-1111-4111-8111-111111111103',
  panoramaUnitA2: '11111111-1111-4111-8111-111111111104',
  panoramaCommonElk: '11111111-1111-4111-8111-111111111105',

  marinaSite: '22222222-2222-4222-8222-222222222201',
  marinaBlockB: '22222222-2222-4222-8222-222222222202',
  marinaUnitB1: '22222222-2222-4222-8222-222222222203',

  membershipPanoramaManager: '66666666-6666-4666-8666-666666666601',
  membershipPanoramaResident: '66666666-6666-4666-8666-666666666602',
  membershipMarinaResident: '66666666-6666-4666-8666-666666666603',
  membershipDisposableResident: '66666666-6666-4666-8666-666666666604',

  unitAssignmentPanoramaResident: '77777777-7777-4777-8777-777777777701',
  unitAssignmentMarinaResident: '77777777-7777-4777-8777-777777777702',
  unitAssignmentDisposable: '77777777-7777-4777-8777-777777777703',

  materialFuse: '44444444-4444-4444-8444-444444444401',
  materialPipe: '44444444-4444-4444-8444-444444444402',
  materialChlorine: '44444444-4444-4444-8444-444444444403',

  contractPanoramaActive: '55555555-5555-4555-8555-555555555501',
  contractMarinaExpiring: '55555555-5555-4555-8555-555555555502',
} as const;

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

export async function runSeed(prisma: PrismaClient): Promise<void> {
  const users: {
    id: string;
    phoneNumber: string;
    firstName: string;
    lastName: string;
    role: UserRole;
  }[] = [
    {
      id: SEED_IDS.userOperations,
      phoneNumber: SEED_PHONES.operations,
      firstName: 'Operasyon',
      lastName: 'Bir',
      role: UserRole.OPERATIONS,
    },
    {
      id: SEED_IDS.userTechnician,
      phoneNumber: SEED_PHONES.technician,
      firstName: 'Teknisyen',
      lastName: 'Bir',
      role: UserRole.TECHNICIAN,
    },
    {
      id: SEED_IDS.userPanoramaManager,
      phoneNumber: SEED_PHONES.panoramaManager,
      firstName: 'Panorama',
      lastName: 'Yonetici',
      role: UserRole.SITE_MANAGER,
    },
    {
      id: SEED_IDS.userPanoramaResident,
      phoneNumber: SEED_PHONES.panoramaResident,
      firstName: 'Panorama',
      lastName: 'Sakin',
      role: UserRole.RESIDENT,
    },
    {
      id: SEED_IDS.userMarinaResident,
      phoneNumber: SEED_PHONES.marinaResident,
      firstName: 'Marina',
      lastName: 'Sakin',
      role: UserRole.RESIDENT,
    },
    {
      id: SEED_IDS.userDisposableResident,
      phoneNumber: SEED_PHONES.disposableResident,
      firstName: 'Panorama',
      lastName: 'GeciciSakin',
      role: UserRole.RESIDENT,
    },
  ];

  for (const user of users) {
    // Gecici (deaktivasyon senaryosunda harcanan) kullanici her seed'de
    // yeniden aktif edilir ki negatif senaryo tekrar denenebilsin; diger
    // kullanicilarin mevcut durumu degistirilmez.
    const update =
      user.id === SEED_IDS.userDisposableResident ? { isActive: true, deletedAt: null } : {};
    await prisma.user.upsert({ where: { id: user.id }, update, create: user });
  }

  const facilities: {
    id: string;
    type: FacilityType;
    name: string;
    code: string;
    parentId: string | null;
    siteId: string | null;
  }[] = [
    {
      id: SEED_IDS.panoramaSite,
      type: FacilityType.SITE,
      name: 'Panorama Evleri',
      code: 'PNR',
      parentId: null,
      siteId: null,
    },
    {
      id: SEED_IDS.panoramaBlockA,
      type: FacilityType.BLOCK,
      name: 'A Blok',
      code: 'A',
      parentId: SEED_IDS.panoramaSite,
      siteId: SEED_IDS.panoramaSite,
    },
    {
      id: SEED_IDS.panoramaUnitA1,
      type: FacilityType.UNIT,
      name: 'Daire 1',
      code: '1',
      parentId: SEED_IDS.panoramaBlockA,
      siteId: SEED_IDS.panoramaSite,
    },
    {
      id: SEED_IDS.panoramaUnitA2,
      type: FacilityType.UNIT,
      name: 'Daire 2',
      code: '2',
      parentId: SEED_IDS.panoramaBlockA,
      siteId: SEED_IDS.panoramaSite,
    },
    {
      id: SEED_IDS.panoramaCommonElk,
      type: FacilityType.COMMON_AREA,
      name: 'Elektrik Odasi',
      code: 'ELK',
      parentId: SEED_IDS.panoramaSite,
      siteId: SEED_IDS.panoramaSite,
    },
    {
      id: SEED_IDS.marinaSite,
      type: FacilityType.SITE,
      name: 'Marina Park',
      code: 'MRN',
      parentId: null,
      siteId: null,
    },
    {
      id: SEED_IDS.marinaBlockB,
      type: FacilityType.BLOCK,
      name: 'B Blok',
      code: 'B',
      parentId: SEED_IDS.marinaSite,
      siteId: SEED_IDS.marinaSite,
    },
    {
      id: SEED_IDS.marinaUnitB1,
      type: FacilityType.UNIT,
      name: 'Daire 1',
      code: '1',
      parentId: SEED_IDS.marinaBlockB,
      siteId: SEED_IDS.marinaSite,
    },
  ];

  for (const facility of facilities) {
    await prisma.facility.upsert({ where: { id: facility.id }, update: {}, create: facility });
  }

  const memberships = [
    {
      id: SEED_IDS.membershipPanoramaManager,
      userId: SEED_IDS.userPanoramaManager,
      siteId: SEED_IDS.panoramaSite,
      membershipRole: MembershipRole.MANAGER,
    },
    {
      id: SEED_IDS.membershipPanoramaResident,
      userId: SEED_IDS.userPanoramaResident,
      siteId: SEED_IDS.panoramaSite,
      membershipRole: MembershipRole.RESIDENT,
    },
    {
      id: SEED_IDS.membershipMarinaResident,
      userId: SEED_IDS.userMarinaResident,
      siteId: SEED_IDS.marinaSite,
      membershipRole: MembershipRole.RESIDENT,
    },
    {
      id: SEED_IDS.membershipDisposableResident,
      userId: SEED_IDS.userDisposableResident,
      siteId: SEED_IDS.panoramaSite,
      membershipRole: MembershipRole.RESIDENT,
    },
  ];

  for (const membership of memberships) {
    // Gecici kullanicinin uyeligi, manuel negatif senaryoda (deaktivasyon)
    // pasiflestirilmis olabilir; her seed'de yeniden aktif edilir ki senaryo
    // tekrar denenebilsin. Diger uyeliklere dokunulmaz.
    const update =
      membership.id === SEED_IDS.membershipDisposableResident
        ? { isActive: true, endsAt: null }
        : {};
    await prisma.siteMembership.upsert({
      where: { id: membership.id },
      update,
      create: membership,
    });
  }

  const unitAssignments = [
    {
      id: SEED_IDS.unitAssignmentPanoramaResident,
      userId: SEED_IDS.userPanoramaResident,
      unitId: SEED_IDS.panoramaUnitA1,
    },
    {
      id: SEED_IDS.unitAssignmentMarinaResident,
      userId: SEED_IDS.userMarinaResident,
      unitId: SEED_IDS.marinaUnitB1,
    },
    {
      id: SEED_IDS.unitAssignmentDisposable,
      userId: SEED_IDS.userDisposableResident,
      unitId: SEED_IDS.panoramaUnitA2,
    },
  ];

  for (const assignment of unitAssignments) {
    // Gecici kullanicinin unit eslesmesi de uyelikle ayni gerekceyle
    // yeniden aktif edilir.
    const update =
      assignment.id === SEED_IDS.unitAssignmentDisposable ? { isActive: true, endsAt: null } : {};
    await prisma.residentUnitAssignment.upsert({
      where: { id: assignment.id },
      update,
      create: assignment,
    });
  }

  const materials = [
    { id: SEED_IDS.materialFuse, name: '16A Sigorta', code: 'SGT-16A', unit: 'adet' },
    { id: SEED_IDS.materialPipe, name: 'PPRC Boru 25mm', code: 'PPRC-25', unit: 'metre' },
    { id: SEED_IDS.materialChlorine, name: 'Havuz Klor Tableti', code: 'KLR-TAB', unit: 'kg' },
  ];

  for (const material of materials) {
    await prisma.material.upsert({ where: { id: material.id }, update: {}, create: material });
  }

  // EXCLUDE kisiti ayni site icin cakisan ACTIVE sozlesmelere izin vermez;
  // bu yuzden "yakinda sona erecek" sozlesme ikinci sitededir (Marina).
  //
  // Seed'e ait sozlesmeler her kosumda manuel kabul senaryosuna uygun duruma
  // GERI DONDURULUR (update alanlari bilincli olarak bos degildir): aylar
  // sonra yeniden calistirildiginda aktif sozlesmenin tarih araligi bugunu
  // kapsar, expiring sozlesmenin bitisi yeniden yakin gelecege cekilir ve
  // expiryNotifiedAt null'lanir ki ContractExpiring senaryosu tekrar
  // calisabilsin. Seed disi sozlesmelere dokunulmaz.
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const yearStart = utcDate(currentYear, 0, 1);
  const yearEnd = utcDate(currentYear, 11, 31);
  // Takvim tarihi alani (@db.Date) icin gun hassasiyetinde, bugunden 10 gun
  // sonrasi - CONTRACT_EXPIRY_LEAD_DAYS varsayilani (30) kapsaminda kalir.
  const soonEnd = utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10);

  const panoramaContractFields = {
    startDate: yearStart,
    endDate: yearEnd,
    monthlyFee: '15000.00',
    billingDay: 5,
    status: ContractStatus.ACTIVE,
    standardResponseTargetHours: 24,
    emergencyCoverage: true,
    expiryNotifiedAt: null,
  };

  await prisma.contract.upsert({
    where: { id: SEED_IDS.contractPanoramaActive },
    update: panoramaContractFields,
    create: {
      id: SEED_IDS.contractPanoramaActive,
      siteId: SEED_IDS.panoramaSite,
      contractNumber: 'SEED-PNR-ACTIVE',
      createdByUserId: SEED_IDS.userOperations,
      ...panoramaContractFields,
    },
  });

  // ContractExpiring job'inin manuel dogrulamasi icin bitisi yakin sozlesme.
  const marinaContractFields = {
    startDate: yearStart,
    endDate: soonEnd,
    monthlyFee: '12000.00',
    billingDay: 10,
    status: ContractStatus.ACTIVE,
    standardResponseTargetHours: 48,
    emergencyCoverage: false,
    expiryNotifiedAt: null,
  };

  await prisma.contract.upsert({
    where: { id: SEED_IDS.contractMarinaExpiring },
    update: marinaContractFields,
    create: {
      id: SEED_IDS.contractMarinaExpiring,
      siteId: SEED_IDS.marinaSite,
      contractNumber: 'SEED-MRN-EXPIRING',
      createdByUserId: SEED_IDS.userOperations,
      ...marinaContractFields,
    },
  });

  console.log('[seed] tamamlandi:');
  console.log(`[seed]   kullanici: ${users.length} (upsert)`);
  console.log(`[seed]   facility: ${facilities.length} (Panorama + Marina)`);
  console.log(
    `[seed]   membership: ${memberships.length}, unit assignment: ${unitAssignments.length}`,
  );
  console.log(`[seed]   materyal: ${materials.length}, sozlesme: 2 (ACTIVE + yakinda sona erecek)`);
  console.log(
    '[seed] sabit kimlikler icin prisma/seed.ts icindeki SEED_IDS/SEED_PHONES tablolarina bakin.',
  );
}

async function main(): Promise<void> {
  assertSeedAllowed(process.env.NODE_ENV);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL tanimli degil; seed calistirilamaz.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await runSeed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('[seed] basarisiz:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
