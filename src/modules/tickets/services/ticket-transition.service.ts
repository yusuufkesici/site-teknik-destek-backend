import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { Prisma } from '../../../generated/prisma-client/client';
import type { TicketStatus } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { OutboxService } from '../../../infrastructure/events/outbox.service';
import type {
  ApplyStatusTransitionParams,
  TicketTransitionPort,
} from '../ports/ticket-transition.port';
import type { TicketRow } from '../repositories/ticket.repository';
import { TicketRepository } from '../repositories/ticket.repository';
import { TicketStateMachine } from '../state/ticket-state-machine';

// Faz 5 Bolum 2: eskiden TicketService.applyTransition icinde inline duran
// cekirdek mantik (transaction acma ve faz-policy kontrolu HARIC). Hem
// TicketService kendi icinde dogrudan, hem AssignmentsModule
// TICKET_TRANSITION_PORT uzerinden bu servisi kullanir - tek implementasyon,
// iki cagiran.
@Injectable()
export class TicketTransitionService implements TicketTransitionPort {
  constructor(
    private readonly ticketRepo: TicketRepository,
    private readonly stateMachine: TicketStateMachine,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxService,
  ) {}

  async lockAndGet(tx: Prisma.TransactionClient, ticketId: string): Promise<TicketRow> {
    const ticket = await this.ticketRepo.findByIdForUpdate(tx, ticketId);
    if (!ticket) {
      throw new DomainError(
        ERROR_CODES.TICKET_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket bulunamadi.',
      );
    }
    return ticket;
  }

  async applyStatusTransition(
    tx: Prisma.TransactionClient,
    params: ApplyStatusTransitionParams,
  ): Promise<TicketRow> {
    const { actor, ticket, toStatus, reason, auditAction } = params;

    // Kendi kendine yeterli (self-contained): cagiran taraf (TicketService
    // veya AssignmentsModule) kendi ek kontrollerini yapmis olsa da, bu
    // metot state machine dogrulamasini KENDISI de yapar - tek DB yazim
    // noktasi asla dogrulamasiz calismaz.
    this.stateMachine.assertTransition(ticket.status, toStatus, actor.role, reason);

    const extra = this.buildExtraFields(toStatus, reason);

    const updated = await this.ticketRepo.updateStatus(
      tx,
      ticket.id,
      ticket.version,
      toStatus,
      extra,
    );
    if (!updated) {
      throw new DomainError(
        ERROR_CODES.CONCURRENT_MODIFICATION,
        HttpStatus.CONFLICT,
        'Ticket baska bir islemle guncellenmis.',
      );
    }

    await this.ticketRepo.addHistory(tx, {
      ticketId: ticket.id,
      previousStatus: ticket.status,
      newStatus: toStatus,
      changedByUserId: actor.id,
      reason: reason ?? null,
      metadata: null,
    });

    // Duzeltme #7 (Faz 4): audit metadata'sina ham reason YAZILMAZ.
    await this.audit.log(tx, {
      action: auditAction,
      actorUserId: actor.id,
      entityType: 'Ticket',
      entityId: ticket.id,
      siteId: ticket.siteId,
      metadata: { from: ticket.status, to: toStatus, reasonProvided: Boolean(reason?.trim()) },
    });

    // Duzeltme #7 (Faz 4): outbox payload'inda reason/title/description YOK.
    await this.outbox.publishInTx(tx, {
      eventType: 'TicketStatusChanged',
      aggregateType: 'Ticket',
      aggregateId: ticket.id,
      payload: {
        ticketId: ticket.id,
        ticketCode: ticket.code,
        siteId: ticket.siteId,
        previousStatus: ticket.status,
        newStatus: toStatus,
        actorUserId: actor.id,
      },
    });

    return updated;
  }

  private buildExtraFields(
    toStatus: TicketStatus,
    reason: string | undefined,
  ): { cancelledAt?: Date; cancellationReason?: string; completedAt?: Date } {
    if (toStatus === 'CANCELLED') {
      if (!reason?.trim()) {
        throw new DomainError(
          ERROR_CODES.TICKET_TRANSITION_REASON_REQUIRED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Bu gecis icin gerekce zorunlu.',
        );
      }
      return { cancelledAt: new Date(), cancellationReason: reason };
    }
    if (toStatus === 'COMPLETED') {
      return { completedAt: new Date() };
    }
    return {};
  }
}
