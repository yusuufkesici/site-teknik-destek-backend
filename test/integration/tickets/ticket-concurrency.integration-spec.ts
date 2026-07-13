import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('TicketService - eszamanlilik (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ticketService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ticketRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { TicketService } = await import('../../../src/modules/tickets/services/ticket.service');
    const { TicketRepository } = await import(
      '../../../src/modules/tickets/repositories/ticket.repository'
    );
    const { FacilityService } = await import(
      '../../../src/modules/facilities/services/facility.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ticketService = app.get(TicketService);
    ticketRepo = app.get(TicketRepository);
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
      data: { phoneNumber: randomPhone('21'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
    });
    return { id: user.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createResidentActor(siteId: string, unitId: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone('22'), firstName: 'Sakin', lastName: 'Bir', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.residentUnitAssignment.create({
      data: { userId: user.id, unitId, isPrimary: true, isActive: true },
    });
    return { id: user.id, role: 'RESIDENT', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createSiteWithContract(prefix: string) {
    const opsActor = await createOpsActor();
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `CC-${prefix}` }, opsActor);
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
        contractNumber: `CC-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId: opsActor.id,
      },
    });

    return { site, unit, opsActor };
  }

  it('ayni ticket icin paralel iki PATCH: biri basarili, digeri CONCURRENT_MODIFICATION (409) alir', async () => {
    const { site, unit } = await createSiteWithContract('P1');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Kapi kilidi arizasi',
      description: 'Giris kapisinin kilidi bozuk, aciliyet var gibi',
      category: 'OTHER',
    });

    const results = await Promise.allSettled([
      ticketService.update(resident, created.id, { title: 'Guncelleme A', version: created.version }),
      ticketService.update(resident, created.id, { title: 'Guncelleme B', version: created.version }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONCURRENT_MODIFICATION',
    });

    const final = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(final.version).toBe(1);
  });

  it('ayni ticket icin paralel iki OPEN->TRIAGED: biri basarili, digeri TICKET_STATUS_UNCHANGED (409) alir', async () => {
    const { site, unit, opsActor } = await createSiteWithContract('P2');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Guvenlik kamerasi arizasi',
      description: 'Otopark kamerasi calismiyor, kontrol edilmeli',
      category: 'SECURITY_SYSTEM',
    });

    const results = await Promise.allSettled([
      ticketService.changeStatus(opsActor, created.id, { toStatus: 'TRIAGED' }),
      ticketService.changeStatus(opsActor, created.id, { toStatus: 'TRIAGED' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'TICKET_STATUS_UNCHANGED',
    });

    const final = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(final.status).toBe('TRIAGED');
  });

  it('ticket_code_seq gercek DB uzerinde atomik/benzersiz calisir (10 paralel cagri)', async () => {
    const codes = await Promise.all(
      Array.from({ length: 10 }, () => prisma.$transaction((tx: unknown) => ticketRepo.nextCode(tx))),
    );
    expect(new Set(codes).size).toBe(10);
  });
});
