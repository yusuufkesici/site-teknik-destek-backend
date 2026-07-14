import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { TicketRow } from '../repositories/ticket.repository';
import { TicketService } from './ticket.service';

function actor(role: AuthenticatedUser['role'], id = 'actor-1'): AuthenticatedUser {
  return { id, role, sessionId: 's', tokenVersion: 0 };
}

function buildFacility(overrides: Record<string, unknown> = {}) {
  return {
    id: 'unit-1',
    type: 'UNIT',
    name: 'D-1',
    code: 'D-1',
    parentId: 'block-1',
    siteId: 'site-1',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
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
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn('tx')) };
  const ticketRepo = {
    nextCode: jest.fn().mockResolvedValue('TKT-2026-000001'),
    create: jest.fn().mockResolvedValue(buildTicket()),
    findAliveById: jest.fn().mockResolvedValue(buildTicket()),
    findByIdForUpdate: jest.fn().mockResolvedValue(buildTicket()),
    updateFields: jest.fn().mockResolvedValue(buildTicket({ version: 1 })),
    updateStatus: jest.fn().mockResolvedValue(buildTicket({ version: 1, status: 'TRIAGED' })),
    addHistory: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    listHistory: jest.fn().mockResolvedValue([]),
    existsAssignmentForTechnician: jest.fn().mockResolvedValue(false),
  };
  const facilityRepo = { findAliveById: jest.fn().mockResolvedValue(buildFacility()) };
  const policy = {
    assertCanCreate: jest.fn().mockResolvedValue(undefined),
    assertCanRead: jest.fn().mockResolvedValue(undefined),
    assertCanUpdateFields: jest.fn(),
  };
  const stateMachine = { assertTransition: jest.fn() };
  const directPolicy = { assertAllowedDirectly: jest.fn() };
  const ticketTransition = {
    applyStatusTransition: jest.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_tx: unknown, params: any) =>
        buildTicket({ version: 1, status: params.toStatus, siteId: params.ticket.siteId }),
    ),
  };
  const contractQuery = {
    findActiveForSite: jest.fn().mockResolvedValue({
      id: 'contract-1',
      standardResponseTargetHours: 48,
      emergencyCoverage: true,
    }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { publishInTx: jest.fn().mockResolvedValue(undefined) };
  const config = { getOrThrow: jest.fn().mockReturnValue(2) };
  const membershipQuery = {
    hasActiveManagerMembership: jest.fn().mockResolvedValue(true),
  };

  const service = new TicketService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facilityRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    policy as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stateMachine as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    directPolicy as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketTransition as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contractQuery as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outbox as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    membershipQuery as any,
  );

  return {
    service,
    prisma,
    ticketRepo,
    facilityRepo,
    policy,
    stateMachine,
    directPolicy,
    ticketTransition,
    contractQuery,
    audit,
    outbox,
    config,
    membershipQuery,
  };
}

async function expectDomainError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('TicketService.create', () => {
  it('facility yoksa FACILITY_NOT_FOUND (404) firlatir', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);
    await expectDomainError(
      service.create(actor('RESIDENT'), {
        facilityId: 'x',
        title: 't',
        description: 'd',
        category: 'OTHER',
      } as never),
      'FACILITY_NOT_FOUND',
      404,
    );
  });

  it('facility SITE tipindeyse FACILITY_NOT_FOUND (404) firlatir', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(buildFacility({ type: 'SITE', siteId: null }));
    await expectDomainError(
      service.create(actor('OPERATIONS'), {
        facilityId: 'x',
        title: 't',
        description: 'd',
        category: 'OTHER',
      } as never),
      'FACILITY_NOT_FOUND',
      404,
    );
  });

  it('aktif sozlesme yoksa TICKET_SITE_CONTRACT_INACTIVE (409) firlatir', async () => {
    const { service, contractQuery } = buildService();
    contractQuery.findActiveForSite.mockResolvedValue(null);
    await expectDomainError(
      service.create(actor('OPERATIONS'), {
        facilityId: 'x',
        title: 't',
        description: 'd',
        category: 'OTHER',
      } as never),
      'TICKET_SITE_CONTRACT_INACTIVE',
      409,
    );
  });

  it('basarili olusturmada ticket + OPEN history + audit + outbox tek transaction icinde yazilir', async () => {
    const { service, ticketRepo, audit, outbox, prisma } = buildService();
    const dto = {
      facilityId: 'unit-1',
      title: 'baslik',
      description: 'aciklama metni',
      category: 'ELECTRICAL',
    };
    await service.create(actor('RESIDENT'), dto as never);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ticketRepo.nextCode).toHaveBeenCalled();
    expect(ticketRepo.create).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ siteId: 'site-1', facilityId: 'unit-1', source: 'RESIDENT' }),
    );
    expect(ticketRepo.addHistory).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ previousStatus: null, newStatus: 'OPEN' }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'TICKET_CREATED' }),
    );
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ eventType: 'TicketCreated' }),
    );
  });

  it('urgency=EMERGENCY ise outbox eventType EmergencyTicketCreated olur', async () => {
    const { service, outbox } = buildService();
    const dto = {
      facilityId: 'unit-1',
      title: 'baslik',
      description: 'aciklama metni',
      category: 'ELECTRICAL',
      urgency: 'EMERGENCY',
    };
    await service.create(actor('OPERATIONS'), dto as never);
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ eventType: 'EmergencyTicketCreated' }),
    );
  });

  it('outbox payload PII/serbest metin icermez (title/description yok)', async () => {
    const { service, outbox } = buildService();
    const dto = {
      facilityId: 'unit-1',
      title: 'baslik',
      description: 'aciklama metni',
      category: 'ELECTRICAL',
    };
    await service.create(actor('RESIDENT'), dto as never);
    const [, entry] = outbox.publishInTx.mock.calls[0];
    expect(entry.payload).not.toHaveProperty('title');
    expect(entry.payload).not.toHaveProperty('description');
  });
});

describe('TicketService.update', () => {
  it('version disinda hicbir alan yoksa TICKET_UPDATE_EMPTY (422) firlatir, DB hic cagrilmaz', async () => {
    const { service, prisma } = buildService();
    await expectDomainError(
      service.update(actor('RESIDENT', 'resident-1'), 'ticket-1', { version: 0 } as never),
      'TICKET_UPDATE_EMPTY',
      422,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('version uyusmazliginda CONCURRENT_MODIFICATION (409) firlatir', async () => {
    const { service } = buildService();
    await expectDomainError(
      service.update(actor('RESIDENT', 'resident-1'), 'ticket-1', {
        title: 'yeni',
        version: 5,
      } as never),
      'CONCURRENT_MODIFICATION',
      409,
    );
  });

  it('basarili guncellemede version artar ve TICKET_UPDATED audit yazilir', async () => {
    const { service, audit } = buildService();
    const result = await service.update(actor('RESIDENT', 'resident-1'), 'ticket-1', {
      title: 'yeni baslik',
      version: 0,
    } as never);

    expect(result.version).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'TICKET_UPDATED', metadata: { changedFields: ['title'] } }),
    );
  });

  it('urgency degisirse slaTargetAt ticket.createdAt baz alinarak yeniden hesaplanir', async () => {
    const { service, ticketRepo, contractQuery } = buildService();
    await service.update(actor('OPERATIONS'), 'ticket-1', {
      urgency: 'EMERGENCY',
      version: 0,
    } as never);

    expect(contractQuery.findActiveForSite).toHaveBeenCalledWith('site-1', 'tx');
    expect(ticketRepo.updateFields).toHaveBeenCalledWith(
      'tx',
      'ticket-1',
      0,
      expect.objectContaining({ urgency: 'EMERGENCY', slaTargetAt: expect.any(Date) }),
    );
  });

  it('ayni urgency tekrar gonderilirse SLA yeniden hesaplanmaz (contract sorgusu yapilmaz)', async () => {
    const { service, ticketRepo, contractQuery } = buildService();
    // buildTicket() varsayilan urgency: 'STANDARD'
    await service.update(actor('OPERATIONS'), 'ticket-1', {
      urgency: 'STANDARD',
      version: 0,
    } as never);

    expect(contractQuery.findActiveForSite).not.toHaveBeenCalled();
    expect(ticketRepo.updateFields).toHaveBeenCalledWith(
      'tx',
      'ticket-1',
      0,
      expect.not.objectContaining({ slaTargetAt: expect.anything() }),
    );
    const [, , , data] = ticketRepo.updateFields.mock.calls[0];
    expect(data).not.toHaveProperty('slaTargetAt');
  });

  it('repository updateFields null donerse (WHERE version esleşmedi) CONCURRENT_MODIFICATION (409) firlatir', async () => {
    const { service, ticketRepo } = buildService();
    ticketRepo.updateFields.mockResolvedValue(null);
    await expectDomainError(
      service.update(actor('OPERATIONS'), 'ticket-1', { title: 'yeni', version: 0 } as never),
      'CONCURRENT_MODIFICATION',
      409,
    );
  });
});

describe('TicketService.changeStatus / cancel', () => {
  it("changeStatus: stateMachine (from===to dogru siniflandirma icin) TicketDirectTransitionPolicy'den ONCE cagrilir", async () => {
    const { service, directPolicy, stateMachine } = buildService();
    await service.changeStatus(actor('OPERATIONS'), 'ticket-1', { toStatus: 'TRIAGED' } as never);

    expect(stateMachine.assertTransition).toHaveBeenCalledWith(
      'OPEN',
      'TRIAGED',
      'OPERATIONS',
      undefined,
    );
    expect(directPolicy.assertAllowedDirectly).toHaveBeenCalledWith('OPEN', 'TRIAGED');

    const stateMachineOrder = stateMachine.assertTransition.mock.invocationCallOrder[0];
    const directPolicyOrder = directPolicy.assertAllowedDirectly.mock.invocationCallOrder[0];
    expect(stateMachineOrder).toBeLessThan(directPolicyOrder);
  });

  it('changeStatus basarili oldugunda ticketTransition.applyStatusTransition TICKET_STATUS_CHANGED ile cagrilir', async () => {
    const { service, ticketTransition } = buildService();
    await service.changeStatus(actor('OPERATIONS'), 'ticket-1', { toStatus: 'TRIAGED' } as never);

    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'TRIAGED', auditAction: 'TICKET_STATUS_CHANGED' }),
    );
  });

  it('TicketDirectTransitionPolicy reddederse (ASSIGNED->CANCELLED) TICKET_INVALID_STATUS_TRANSITION firlatir', async () => {
    const { service, directPolicy, ticketRepo } = buildService();
    ticketRepo.findByIdForUpdate.mockResolvedValue(buildTicket({ status: 'ASSIGNED' }));
    directPolicy.assertAllowedDirectly.mockImplementation(() => {
      throw Object.assign(new Error('reddedildi'), {
        code: 'TICKET_INVALID_STATUS_TRANSITION',
        getStatus: () => 409,
      });
    });

    await expectDomainError(
      service.cancel(actor('OPERATIONS'), 'ticket-1', { reason: 'test' } as never),
      'TICKET_INVALID_STATUS_TRANSITION',
      409,
    );
  });

  it('cancel basarili oldugunda ticketTransition.applyStatusTransition TICKET_CANCELLED ile cagrilir', async () => {
    const { service, ticketTransition } = buildService();

    await service.cancel(actor('RESIDENT', 'resident-1'), 'ticket-1', {
      reason: 'vazgectim',
    } as never);

    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({
        toStatus: 'CANCELLED',
        reason: 'vazgectim',
        auditAction: 'TICKET_CANCELLED',
      }),
    );
  });

  it('ticket bulunamazsa TICKET_NOT_FOUND (404) firlatir', async () => {
    const { service, ticketRepo } = buildService();
    ticketRepo.findByIdForUpdate.mockResolvedValue(null);
    await expectDomainError(
      service.changeStatus(actor('OPERATIONS'), 'ticket-1', { toStatus: 'TRIAGED' } as never),
      'TICKET_NOT_FOUND',
      404,
    );
  });
});

describe('TicketService.list', () => {
  it('RESIDENT icin scope=RESIDENT filtresiyle repository cagrilir', async () => {
    const { service, ticketRepo } = buildService();
    await service.list(actor('RESIDENT', 'resident-1'), {} as never);
    expect(ticketRepo.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'RESIDENT', residentId: 'resident-1' }),
    );
  });

  it('SITE_MANAGER siteId gondermezse VALIDATION_ERROR (422) firlatir', async () => {
    const { service } = buildService();
    await expectDomainError(
      service.list(actor('SITE_MANAGER'), {} as never),
      'VALIDATION_ERROR',
      422,
    );
  });

  it('SITE_MANAGER yonetmedigi site icin SITE_NOT_FOUND (404) alir', async () => {
    const { service, membershipQuery, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(
      buildFacility({ type: 'SITE', id: 'site-1', siteId: null }),
    );
    membershipQuery.hasActiveManagerMembership.mockResolvedValue(false);
    await expectDomainError(
      service.list(actor('SITE_MANAGER'), { siteId: 'site-1' } as never),
      'SITE_NOT_FOUND',
      404,
    );
  });

  it('SITE_MANAGER kendi yonettigi site icin repository scope=SITE_MANAGER ile cagrilir', async () => {
    const { service, ticketRepo, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(
      buildFacility({ type: 'SITE', id: 'site-1', siteId: null }),
    );
    await service.list(actor('SITE_MANAGER'), { siteId: 'site-1' } as never);
    expect(ticketRepo.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'SITE_MANAGER', siteId: 'site-1' }),
    );
  });

  it('OPERATIONS bilinmeyen siteId icin SITE_NOT_FOUND (404) alir (sessiz bos liste degil)', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);
    await expectDomainError(
      service.list(actor('OPERATIONS'), { siteId: 'bilinmeyen' } as never),
      'SITE_NOT_FOUND',
      404,
    );
  });

  it('TECHNICIAN icin liste ucu Faz 4te desteklenmez (FORBIDDEN)', async () => {
    const { service } = buildService();
    await expectDomainError(service.list(actor('TECHNICIAN'), {} as never), 'FORBIDDEN', 403);
  });
});
