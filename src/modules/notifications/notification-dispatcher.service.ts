import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { DOMAIN_AUDIT_ACTIONS } from '../../common/constants/domain-audit-actions.constant';
import { AuditWriter } from '../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service';
import type { RecipientContact } from '../users/services/user-contact-lookup.service';
import { UserContactLookupService } from '../users/services/user-contact-lookup.service';
import { SMS_METHODS, type SmsMethod } from './constants/sms-method.constant';
import { NonRetryableDispatchError } from './errors/dispatch-error';
import {
  emergencyTicketCreatedPayloadSchema,
  technicianAssignedPayloadSchema,
} from './schemas/outbox-payload.schemas';

export interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

// Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.1/6.2): bir
// outbox_events satirini TEK transaction icinde N adet NotificationDelivery
// satirina boler ve kaynak satiri PROCESSED yapar - bu adim book-keeping
// acisindan EXACTLY-ONCE'tur (crash olursa event PENDING kalir, yeniden
// claim edildiginde fan-out'un tamami - henuz hic delivery satiri yokken -
// sifirdan tekrar calisir). Gercek SMS gonderimi (at-least-once) ayri,
// sonraki asamadir (NotificationDeliveryRelay).
@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userContacts: UserContactLookupService,
    private readonly audit: AuditWriter,
  ) {}

  async fanOut(event: ClaimedOutboxEvent): Promise<void> {
    switch (event.eventType) {
      case 'EmergencyTicketCreated':
        return this.fanOutEmergencyTicketCreated(event);
      case 'TechnicianAssigned':
        return this.fanOutTechnicianAssigned(event);
      default:
        // Faz 8 itibariyla outbox_events tek onayli tuketicilidir
        // (NotificationsModule) - tanmimayan/ilgisiz eventType payload'a
        // hic bakilmadan PROCESSED isaretlenir, satir tabloda takilmaz
        // (plan Bolum 6.1).
        return this.markProcessed(event.id);
    }
  }

  private async fanOutEmergencyTicketCreated(event: ClaimedOutboxEvent): Promise<void> {
    const payload = this.parse(emergencyTicketCreatedPayloadSchema, event);
    const recipients = await this.userContacts.listActiveOperationsPhones();
    const message = `ACIL ARIZA: Ticket ${payload.ticketCode} (${payload.category}) olusturuldu.`;
    await this.commitFanOut(event, dedupeByPhone(recipients), SMS_METHODS.EMERGENCY_ALERT, message);
  }

  private async fanOutTechnicianAssigned(event: ClaimedOutboxEvent): Promise<void> {
    const payload = this.parse(technicianAssignedPayloadSchema, event);
    const technician = await this.userContacts.findActivePhoneById(payload.technicianId);
    const recipients = technician ? [technician] : [];
    const message = payload.reassigned
      ? `Is atamasi guncellendi: Ticket ${payload.ticketId} size yeniden atandi.`
      : `Yeni is atamasi: Ticket ${payload.ticketId} size atandi.`;
    await this.commitFanOut(
      event,
      dedupeByPhone(recipients),
      SMS_METHODS.TICKET_NOTIFICATION,
      message,
    );
  }

  private parse<T>(schema: z.ZodType<T>, event: ClaimedOutboxEvent): T {
    const result = schema.safeParse(event.payload);
    if (!result.success) {
      throw new NonRetryableDispatchError(
        `${event.eventType} payload dogrulamasi basarisiz: ${result.error.message}`,
      );
    }
    return result.data;
  }

  private async commitFanOut(
    event: ClaimedOutboxEvent,
    recipients: RecipientContact[],
    smsMethod: SmsMethod,
    message: string,
  ): Promise<void> {
    if (recipients.length === 0) {
      // Soft-success: tanınan eventType ama su an cozulebilen alici yok
      // (ör. aktif hic OPERATIONS kullanicisi yok). Hata DEGIL - retry
      // "duzeltmez", her yeni event kendi anlik listesini cozer (plan
      // Bolum 4).
      await this.prisma.$transaction(async (tx) => {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'PROCESSED', processedAt: new Date(), nextAttemptAt: null },
        });
        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.NOTIFICATION_FANOUT_NO_RECIPIENTS,
          entityType: 'OutboxEvent',
          entityId: event.id,
          metadata: { eventType: event.eventType, recipientCount: 0 },
        });
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      for (const recipient of recipients) {
        await tx.notificationDelivery.create({
          data: {
            sourceEventId: event.id,
            sourceEventType: event.eventType,
            channel: 'SMS',
            smsMethod,
            recipientUserId: recipient.userId,
            recipientPhone: recipient.phoneNumber,
            message,
          },
        });
      }
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: new Date(), nextAttemptAt: null },
      });
    });
  }

  private async markProcessed(eventId: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: { status: 'PROCESSED', processedAt: new Date(), nextAttemptAt: null },
    });
  }
}

// Anahtar HER ZAMAN normalize edilmis telefon numarasidir (UserContactLookupService
// garantisi) - ayni fiziksel numaraya rol/uyelik cakismasi yuzunden iki kez
// SMS gitmesini onler (plan Bolum 6.5, onaylanan ek zorunluluk).
function dedupeByPhone(recipients: RecipientContact[]): RecipientContact[] {
  const seen = new Set<string>();
  const deduped: RecipientContact[] = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.phoneNumber)) continue;
    seen.add(recipient.phoneNumber);
    deduped.push(recipient);
  }
  return deduped;
}
