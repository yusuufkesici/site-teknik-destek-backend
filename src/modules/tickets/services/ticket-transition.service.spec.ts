import type { TicketRow } from '../repositories/ticket.repository';
import { TicketTransitionService } from './ticket-transition.service';

function actorOf(role: string, id = 'actor-1') {
  return { id, role, sessionId: 's', tokenVersion: 0 } as never;
}

function buildTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'ticket-1',
    code: 'TKT-2026-000001',
    createdByUserId: 'resident-1',
    siteId: 'site-1',
    facilityId: 'unit-1',
    title: 'Ariza',
    description: 'Detayli aciklama metni',
    category: 'ELECTRICAL',
    urgency: 'STANDARD',
    status: 'OPEN',
    source: 'RESIDENT',
    slaTargetAt: null,
    isRecurring: false,
    operationNote: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function buildService() {
  const ticketRepo = {
    findByIdForUpdate: jest.fn().mockResolvedValue(buildTicket()),
    updateStatus: jest.fn().mockResolvedValue(buildTicket({ version: 1, status: 'TRIAGED' })),
    addHistory: jest.fn().mockResolvedValue(undefined),
  };
  const stateMachine = { assertTransition: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { publishInTx: jest.fn().mockResolvedValue(undefined) };

  const service = new TicketTransitionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stateMachine as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outbox as any,
  );

  return { service, ticketRepo, stateMachine, audit, outbox };
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('TicketTransitionService.lockAndGet', () => {
  it('ticket bulunamazsa TICKET_NOT_FOUND (404) firlatir', async () => {
    const { service, ticketRepo } = buildService();
    ticketRepo.findByIdForUpdate.mockResolvedValue(null);
    await expectDomainError(service.lockAndGet('tx' as never, 'ticket-1'), 'TICKET_NOT_FOUND', 404);
  });

  it('ticket bulunursa dondurur', async () => {
    const { service } = buildService();
    const result = await service.lockAndGet('tx' as never, 'ticket-1');
    expect(result.id).toBe('ticket-1');
  });
});

describe('TicketTransitionService.applyStatusTransition', () => {
  it('stateMachine.assertTransition cagirir, basarili oldugunda audit + outbox yazar (reason/PII yok)', async () => {
    const { service, stateMachine, audit, outbox } = buildService();
    const ticket = buildTicket();

    await service.applyStatusTransition('tx' as never, {
      actor: actorOf('OPERATIONS'),
      ticket,
      toStatus: 'TRIAGED',
      auditAction: 'TICKET_STATUS_CHANGED' as never,
    });

    expect(stateMachine.assertTransition).toHaveBeenCalledWith(
      'OPEN',
      'TRIAGED',
      'OPERATIONS',
      undefined,
    );
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({
        action: 'TICKET_STATUS_CHANGED',
        metadata: { from: 'OPEN', to: 'TRIAGED', reasonProvided: false },
      }),
    );
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ eventType: 'TicketStatusChanged' }),
    );
    const [, entry] = outbox.publishInTx.mock.calls[0];
    expect(entry.payload).not.toHaveProperty('reason');
  });

  it('CANCELLED gecisinde reason yoksa TICKET_TRANSITION_REASON_REQUIRED (422) firlatir', async () => {
    const { service } = buildService();
    await expectDomainError(
      service.applyStatusTransition('tx' as never, {
        actor: actorOf('OPERATIONS'),
        ticket: buildTicket(),
        toStatus: 'CANCELLED',
        auditAction: 'TICKET_CANCELLED' as never,
      }),
      'TICKET_TRANSITION_REASON_REQUIRED',
      422,
    );
  });

  it('CANCELLED gecisinde cancelledAt/cancellationReason set edilir', async () => {
    const { service, ticketRepo } = buildService();
    await service.applyStatusTransition('tx' as never, {
      actor: actorOf('RESIDENT', 'resident-1'),
      ticket: buildTicket(),
      toStatus: 'CANCELLED',
      reason: 'vazgectim',
      auditAction: 'TICKET_CANCELLED' as never,
    });

    expect(ticketRepo.updateStatus).toHaveBeenCalledWith(
      'tx',
      'ticket-1',
      0,
      'CANCELLED',
      expect.objectContaining({ cancelledAt: expect.any(Date), cancellationReason: 'vazgectim' }),
    );
  });

  it('COMPLETED gecisinde completedAt set edilir', async () => {
    const { service, ticketRepo } = buildService();
    await service.applyStatusTransition('tx' as never, {
      actor: actorOf('TECHNICIAN'),
      ticket: buildTicket({ status: 'IN_PROGRESS' }),
      toStatus: 'COMPLETED',
      auditAction: 'ASSIGNMENT_STATUS_CHANGED' as never,
    });

    expect(ticketRepo.updateStatus).toHaveBeenCalledWith(
      'tx',
      'ticket-1',
      0,
      'COMPLETED',
      expect.objectContaining({ completedAt: expect.any(Date) }),
    );
  });

  it('updateStatus null donerse (version uyusmazligi) CONCURRENT_MODIFICATION (409) firlatir', async () => {
    const { service, ticketRepo } = buildService();
    ticketRepo.updateStatus.mockResolvedValue(null);
    await expectDomainError(
      service.applyStatusTransition('tx' as never, {
        actor: actorOf('OPERATIONS'),
        ticket: buildTicket(),
        toStatus: 'TRIAGED',
        auditAction: 'TICKET_STATUS_CHANGED' as never,
      }),
      'CONCURRENT_MODIFICATION',
      409,
    );
  });
});
