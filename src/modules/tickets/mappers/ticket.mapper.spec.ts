import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { TicketRow } from '../repositories/ticket.repository';
import { toTicketResponse } from './ticket.mapper';

function buildTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'ticket-1',
    code: 'TKT-2026-000001',
    createdByUserId: 'user-1',
    siteId: 'site-1',
    facilityId: 'unit-1',
    title: 'Ariza var',
    description: 'Detayli aciklama',
    category: 'ELECTRICAL',
    urgency: 'STANDARD',
    status: 'OPEN',
    source: 'RESIDENT',
    slaTargetAt: null,
    isRecurring: false,
    operationNote: 'ic not',
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function actor(role: AuthenticatedUser['role']): AuthenticatedUser {
  return { id: 'actor-1', role, sessionId: 's', tokenVersion: 0 };
}

describe('toTicketResponse', () => {
  it('OPERATIONS operationNote alanini gorur', () => {
    const result = toTicketResponse(buildTicket(), actor('OPERATIONS'));
    expect(result).toHaveProperty('operationNote', 'ic not');
  });

  it.each(['RESIDENT', 'SITE_MANAGER', 'TECHNICIAN'] as const)(
    '%s operationNote alanini gormez',
    (role) => {
      const result = toTicketResponse(buildTicket(), actor(role));
      expect(result).not.toHaveProperty('operationNote');
    },
  );
});
