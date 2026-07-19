import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Faz 9 Slice 4: $queryRawUnsafe -> tagged $queryRaw donusumunun davranis
// kaniti. Kolon alias eslemesi (snake_case -> camelCase) elle yeniden
// yazildigi icin alan listesi BIREBIR dogrulanir; bulunamayan kayitta null
// sozlesmesi korunur. FOR UPDATE kilidinin eszamanlilik davranisi ayrica
// assignment-concurrency.integration-spec.ts ile kanitlanir.
describe('AssignmentRepository - tagged raw query donusumu (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ticketService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workflow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assignmentRepo: any;

  const EXPECTED_ROW_KEYS = [
    'id',
    'ticketId',
    'technicianId',
    'assignedByUserId',
    'assignmentStatus',
    'assignedAt',
    'acceptedAt',
    'rejectedAt',
    'rejectionReason',
    'enRouteAt',
    'arrivedAt',
    'startedAt',
    'completedAt',
    'resolutionNote',
    'isCurrent',
    'createdAt',
    'updatedAt',
  ].sort();

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { FacilityService } = await import(
      '../../../src/modules/facilities/services/facility.service'
    );
    const { TicketService } = await import('../../../src/modules/tickets/services/ticket.service');
    const { TicketAssignmentWorkflowService } = await import(
      '../../../src/modules/assignments/services/ticket-assignment-workflow.service'
    );
    const { AssignmentRepository } = await import(
      '../../../src/modules/assignments/repositories/assignment.repository'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    facilityService = app.get(FacilityService);
    ticketService = app.get(TicketService);
    workflow = app.get(TicketAssignmentWorkflowService);
    assignmentRepo = app.get(AssignmentRepository);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  function randomPhone(prefix: string): string {
    return `+9055${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  async function createFixture() {
    const opsUser = await prisma.user.create({
      data: { phoneNumber: randomPhone('71'), firstName: 'Ops', lastName: 'Repo', role: 'OPERATIONS' },
    });
    const ops = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;

    const techUser = await prisma.user.create({
      data: { phoneNumber: randomPhone('72'), firstName: 'Tek', lastName: 'Repo', role: 'TECHNICIAN' },
    });

    const suffix = Math.floor(Math.random() * 1_000_000);
    const site = await facilityService.createSite(
      { name: `Repo Site ${suffix}`, code: `RQ-${suffix}` },
      ops,
    );
    const block = await facilityService.createBlock(site.id, { name: 'Blok 1', code: 'B1' }, ops);
    const unit = await facilityService.createUnit(block.id, { code: 'D-1' }, ops);

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    await prisma.contract.create({
      data: {
        siteId: site.id,
        contractNumber: `RQ-CN-${suffix}`,
        startDate: start,
        endDate: end,
        monthlyFee: '1000.00',
        billingDay: 1,
        status: 'ACTIVE',
        standardResponseTargetHours: 48,
        emergencyCoverage: true,
        createdByUserId: ops.id,
      },
    });

    const residentUser = await prisma.user.create({
      data: { phoneNumber: randomPhone('73'), firstName: 'Sakin', lastName: 'Repo', role: 'RESIDENT' },
    });
    await prisma.siteMembership.create({
      data: { userId: residentUser.id, siteId: site.id, membershipRole: 'RESIDENT', isActive: true },
    });
    await prisma.residentUnitAssignment.create({
      data: { userId: residentUser.id, unitId: unit.id, isPrimary: true, isActive: true },
    });
    const resident = {
      id: residentUser.id,
      role: 'RESIDENT',
      sessionId: 's',
      tokenVersion: 0,
    } as const;

    const ticket = await ticketService.create(resident, {
      facilityId: unit.id,
      title: 'Repo testi arizasi',
      description: 'Tagged raw query donusumu icin fixture ticket kaydi.',
      category: 'ELECTRICAL',
    });
    await ticketService.changeStatus(ops, ticket.id, { toStatus: 'TRIAGED' });
    const assignment = await workflow.assignTechnician(ops, ticket.id, {
      technicianId: techUser.id,
    });

    return { ops, techUserId: techUser.id, ticketId: ticket.id, assignmentId: assignment.id };
  }

  it('findByIdForUpdate: mevcut assignment tum kolon aliaslariyla eksiksiz doner', async () => {
    const { techUserId, ticketId, assignmentId, ops } = await createFixture();

    const row = await assignmentRepo.findByIdForUpdate(prisma, assignmentId);

    expect(row).not.toBeNull();
    expect(Object.keys(row).sort()).toEqual(EXPECTED_ROW_KEYS);
    expect(row).toMatchObject({
      id: assignmentId,
      ticketId,
      technicianId: techUserId,
      assignedByUserId: ops.id,
      assignmentStatus: 'PENDING',
      isCurrent: true,
      acceptedAt: null,
      resolutionNote: null,
    });
    expect(row.assignedAt).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('findByIdForUpdate: olmayan id icin null doner', async () => {
    const row = await assignmentRepo.findByIdForUpdate(
      prisma,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(row).toBeNull();
  });

  it('findCurrentForUpdate: ticket uzerinden current assignment bulunur; olmayan ticket icin null doner', async () => {
    const { ticketId, assignmentId } = await createFixture();

    const row = await assignmentRepo.findCurrentForUpdate(prisma, ticketId);
    expect(row).not.toBeNull();
    expect(row.id).toBe(assignmentId);
    expect(row.isCurrent).toBe(true);

    const missing = await assignmentRepo.findCurrentForUpdate(
      prisma,
      '00000000-0000-4000-8000-000000000001',
    );
    expect(missing).toBeNull();
  });
});
