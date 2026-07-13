import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('TicketService - SLA/urgency degisimi (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ticketService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { TicketService } = await import('../../../src/modules/tickets/services/ticket.service');
    const { FacilityService } = await import(
      '../../../src/modules/facilities/services/facility.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ticketService = app.get(TicketService);
    facilityService = app.get(FacilityService);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  function randomPhone(prefix: string): string {
    return `+9055${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  async function createOpsActor() {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone('11'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
    });
    return { id: user.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createResidentActor(siteId: string, unitId: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone('12'), firstName: 'Sakin', lastName: 'Bir', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.residentUnitAssignment.create({
      data: { userId: user.id, unitId, isPrimary: true, isActive: true },
    });
    return { id: user.id, role: 'RESIDENT', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createSiteWithContract(prefix: string, contractOverrides: Record<string, unknown> = {}) {
    const opsActor = await createOpsActor();
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `SLA-${prefix}` }, opsActor);
    const block = await facilityService.createBlock(site.id, { name: 'Blok 1', code: 'B1' }, opsActor);
    const unit = await facilityService.createUnit(block.id, { code: 'D-1' }, opsActor);

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const end = new Date(today);
    end.setDate(end.getDate() + 30);

    await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `SLA-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId: opsActor.id,
        ...contractOverrides,
      },
    });

    return { site, unit, opsActor };
  }

  it('STANDARD -> EMERGENCY: slaTargetAt EMERGENCY_SLA_HOURS ile yeniden hesaplanir', async () => {
    const { site, unit } = await createSiteWithContract('S1');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Asansor arizasi',
      description: 'Asansor calismiyor, acil kontrol gerekiyor lutfen',
      category: 'OTHER',
    });

    const updated = await ticketService.update(resident, created.id, {
      urgency: 'EMERGENCY',
      version: created.version,
    });

    const expected = new Date(created.createdAt.getTime() + 2 * 3_600_000);
    expect(new Date(updated.slaTargetAt).getTime()).toBe(expected.getTime());
  });

  it('EMERGENCY -> STANDARD: slaTargetAt standardResponseTargetHours ile yeniden hesaplanir', async () => {
    const { site, unit } = await createSiteWithContract('S2');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Yangin alarmi arizasi',
      description: 'Guvenlik sistemi ariza veriyor, aciliyet var',
      category: 'SECURITY_SYSTEM',
      urgency: 'EMERGENCY',
    });

    const updated = await ticketService.update(resident, created.id, {
      urgency: 'STANDARD',
      version: created.version,
    });

    const expected = new Date(created.createdAt.getTime() + 48 * 3_600_000);
    expect(new Date(updated.slaTargetAt).getTime()).toBe(expected.getTime());
  });

  it('emergencyCoverage=false: EMERGENCYye gecince standardResponseTargetHours kullanilir', async () => {
    const { site, unit } = await createSiteWithContract('S3', { emergencyCoverage: false });
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Havuz filtresi',
      description: 'Havuz filtresi tikanmis, temizlik gerekiyor',
      category: 'POOL',
    });

    const updated = await ticketService.update(resident, created.id, {
      urgency: 'EMERGENCY',
      version: created.version,
    });

    const expected = new Date(created.createdAt.getTime() + 48 * 3_600_000);
    expect(new Date(updated.slaTargetAt).getTime()).toBe(expected.getTime());
  });

  it('standardResponseTargetHours=null: STANDARD urgencyde slaTargetAt null olur', async () => {
    const { site, unit } = await createSiteWithContract('S4', { standardResponseTargetHours: null });
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Genel bakim talebi',
      description: 'Rutin bakim talebi, aciliyet yok ama takip edilsin',
      category: 'GENERAL_MAINTENANCE',
    });

    expect(created.slaTargetAt).toBeNull();

    const updated = await ticketService.update(resident, created.id, {
      title: 'Genel bakim talebi (guncel)',
      version: created.version,
    });
    expect(updated.slaTargetAt).toBeNull();
  });
});
