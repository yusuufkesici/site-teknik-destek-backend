import { AssignmentAuthorizationPolicy } from './assignment-authorization.policy';
import type { AssignmentWithTicketRow } from '../repositories/assignment.repository';

function actor(role: string, id = 'actor-1') {
  return { id, role, sessionId: 's', tokenVersion: 0 } as never;
}

function buildAssignment(
  overrides: Partial<AssignmentWithTicketRow> = {},
): AssignmentWithTicketRow {
  return {
    id: 'assignment-1',
    ticketId: 'ticket-1',
    technicianId: 'tech-1',
    assignedByUserId: 'ops-1',
    assignmentStatus: 'ACTIVE',
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
    ticket: { id: 'ticket-1', siteId: 'site-1', code: 'TKT-2026-000001', status: 'IN_PROGRESS' },
    ...overrides,
  };
}

function buildPolicy() {
  const membershipQuery = { hasActiveManagerMembership: jest.fn().mockResolvedValue(true) };
  const policy = new AssignmentAuthorizationPolicy(membershipQuery as never);
  return { policy, membershipQuery };
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('AssignmentAuthorizationPolicy.assertCanReadMaterials', () => {
  it('TECHNICIAN kendi assignment ise izin verir', async () => {
    const { policy } = buildPolicy();
    await expect(
      policy.assertCanReadMaterials(
        actor('TECHNICIAN', 'tech-1'),
        buildAssignment(),
        'tx' as never,
      ),
    ).resolves.toBeUndefined();
  });

  it('TECHNICIAN baskasinin assignment icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const { policy } = buildPolicy();
    await expectDomainError(
      policy.assertCanReadMaterials(
        actor('TECHNICIAN', 'tech-2'),
        buildAssignment(),
        'tx' as never,
      ),
      'ASSIGNMENT_NOT_FOUND',
      404,
    );
  });

  it('SITE_MANAGER kendi sitesindeki ticket icin izin verir', async () => {
    const { policy, membershipQuery } = buildPolicy();
    membershipQuery.hasActiveManagerMembership.mockResolvedValue(true);
    await expect(
      policy.assertCanReadMaterials(actor('SITE_MANAGER'), buildAssignment(), 'tx' as never),
    ).resolves.toBeUndefined();
    expect(membershipQuery.hasActiveManagerMembership).toHaveBeenCalledWith('actor-1', 'site-1', {
      client: 'tx',
    });
  });

  it('SITE_MANAGER baska site icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const { policy, membershipQuery } = buildPolicy();
    membershipQuery.hasActiveManagerMembership.mockResolvedValue(false);
    await expectDomainError(
      policy.assertCanReadMaterials(actor('SITE_MANAGER'), buildAssignment(), 'tx' as never),
      'ASSIGNMENT_NOT_FOUND',
      404,
    );
  });

  it('OPERATIONS kosulsuz izin alir', async () => {
    const { policy } = buildPolicy();
    await expect(
      policy.assertCanReadMaterials(actor('OPERATIONS'), buildAssignment(), 'tx' as never),
    ).resolves.toBeUndefined();
  });
});
