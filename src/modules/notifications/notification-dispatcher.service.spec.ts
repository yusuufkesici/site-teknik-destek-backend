import { NonRetryableDispatchError } from './errors/dispatch-error';
import { NotificationDispatcher, type ClaimedOutboxEvent } from './notification-dispatcher.service';

const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const FACILITY_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_BY_ID = '44444444-4444-4444-8444-444444444444';
const ASSIGNMENT_ID = '55555555-5555-4555-8555-555555555555';
const TECHNICIAN_ID = '66666666-6666-4666-8666-666666666666';

function buildDispatcher() {
  const tx = {
    notificationDelivery: { create: jest.fn().mockResolvedValue(undefined) },
    outboxEvent: { update: jest.fn().mockResolvedValue(undefined) },
  };
  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    outboxEvent: { update: jest.fn().mockResolvedValue(undefined) },
  };
  const userContacts = {
    listActiveOperationsPhones: jest.fn().mockResolvedValue([]),
    findActivePhoneById: jest.fn().mockResolvedValue(null),
    findActivePhonesByIds: jest.fn().mockResolvedValue([]),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const dispatcher = new NotificationDispatcher(
    prisma as never,
    userContacts as never,
    audit as never,
  );

  return { dispatcher, prisma, tx, userContacts, audit };
}

function emergencyEvent(payloadOverrides: Record<string, unknown> = {}): ClaimedOutboxEvent {
  return {
    id: 'event-1',
    eventType: 'EmergencyTicketCreated',
    aggregateType: 'Ticket',
    aggregateId: TICKET_ID,
    payload: {
      ticketId: TICKET_ID,
      ticketCode: 'TKT-2026-000001',
      siteId: SITE_ID,
      facilityId: FACILITY_ID,
      category: 'PLUMBING',
      urgency: 'EMERGENCY',
      createdByUserId: CREATED_BY_ID,
      ...payloadOverrides,
    },
  };
}

function technicianAssignedEvent(
  payloadOverrides: Record<string, unknown> = {},
): ClaimedOutboxEvent {
  return {
    id: 'event-2',
    eventType: 'TechnicianAssigned',
    aggregateType: 'Assignment',
    aggregateId: ASSIGNMENT_ID,
    payload: {
      ticketId: TICKET_ID,
      assignmentId: ASSIGNMENT_ID,
      technicianId: TECHNICIAN_ID,
      reassigned: false,
      ...payloadOverrides,
    },
  };
}

describe('NotificationDispatcher.fanOut', () => {
  it('EmergencyTicketCreated: aktif OPERATIONS alicilari icin delivery olusturur, kaynagi tek transaction icinde PROCESSED yapar', async () => {
    const { dispatcher, prisma, tx, userContacts } = buildDispatcher();
    userContacts.listActiveOperationsPhones.mockResolvedValue([
      { userId: 'ops-1', phoneNumber: '+905551110001' },
    ]);

    await dispatcher.fanOut(emergencyEvent());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.notificationDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceEventId: 'event-1',
        sourceEventType: 'EmergencyTicketCreated',
        channel: 'SMS',
        smsMethod: 'EMERGENCY_ALERT',
        recipientUserId: 'ops-1',
        recipientPhone: '+905551110001',
      }),
    });
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: expect.objectContaining({ status: 'PROCESSED' }),
    });
  });

  it('EmergencyTicketCreated: ayni telefon birden fazla kayittan gelirse tek delivery satiri olusturulur', async () => {
    const { dispatcher, tx, userContacts } = buildDispatcher();
    userContacts.listActiveOperationsPhones.mockResolvedValue([
      { userId: 'ops-1', phoneNumber: '+905551110001' },
      { userId: 'ops-2', phoneNumber: '+905551110001' },
    ]);

    await dispatcher.fanOut(emergencyEvent());

    expect(tx.notificationDelivery.create).toHaveBeenCalledTimes(1);
  });

  it('EmergencyTicketCreated: sifir alici cozumlenirse PROCESSED + recipientCount:0 audit yazilir, delivery olusturulmaz', async () => {
    const { dispatcher, tx, audit } = buildDispatcher();

    await dispatcher.fanOut(emergencyEvent());

    expect(tx.notificationDelivery.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: expect.objectContaining({ status: 'PROCESSED' }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'NOTIFICATION_FANOUT_NO_RECIPIENTS',
        metadata: { eventType: 'EmergencyTicketCreated', recipientCount: 0 },
      }),
    );
  });

  it('TechnicianAssigned: teknisyen bulunursa tek delivery olusturur', async () => {
    const { dispatcher, tx, userContacts } = buildDispatcher();
    userContacts.findActivePhoneById.mockResolvedValue({
      userId: TECHNICIAN_ID,
      phoneNumber: '+905551110002',
    });

    await dispatcher.fanOut(technicianAssignedEvent());

    expect(userContacts.findActivePhoneById).toHaveBeenCalledWith(TECHNICIAN_ID);
    expect(tx.notificationDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        smsMethod: 'TICKET_NOTIFICATION',
        recipientUserId: TECHNICIAN_ID,
        recipientPhone: '+905551110002',
      }),
    });
  });

  it('TechnicianAssigned: teknisyen bulunamazsa (inaktif/silinmis) telefonu olmayan alici guvenle atlanir, sifir-alici yolu isler', async () => {
    const { dispatcher, tx, userContacts, audit } = buildDispatcher();
    userContacts.findActivePhoneById.mockResolvedValue(null);

    await dispatcher.fanOut(technicianAssignedEvent());

    expect(tx.notificationDelivery.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: { eventType: 'TechnicianAssigned', recipientCount: 0 } }),
    );
  });

  it('Bozuk/eksik payload: NonRetryableDispatchError firlatir, hicbir DB yazimi yapilmaz', async () => {
    const { dispatcher, prisma, tx } = buildDispatcher();
    const malformed = emergencyEvent({ ticketId: 'not-a-uuid' });

    await expect(dispatcher.fanOut(malformed)).rejects.toBeInstanceOf(NonRetryableDispatchError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it('Tanınmayan eventType: payload hic okunmadan dogrudan PROCESSED isaretlenir (no-op)', async () => {
    const { dispatcher, prisma } = buildDispatcher();
    const unknownEvent: ClaimedOutboxEvent = {
      id: 'event-3',
      eventType: 'ContractCreated',
      aggregateType: 'Contract',
      aggregateId: 'contract-1',
      payload: { anything: 'goes-here-unvalidated' },
    };

    await dispatcher.fanOut(unknownEvent);

    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-3' },
      data: expect.objectContaining({ status: 'PROCESSED' }),
    });
    // No-op yolu $transaction ACMAZ - tek basit UPDATE yeterlidir.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
