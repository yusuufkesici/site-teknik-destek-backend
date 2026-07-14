import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('TicketAssignmentWorkflowService - yasam dongusu (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ticketService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workflow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assignmentService: any;

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
    const { TicketAssignmentWorkflowService } = await import(
      '../../../src/modules/assignments/services/ticket-assignment-workflow.service'
    );
    const { AssignmentService } = await import(
      '../../../src/modules/assignments/services/assignment.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ticketService = app.get(TicketService);
    facilityService = app.get(FacilityService);
    workflow = app.get(TicketAssignmentWorkflowService);
    assignmentService = app.get(AssignmentService);
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
      data: { phoneNumber: randomPhone('61'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
    });
    return { id: user.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createTechnicianActor(prefix: string) {
    const user = await prisma.user.create({
      data: {
        phoneNumber: randomPhone(prefix),
        firstName: 'Tekni',
        lastName: 'Syen',
        role: 'TECHNICIAN',
      },
    });
    return { id: user.id, role: 'TECHNICIAN', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createResidentActor(siteId: string, unitId: string, prefix: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone(prefix), firstName: 'Sakin', lastName: 'Bir', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.residentUnitAssignment.create({
      data: { userId: user.id, unitId, isPrimary: true, isActive: true },
    });
    return { id: user.id, role: 'RESIDENT', sessionId: 's', tokenVersion: 0 } as const;
  }

  async function createSiteWithContract(prefix: string, opsActor: { id: string }) {
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `AL-${prefix}` }, opsActor);
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
        contractNumber: `AL-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
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

    return { site, unit };
  }

  async function createTriagedTicket(
    opsActor: { id: string; role: string },
    resident: { id: string; role: string },
    unitId: string,
  ) {
    const created = await ticketService.create(resident, {
      facilityId: unitId,
      title: 'Klima arizasi',
      description: 'Klima calismiyor, sicak havada acil bakim gerekli',
      category: 'HVAC',
    });
    return ticketService.changeStatus(opsActor, created.id, { toStatus: 'TRIAGED' });
  }

  it('reassign: eski assignment REASSIGNED + isCurrent=false, yeni assignment PENDING + isCurrent=true', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('L1', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '10');
    const tech1 = await createTechnicianActor('11');
    const tech2 = await createTechnicianActor('12');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    const first = await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech1.id });
    const second = await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech2.id });

    const oldRow = await prisma.assignment.findUniqueOrThrow({ where: { id: first.id } });
    expect(oldRow.assignmentStatus).toBe('REASSIGNED');
    expect(oldRow.isCurrent).toBe(false);

    const newRow = await prisma.assignment.findUniqueOrThrow({ where: { id: second.id } });
    expect(newRow.assignmentStatus).toBe('PENDING');
    expect(newRow.isCurrent).toBe(true);

    const updatedTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updatedTicket.status).toBe('ASSIGNED');
  });

  it('reject sonrasi yeniden atama: reddedilen kaydin status/rejectionReason DEGISMEZ, yeni PENDING olusur', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('L2', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '20');
    const tech1 = await createTechnicianActor('21');
    const tech2 = await createTechnicianActor('22');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    const first = await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech1.id });
    await workflow.reject(tech1, first.id, { reason: 'Uygun degilim' });

    const rejectedTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(rejectedTicket.status).toBe('REJECTED');

    const second = await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech2.id });

    const oldRow = await prisma.assignment.findUniqueOrThrow({ where: { id: first.id } });
    expect(oldRow.assignmentStatus).toBe('REJECTED');
    expect(oldRow.rejectionReason).toBe('Uygun degilim');
    expect(oldRow.isCurrent).toBe(false);

    const newRow = await prisma.assignment.findUniqueOrThrow({ where: { id: second.id } });
    expect(newRow.assignmentStatus).toBe('PENDING');
    expect(newRow.isCurrent).toBe(true);

    const finalTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(finalTicket.status).toBe('ASSIGNED');
  });

  it('baska teknisyenin accept/reject/status denemesi ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('L3', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '30');
    const tech1 = await createTechnicianActor('31');
    const tech2 = await createTechnicianActor('32');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const assignment = await workflow.assignTechnician(opsActor, ticket.id, {
      technicianId: tech1.id,
    });

    await expect(workflow.accept(tech2, assignment.id)).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
    });
    await expect(
      workflow.reject(tech2, assignment.id, { reason: 'baskasinin isi' }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
    await expect(
      workflow.applyStatusEvent(tech2, assignment.id, { event: 'EN_ROUTE' }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
  });

  it('gecersiz durum sirasi (accept oncesi EN_ROUTE denemesi) ASSIGNMENT_STATUS_CONFLICT (409) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('L4', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '40');
    const tech1 = await createTechnicianActor('41');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const assignment = await workflow.assignTechnician(opsActor, ticket.id, {
      technicianId: tech1.id,
    });

    await expect(
      workflow.applyStatusEvent(tech1, assignment.id, { event: 'EN_ROUTE' }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT' });
  });

  it('ACCEPT ve CANCEL yarisi: ayni ASSIGNED ticket uzerinde tam olarak biri basarili olur', async () => {
    // Not: karar #1 geregi cancelAssignedTicket yalniz ticket.status==='ASSIGNED'
    // iken calisir (henuz kabul edilmemis atama). Bu nedenle "COMPLETE vs CANCEL"
    // senaryosu, ayni baslangic durumundan (ASSIGNED) paylasilan ticket satir
    // kilidiyle serilestirilen "ACCEPT vs CANCEL" olarak uygulanir - COMPLETE
    // yalniz IN_PROGRESS asamasinda ulasilabilir oldugu icin, o noktada
    // cancelAssignedTicket zaten yapisal olarak imkansizdir (409 garanti).
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('L5', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '50');
    const tech1 = await createTechnicianActor('51');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const assignment = await workflow.assignTechnician(opsActor, ticket.id, {
      technicianId: tech1.id,
    });

    const results = await Promise.allSettled([
      workflow.accept(tech1, assignment.id),
      workflow.cancelAssignedTicket(opsActor, assignment.id, { reason: 'operasyonel iptal' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const finalTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(['ACCEPTED', 'CANCELLED']).toContain(finalTicket.status);
  });

  it("GET /assignments/my esdegeri: resident PII (isim/telefon) icermez, yalniz ticket ozet alanlari doner", async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('L6', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '60');
    const tech1 = await createTechnicianActor('61');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech1.id });

    const page = await assignmentService.listMy(tech1, {});
    expect(page.items.length).toBeGreaterThan(0);
    const item = page.items[0];
    expect(item.ticket).toEqual(
      expect.objectContaining({ id: ticket.id, code: ticket.code, status: 'ASSIGNED' }),
    );
    expect(JSON.stringify(item)).not.toContain(resident.id);
    expect(item.ticket).not.toHaveProperty('facilityId');
    expect(item.ticket).not.toHaveProperty('createdByUserId');
  });
});
