import { TicketAssignmentWorkflowService } from './ticket-assignment-workflow.service';

function actor(role: string, id = 'ops-1') {
  return { id, role, sessionId: 's', tokenVersion: 0 } as never;
}

function buildTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    code: 'TKT-2026-000001',
    createdByUserId: 'resident-1',
    siteId: 'site-1',
    facilityId: 'unit-1',
    title: 'Ariza',
    description: 'Detayli aciklama',
    category: 'ELECTRICAL',
    urgency: 'STANDARD',
    status: 'TRIAGED',
    source: 'RESIDENT',
    slaTargetAt: null,
    isRecurring: false,
    operationNote: null,
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

function buildAssignment(overrides: Record<string, unknown> = {}) {
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
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn('tx')) };
  const ticketTransition = {
    lockAndGet: jest.fn().mockResolvedValue(buildTicket()),
    applyStatusTransition: jest.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_tx: unknown, params: any) => buildTicket({ status: params.toStatus }),
    ),
  };
  const assignmentRepo = {
    findTicketIdById: jest.fn().mockResolvedValue('ticket-1'),
    findByIdForUpdate: jest.fn().mockResolvedValue(buildAssignment()),
    findCurrentForUpdate: jest.fn().mockResolvedValue(null),
    findActiveTechnician: jest.fn().mockResolvedValue({ id: 'tech-1' }),
    create: jest.fn().mockResolvedValue(buildAssignment()),
    supersede: jest.fn().mockResolvedValue(undefined),
    markAccepted: jest.fn().mockResolvedValue(buildAssignment({ assignmentStatus: 'ACCEPTED' })),
    markRejected: jest.fn().mockResolvedValue(buildAssignment({ assignmentStatus: 'REJECTED' })),
    markCancelled: jest.fn().mockResolvedValue(buildAssignment({ assignmentStatus: 'CANCELLED' })),
    applyStatusEvent: jest.fn().mockResolvedValue(buildAssignment({ assignmentStatus: 'ACTIVE' })),
  };
  const assignmentMaterialRepo = {
    create: jest.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_tx: unknown, input: any) => ({
        id: 'material-usage-1',
        assignmentId: input.assignmentId,
        materialId: input.materialId,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        totalPrice: input.totalPrice,
        suppliedBy: input.suppliedBy,
        note: input.note ?? null,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
        material: { id: input.materialId, name: 'Vida', code: 'MAT-001', unit: 'adet' },
      }),
    ),
  };
  const materialLookup = {
    assertActiveMaterial: jest.fn().mockResolvedValue({ id: 'material-1', isActive: true }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { publishInTx: jest.fn().mockResolvedValue(undefined) };

  const service = new TicketAssignmentWorkflowService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticketTransition as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignmentRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assignmentMaterialRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    materialLookup as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outbox as any,
  );

  return {
    service,
    prisma,
    ticketTransition,
    assignmentRepo,
    assignmentMaterialRepo,
    materialLookup,
    audit,
    outbox,
  };
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('TicketAssignmentWorkflowService.assignTechnician', () => {
  it('ticket TRIAGED/REJECTED/ASSIGNED disindaysa TICKET_INVALID_STATUS_TRANSITION (409) firlatir', async () => {
    const { service, ticketTransition } = buildService();
    ticketTransition.lockAndGet.mockResolvedValue(buildTicket({ status: 'OPEN' }));
    await expectDomainError(
      service.assignTechnician(actor('OPERATIONS'), 'ticket-1', { technicianId: 'tech-1' }),
      'TICKET_INVALID_STATUS_TRANSITION',
      409,
    );
  });

  it('teknisyen bulunamaz/aktif degilse ASSIGNMENT_TECHNICIAN_INVALID (422) firlatir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findActiveTechnician.mockResolvedValue(null);
    await expectDomainError(
      service.assignTechnician(actor('OPERATIONS'), 'ticket-1', { technicianId: 'tech-x' }),
      'ASSIGNMENT_TECHNICIAN_INVALID',
      422,
    );
  });

  it('ilk atama (TRIAGED): yeni PENDING assignment olusur, ticket ASSIGNED yapilir, reassigned=false', async () => {
    const { service, assignmentRepo, ticketTransition, audit, outbox } = buildService();
    await service.assignTechnician(actor('OPERATIONS'), 'ticket-1', { technicianId: 'tech-1' });

    expect(assignmentRepo.supersede).not.toHaveBeenCalled();
    expect(assignmentRepo.create).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ ticketId: 'ticket-1', technicianId: 'tech-1' }),
    );
    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'ASSIGNED' }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ metadata: expect.objectContaining({ reassigned: false }) }),
    );
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ eventType: 'TechnicianAssigned' }),
    );
  });

  it('yeniden atama (ticket ASSIGNED): eski assignment REASSIGNED yapilir, ticket transition CAGRILMAZ (history yazilmaz)', async () => {
    const { service, assignmentRepo, ticketTransition } = buildService();
    ticketTransition.lockAndGet.mockResolvedValue(buildTicket({ status: 'ASSIGNED' }));
    assignmentRepo.findCurrentForUpdate.mockResolvedValue(
      buildAssignment({ id: 'old-assignment' }),
    );

    await service.assignTechnician(actor('OPERATIONS'), 'ticket-1', { technicianId: 'tech-2' });

    expect(assignmentRepo.supersede).toHaveBeenCalledWith('tx', 'old-assignment', 'REASSIGNED');
    expect(ticketTransition.applyStatusTransition).not.toHaveBeenCalled();
  });

  it('yeniden atama (ticket REJECTED): eski assignment status DEGISMEZ, yalniz isCurrent kapanir', async () => {
    const { service, assignmentRepo, ticketTransition } = buildService();
    ticketTransition.lockAndGet.mockResolvedValue(buildTicket({ status: 'REJECTED' }));
    assignmentRepo.findCurrentForUpdate.mockResolvedValue(
      buildAssignment({ id: 'old-rejected', assignmentStatus: 'REJECTED' }),
    );

    await service.assignTechnician(actor('OPERATIONS'), 'ticket-1', { technicianId: 'tech-2' });

    expect(assignmentRepo.supersede).toHaveBeenCalledWith('tx', 'old-rejected', null);
    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'ASSIGNED' }),
    );
  });
});

describe('TicketAssignmentWorkflowService.accept', () => {
  it('baska teknisyenin assignmenti icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(buildAssignment({ technicianId: 'tech-x' }));
    await expectDomainError(
      service.accept(actor('TECHNICIAN', 'tech-1'), 'assignment-1'),
      'ASSIGNMENT_NOT_FOUND',
      404,
    );
  });

  it('PENDING disindaysa ASSIGNMENT_STATUS_CONFLICT (409) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'ACTIVE' }),
    );
    await expectDomainError(
      service.accept(actor('TECHNICIAN', 'tech-1'), 'assignment-1'),
      'ASSIGNMENT_STATUS_CONFLICT',
      409,
    );
  });

  it('basarili kabulde ticket ACCEPTED transition + markAccepted cagrilir', async () => {
    const { service, assignmentRepo, ticketTransition } = buildService();
    await service.accept(actor('TECHNICIAN', 'tech-1'), 'assignment-1');
    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'ACCEPTED' }),
    );
    expect(assignmentRepo.markAccepted).toHaveBeenCalledWith('tx', 'assignment-1');
  });
});

describe('TicketAssignmentWorkflowService.reject', () => {
  it('reason ile markRejected cagrilir ve ticket REJECTED transition yapilir', async () => {
    const { service, assignmentRepo, ticketTransition } = buildService();
    await service.reject(actor('TECHNICIAN', 'tech-1'), 'assignment-1', { reason: 'malzeme yok' });
    expect(assignmentRepo.markRejected).toHaveBeenCalledWith('tx', 'assignment-1', 'malzeme yok');
    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'REJECTED', reason: 'malzeme yok' }),
    );
  });
});

describe('TicketAssignmentWorkflowService.applyStatusEvent', () => {
  it('note, event COMPLETE disindaysa VALIDATION_ERROR (422) firlatir (transaction hic acilmaz)', async () => {
    const { service, prisma } = buildService();
    await expectDomainError(
      service.applyStatusEvent(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
        event: 'EN_ROUTE',
        note: 'gereksiz not',
      }),
      'VALIDATION_ERROR',
      422,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('baska teknisyen icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-x', assignmentStatus: 'ACCEPTED' }),
    );
    await expectDomainError(
      service.applyStatusEvent(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
        event: 'EN_ROUTE',
      }),
      'ASSIGNMENT_NOT_FOUND',
      404,
    );
  });

  it('fromAssignmentStatus uyusmazsa ASSIGNMENT_STATUS_CONFLICT (409) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'PENDING' }),
    );
    await expectDomainError(
      service.applyStatusEvent(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
        event: 'EN_ROUTE',
      }),
      'ASSIGNMENT_STATUS_CONFLICT',
      409,
    );
  });

  it('OPERATIONS sahiplik kontrolune tabi degildir (WAIT_MATERIAL)', async () => {
    const { service, assignmentRepo, ticketTransition } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-x', assignmentStatus: 'ACTIVE' }),
    );
    await service.applyStatusEvent(actor('OPERATIONS'), 'assignment-1', { event: 'WAIT_MATERIAL' });
    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'WAITING_MATERIAL' }),
    );
  });

  it('COMPLETE eventinde resolutionNote ve isCurrent=false repository cagrisina gecer', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'ACTIVE' }),
    );
    await service.applyStatusEvent(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
      event: 'COMPLETE',
      note: 'is tamamlandi',
    });
    expect(assignmentRepo.applyStatusEvent).toHaveBeenCalledWith(
      'tx',
      'assignment-1',
      expect.objectContaining({
        assignmentStatus: 'COMPLETED',
        resolutionNote: 'is tamamlandi',
        isCurrent: false,
      }),
    );
  });

  it('audit/outbox metadata icinde note/serbest metin YOK', async () => {
    const { service, assignmentRepo, audit, outbox } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'ACTIVE' }),
    );
    await service.applyStatusEvent(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
      event: 'COMPLETE',
      note: 'gizli detaylar',
    });
    const [, auditEntry] = audit.log.mock.calls[0];
    expect(JSON.stringify(auditEntry.metadata)).not.toContain('gizli detaylar');
    const [, outboxEntry] = outbox.publishInTx.mock.calls[0];
    expect(JSON.stringify(outboxEntry.payload)).not.toContain('gizli detaylar');
  });
});

describe('TicketAssignmentWorkflowService.cancelAssignedTicket', () => {
  it('ticket ASSIGNED disindaysa TICKET_INVALID_STATUS_TRANSITION (409) alir', async () => {
    const { service, ticketTransition } = buildService();
    ticketTransition.lockAndGet.mockResolvedValue(buildTicket({ status: 'TRIAGED' }));
    await expectDomainError(
      service.cancelAssignedTicket(actor('OPERATIONS'), 'assignment-1', { reason: 'iptal' }),
      'TICKET_INVALID_STATUS_TRANSITION',
      409,
    );
  });

  it('current olmayan/terminal durumdaki assignment icin ASSIGNMENT_STATUS_CONFLICT (409) alir', async () => {
    const { service, ticketTransition, assignmentRepo } = buildService();
    ticketTransition.lockAndGet.mockResolvedValue(buildTicket({ status: 'ASSIGNED' }));
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ assignmentStatus: 'REASSIGNED', isCurrent: false }),
    );
    await expectDomainError(
      service.cancelAssignedTicket(actor('OPERATIONS'), 'assignment-1', { reason: 'iptal' }),
      'ASSIGNMENT_STATUS_CONFLICT',
      409,
    );
  });

  it('basarili iptalde markCancelled + ticket CANCELLED transition (reason ile) cagrilir', async () => {
    const { service, ticketTransition, assignmentRepo } = buildService();
    ticketTransition.lockAndGet.mockResolvedValue(buildTicket({ status: 'ASSIGNED' }));
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ assignmentStatus: 'ACTIVE', isCurrent: true }),
    );
    await service.cancelAssignedTicket(actor('OPERATIONS'), 'assignment-1', {
      reason: 'operasyonel iptal',
    });

    expect(assignmentRepo.markCancelled).toHaveBeenCalledWith('tx', 'assignment-1');
    expect(ticketTransition.applyStatusTransition).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ toStatus: 'CANCELLED', reason: 'operasyonel iptal' }),
    );
  });
});

describe('TicketAssignmentWorkflowService.addMaterial', () => {
  it('ACTIVE disindaysa ASSIGNMENT_MATERIAL_NOT_ALLOWED (409) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'COMPLETED' }),
    );
    await expectDomainError(
      service.addMaterial(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
        materialId: 'material-1',
        quantity: '2',
        unitPrice: '10.50',
        suppliedBy: 'COMPANY',
      }),
      'ASSIGNMENT_MATERIAL_NOT_ALLOWED',
      409,
    );
  });

  it('baska teknisyen icin ASSIGNMENT_NOT_FOUND (404) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-x', assignmentStatus: 'ACTIVE' }),
    );
    await expectDomainError(
      service.addMaterial(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
        materialId: 'material-1',
        quantity: '2',
        unitPrice: '10.50',
        suppliedBy: 'COMPANY',
      }),
      'ASSIGNMENT_NOT_FOUND',
      404,
    );
  });

  it('quantity <= 0 ise VALIDATION_ERROR (422) alir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'ACTIVE' }),
    );
    await expectDomainError(
      service.addMaterial(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
        materialId: 'material-1',
        quantity: '0',
        unitPrice: '10.50',
        suppliedBy: 'COMPANY',
      }),
      'VALIDATION_ERROR',
      422,
    );
  });

  it('totalPrice Prisma.Decimal ile dogru hesaplanir (quantity*unitPrice, 2 ondalik)', async () => {
    const { service, assignmentRepo, assignmentMaterialRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'ACTIVE' }),
    );
    await service.addMaterial(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
      materialId: 'material-1',
      quantity: '2.5',
      unitPrice: '10.333',
      suppliedBy: 'COMPANY',
    });

    const [, input] = assignmentMaterialRepo.create.mock.calls[0];
    expect(input.totalPrice.toString()).toBe('25.83');
  });

  it('audit metadata fiyat/miktar DEGERI icermez, outbox payload note icermez', async () => {
    const { service, assignmentRepo, audit, outbox } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-1', assignmentStatus: 'ACTIVE' }),
    );
    await service.addMaterial(actor('TECHNICIAN', 'tech-1'), 'assignment-1', {
      materialId: 'material-1',
      quantity: '2',
      unitPrice: '10.50',
      suppliedBy: 'COMPANY',
      note: 'gizli tedarik notu',
    });

    const [, auditEntry] = audit.log.mock.calls[0];
    expect(auditEntry.metadata).not.toHaveProperty('quantity');
    expect(auditEntry.metadata).not.toHaveProperty('unitPrice');
    expect(auditEntry.metadata).not.toHaveProperty('note');

    const [, outboxEntry] = outbox.publishInTx.mock.calls[0];
    expect(outboxEntry.payload).not.toHaveProperty('note');
    expect(JSON.stringify(outboxEntry.payload)).not.toContain('gizli tedarik notu');
  });

  it('OPERATIONS sahiplik kontrolune tabi degildir', async () => {
    const { service, assignmentRepo } = buildService();
    assignmentRepo.findByIdForUpdate.mockResolvedValue(
      buildAssignment({ technicianId: 'tech-x', assignmentStatus: 'ACTIVE' }),
    );
    await expect(
      service.addMaterial(actor('OPERATIONS'), 'assignment-1', {
        materialId: 'material-1',
        quantity: '1',
        unitPrice: '5',
        suppliedBy: 'OTHER',
      }),
    ).resolves.toBeDefined();
  });
});
