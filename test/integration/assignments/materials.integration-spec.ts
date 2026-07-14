import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('AssignmentMaterial - Decimal, DB CHECK ve yetki izolasyonu (gercek PostgreSQL)', () => {
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
      data: { phoneNumber: randomPhone('01'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
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

  async function createSiteManagerActor(siteId: string, prefix: string) {
    const user = await prisma.user.create({
      data: { phoneNumber: randomPhone(prefix), firstName: 'Site', lastName: 'Manager', role: 'SITE_MANAGER' },
    });
    await prisma.siteMembership.create({
      data: { userId: user.id, siteId, membershipRole: 'MANAGER', isActive: true },
    });
    return { id: user.id, role: 'SITE_MANAGER', sessionId: 's', tokenVersion: 0 } as const;
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
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `MT-${prefix}` }, opsActor);
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
        contractNumber: `MT-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
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

  async function createMaterial(prefix: string) {
    return prisma.material.create({
      data: { name: `Vida ${prefix}`, code: `MAT-${prefix}`, unit: 'adet', isActive: true },
    });
  }

  async function createTriagedTicket(
    opsActor: { id: string; role: string },
    resident: { id: string; role: string },
    unitId: string,
  ) {
    const created = await ticketService.create(resident, {
      facilityId: unitId,
      title: 'Elektrik panosu arizasi',
      description: 'Elektrik panosunda ariza var, kontrol edilmeli lutfen',
      category: 'ELECTRICAL',
    });
    return ticketService.changeStatus(opsActor, created.id, { toStatus: 'TRIAGED' });
  }

  // ASSIGNED -> ACCEPTED -> EN_ROUTE -> ARRIVED -> IN_PROGRESS (assignment ACTIVE)
  async function createActiveAssignment(
    opsActor: { id: string; role: string },
    tech: { id: string; role: string },
    ticketId: string,
  ) {
    const assignment = await workflow.assignTechnician(opsActor, ticketId, { technicianId: tech.id });
    await workflow.accept(tech, assignment.id);
    await workflow.applyStatusEvent(tech, assignment.id, { event: 'EN_ROUTE' });
    await workflow.applyStatusEvent(tech, assignment.id, { event: 'ARRIVED' });
    return workflow.applyStatusEvent(tech, assignment.id, { event: 'START' });
  }

  it('totalPrice Prisma.Decimal ile dogru hesaplanir ve chk_am_total_consistent DB CHECK ile tutarlidir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('D1', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '02');
    const tech = await createTechnicianActor('03');
    const material = await createMaterial('D1');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const active = await createActiveAssignment(opsActor, tech, ticket.id);

    const created = await workflow.addMaterial(tech, active.id, {
      materialId: material.id,
      quantity: '2.5',
      unitPrice: '10.333',
      suppliedBy: 'COMPANY',
    });

    expect(created.totalPrice.toString()).toBe('25.83');

    const dbRow = await prisma.assignmentMaterial.findUniqueOrThrow({ where: { id: created.id } });
    expect(dbRow.totalPrice.toString()).toBe('25.83');
  });

  it('chk_am_total_consistent: tutarsiz totalPrice ile dogrudan insert DB tarafindan reddedilir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('D2', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '04');
    const tech = await createTechnicianActor('05');
    const material = await createMaterial('D2');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const active = await createActiveAssignment(opsActor, tech, ticket.id);

    await expect(
      prisma.assignmentMaterial.create({
        data: {
          assignmentId: active.id,
          materialId: material.id,
          quantity: '2.000',
          unitPrice: '10.00',
          totalPrice: '999.00',
          suppliedBy: 'COMPANY',
          createdByUserId: tech.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('PENDING (henuz kabul edilmemis) assignment icin malzeme eklemesi ASSIGNMENT_MATERIAL_NOT_ALLOWED (409) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('D3', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '06');
    const tech = await createTechnicianActor('07');
    const material = await createMaterial('D3');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const assignment = await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech.id });

    await expect(
      workflow.addMaterial(tech, assignment.id, {
        materialId: material.id,
        quantity: '1',
        unitPrice: '5.00',
        suppliedBy: 'COMPANY',
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_MATERIAL_NOT_ALLOWED' });
  });

  it('COMPLETED assignment icin malzeme eklemesi ASSIGNMENT_MATERIAL_NOT_ALLOWED (409) alir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('D4', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '08');
    const tech = await createTechnicianActor('09');
    const material = await createMaterial('D4');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);
    const active = await createActiveAssignment(opsActor, tech, ticket.id);
    await workflow.applyStatusEvent(tech, active.id, { event: 'COMPLETE', note: 'tamamlandi' });

    await expect(
      workflow.addMaterial(tech, active.id, {
        materialId: material.id,
        quantity: '1',
        unitPrice: '5.00',
        suppliedBy: 'COMPANY',
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_MATERIAL_NOT_ALLOWED' });
  });

  it('SITE_MANAGER material okuma izolasyonu: A sitesi manageri B sitesinin assignment materyalleri icin 404 alir', async () => {
    const opsActor = await createOpsActor();
    const { site: siteA, unit: unitA } = await createSiteWithContract('D5A', opsActor);
    const { site: siteB, unit: unitB } = await createSiteWithContract('D5B', opsActor);
    const residentA = await createResidentActor(siteA.id, unitA.id, '10');
    const residentB = await createResidentActor(siteB.id, unitB.id, '11');
    const techA = await createTechnicianActor('12');
    const techB = await createTechnicianActor('13');
    const managerA = await createSiteManagerActor(siteA.id, '14');

    const ticketA = await createTriagedTicket(opsActor, residentA, unitA.id);
    const ticketB = await createTriagedTicket(opsActor, residentB, unitB.id);
    const activeA = await createActiveAssignment(opsActor, techA, ticketA.id);
    const activeB = await createActiveAssignment(opsActor, techB, ticketB.id);

    await expect(assignmentService.listMaterials(managerA, activeA.id)).resolves.toBeDefined();
    await expect(assignmentService.listMaterials(managerA, activeB.id)).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
    });
  });
});
