import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

describe('Assignment - eszamanlilik ve DB kisitlari (gercek PostgreSQL)', () => {
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ticketService = app.get(TicketService);
    facilityService = app.get(FacilityService);
    workflow = app.get(TicketAssignmentWorkflowService);
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
      data: { phoneNumber: randomPhone('71'), firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
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
    const site = await facilityService.createSite({ name: `Site ${prefix}`, code: `CC5-${prefix}` }, opsActor);
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
        contractNumber: `CC5-CN-${prefix}-${Math.floor(Math.random() * 1_000_000)}`,
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
      title: 'Asansor arizasi',
      description: 'Asansor calismiyor, sakinler magdur oluyor',
      category: 'GENERAL_MAINTENANCE',
    });
    return ticketService.changeStatus(opsActor, created.id, { toStatus: 'TRIAGED' });
  }

  it('ayni ticket icin paralel iki assignTechnician cagrisi: sonucta tam olarak bir isCurrent=true assignment kalir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('C1', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '80');
    const tech1 = await createTechnicianActor('81');
    const tech2 = await createTechnicianActor('82');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    const results = await Promise.allSettled([
      workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech1.id }),
      workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech2.id }),
    ]);

    // Karar geregi (Faz 5 Bolum 7): ticket satir kilidi iki cagriyi
    // serilestirir, ikisi de basarili olabilir (ikincisi reassign dalina
    // dusup ilkini REASSIGNED yapar) - onemli olan sonucta tam olarak bir
    // isCurrent=true satirin kalmasidir.
    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBeGreaterThanOrEqual(1);

    const currentRows = await prisma.assignment.findMany({
      where: { ticketId: ticket.id, isCurrent: true },
    });
    expect(currentRows).toHaveLength(1);
  });

  it('uq_assignments_one_current_per_ticket: kilidi atlayan dogrudan ikinci current insert unique-violation ile reddedilir', async () => {
    const opsActor = await createOpsActor();
    const { site, unit } = await createSiteWithContract('C2', opsActor);
    const resident = await createResidentActor(site.id, unit.id, '90');
    const tech1 = await createTechnicianActor('91');
    const tech2 = await createTechnicianActor('92');
    const ticket = await createTriagedTicket(opsActor, resident, unit.id);

    await workflow.assignTechnician(opsActor, ticket.id, { technicianId: tech1.id });

    await expect(
      prisma.assignment.create({
        data: {
          ticketId: ticket.id,
          technicianId: tech2.id,
          assignedByUserId: opsActor.id,
          // isCurrent varsayilan true - kilit/reassign akisini atlayarak
          // dogrudan ikinci current satir eklenmeye calisiliyor.
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
