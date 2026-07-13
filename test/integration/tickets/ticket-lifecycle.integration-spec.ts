import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('TicketService - gercek PostgreSQL (yasam dongusu)', () => {
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
      data: { phoneNumber: randomPhone('01'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
    });
    return { id: user.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createResidentActor(siteId: string, unitId: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone('02'), firstName: 'Sakin', lastName: 'Bir', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.residentUnitAssignment.create({
      data: { userId: user.id, unitId, isPrimary: true, isActive: true },
    });
    return { id: user.id, role: 'RESIDENT', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createSiteWithUnitAndContract(prefix: string, overrides: Record<string, unknown> = {}) {
    const opsActor = await createOpsActor();
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `TL-${prefix}` }, opsActor);
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
        contractNumber: `CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId: opsActor.id,
        ...overrides,
      },
    });

    return { site, block, unit, opsActor };
  }

  it('nextCode iki paralel cagrida cakismasiz benzersiz kod uretir', async () => {
    const codes = await prisma.$transaction(async (tx: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Promise.all([ticketRepo.nextCode(tx as any), ticketRepo.nextCode(tx as any)]);
    });
    expect(codes[0]).not.toBe(codes[1]);
    expect(codes[0]).toMatch(/^TKT-\d{4}-\d{6}$/);
  });

  it('soft-delete edilmis ticket findAliveById ile donmez', async () => {
    const { site, unit, opsActor } = await createSiteWithUnitAndContract('SD1');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Musluk ariza',
      description: 'Mutfak muslugu akitiyor uzun zamandir',
      category: 'PLUMBING',
    });

    await prisma.ticket.update({ where: { id: created.id }, data: { deletedAt: new Date() } });

    await expect(ticketService.findById(opsActor, created.id)).rejects.toMatchObject({
      code: 'TICKET_NOT_FOUND',
    });
  });

  it('list() RESIDENT dali assertCanRead ile tutarlidir: membership pasiflesince ticket listeden de kaybolur', async () => {
    const { site, unit } = await createSiteWithUnitAndContract('CONS1');
    const resident = await createResidentActor(site.id, unit.id);
    await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Elektrik arizasi',
      description: 'Salon prizinde elektrik yok, kontrol gerekli',
      category: 'ELECTRICAL',
    });

    const before = await ticketService.list(resident, {});
    expect(before.items.length).toBeGreaterThan(0);

    await prisma.siteMembership.updateMany({
      where: { userId: resident.id, siteId: site.id },
      data: { isActive: false, endsAt: new Date() },
    });

    const after = await ticketService.list(resident, {});
    expect(after.items).toHaveLength(0);
  });

  it('existsAssignmentForTechnician dogrudan seed edilen Assignment satiri uzerinden dogrulanir', async () => {
    const { site, unit, opsActor } = await createSiteWithUnitAndContract('TECH1');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Kombi arizasi',
      description: 'Kombi calismiyor, aciliyet var gibi gorunuyor',
      category: 'HVAC',
    });

    const technician = await prisma.user.create({
      data: { phoneNumber: randomPhone('03'), firstName: 'Tek', lastName: 'Nisyen', role: 'TECHNICIAN' },
    });
    const techActor = { id: technician.id, role: 'TECHNICIAN', sessionId: 's', tokenVersion: 0 } as const;

    await expect(ticketService.findById(techActor, created.id)).rejects.toMatchObject({
      code: 'TICKET_NOT_FOUND',
    });

    await prisma.assignment.create({
      data: {
        ticketId: created.id,
        technicianId: technician.id,
        assignedByUserId: opsActor.id,
        assignmentStatus: 'PENDING',
      },
    });

    const ticket = await ticketService.findById(techActor, created.id);
    expect(ticket.id).toBe(created.id);
  });

  it('ticket ASSIGNED durumunda seed edilse bile (Assignment olusturulmadan) iptal 409 ile reddedilir', async () => {
    const { site, unit } = await createSiteWithUnitAndContract('ASG1');
    const resident = await createResidentActor(site.id, unit.id);
    const created = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Havuz pompasi',
      description: 'Havuz pompasindan garip ses geliyor, kontrol lazim',
      category: 'POOL',
    });

    await prisma.ticket.update({ where: { id: created.id }, data: { status: 'ASSIGNED' } });

    const opsForCancel = await createOpsActor();
    await expect(
      ticketService.cancel(opsForCancel, created.id, { reason: 'test iptali' }),
    ).rejects.toMatchObject({ code: 'TICKET_INVALID_STATUS_TRANSITION' });

    const stillAssigned = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(stillAssigned.status).toBe('ASSIGNED');
  });

  it('tarih araligi disindaki (henuz baslamamis) ACTIVE sozlesme icin ticket olusturma 409 doner', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 10);
    const futureEnd = new Date(future);
    futureEnd.setDate(futureEnd.getDate() + 100);

    const { unit } = await createSiteWithUnitAndContract('DATE1', {
      startDate: future,
      endDate: futureEnd,
    });
    const opsActor = await createOpsActor();

    await expect(
      ticketService.create(opsActor, {
        facilityId: unit.id,
        title: 'Genel bakim',
        description: 'Rutin genel bakim talebi, once yapilmali',
        category: 'GENERAL_MAINTENANCE',
      }),
    ).rejects.toMatchObject({ code: 'TICKET_SITE_CONTRACT_INACTIVE' });
  });

  it('OPERATIONS bilinmeyen siteId ile GET /tickets listelemesinde SITE_NOT_FOUND alir', async () => {
    const opsActor = await createOpsActor();
    await expect(
      ticketService.list(opsActor, { siteId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });
});
