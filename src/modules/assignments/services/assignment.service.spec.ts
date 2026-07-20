import { AssignmentService } from './assignment.service';

const operations = { id: 'ops-1', role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;

function buildCurrentAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assignment-1',
    ticketId: 'ticket-1',
    technicianId: 'tech-1',
    assignedByUserId: 'ops-1',
    assignmentStatus: 'PENDING',
    assignedAt: new Date(),
    acceptedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    resolutionNote: null,
    isCurrent: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService() {
  const prisma = {};
  const assignmentRepo = {
    findCurrentByTicketId: jest.fn().mockResolvedValue(buildCurrentAssignment()),
    listForTechnician: jest.fn().mockResolvedValue([]),
    findByIdWithTicket: jest.fn(),
  };
  const assignmentMaterialRepo = { listByAssignment: jest.fn().mockResolvedValue([]) };
  const authPolicy = { assertCanReadMaterials: jest.fn().mockResolvedValue(undefined) };
  const ticketAccess = { assertReadableAndGet: jest.fn().mockResolvedValue({ id: 'ticket-1' }) };

  const service = new AssignmentService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignmentRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignmentMaterialRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authPolicy as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketAccess as any,
  );

  return { service, assignmentRepo, ticketAccess };
}

describe('AssignmentService.getCurrentForTicket', () => {
  it('once ticket erisimini dogrular, sonra current assignment satirini doner', async () => {
    const { service, assignmentRepo, ticketAccess } = buildService();

    const result = await service.getCurrentForTicket(operations as never, 'ticket-1');

    expect(ticketAccess.assertReadableAndGet).toHaveBeenCalledWith(
      operations,
      'ticket-1',
      expect.anything(),
    );
    expect(assignmentRepo.findCurrentByTicketId).toHaveBeenCalledWith(
      expect.anything(),
      'ticket-1',
    );
    expect(result.id).toBe('assignment-1');
  });

  it('ticket erisim hatasini aynen yukari tasir (uniform 404 TICKET_NOT_FOUND)', async () => {
    const { service, assignmentRepo, ticketAccess } = buildService();
    const ticketNotFound = Object.assign(new Error('Ticket bulunamadi.'), {
      code: 'TICKET_NOT_FOUND',
    });
    ticketAccess.assertReadableAndGet.mockRejectedValue(ticketNotFound);

    await expect(service.getCurrentForTicket(operations as never, 'ticket-x')).rejects.toBe(
      ticketNotFound,
    );
    expect(assignmentRepo.findCurrentByTicketId).not.toHaveBeenCalled();
  });

  it('current assignment yoksa 404 ASSIGNMENT_NOT_FOUND firlatir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findCurrentByTicketId.mockResolvedValue(null);

    const promise = service.getCurrentForTicket(operations as never, 'ticket-1');

    await expect(promise).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND' });
    await promise.catch((error: { getStatus(): number }) => {
      expect(error.getStatus()).toBe(404);
    });
  });
});
