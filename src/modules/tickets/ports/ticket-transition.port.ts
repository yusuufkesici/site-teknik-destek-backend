import type { DomainAuditAction } from '../../../common/constants/domain-audit-actions.constant';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { Prisma } from '../../../generated/prisma-client/client';
import type { TicketStatus } from '../../../generated/prisma-client/enums';
import type { TicketRow } from '../repositories/ticket.repository';

// Faz 5 Bolum 2: AssignmentsModule'un TicketRepository/TicketStateMachine'e
// dogrudan erismesini onlemek icin TicketsModule'un export ettigi tek dar
// port. AssignmentsModule bu token uzerinden inject eder, TicketRepository
// asla export edilmez.
export const TICKET_TRANSITION_PORT = Symbol('TICKET_TRANSITION_PORT');

export interface ApplyStatusTransitionParams {
  actor: AuthenticatedUser;
  ticket: TicketRow;
  toStatus: TicketStatus;
  reason?: string;
  auditAction: DomainAuditAction;
}

export interface TicketTransitionPort {
  // ticket satirini FOR UPDATE ile kilitler ve dondurur - kilit sirasi
  // (ticket -> assignment -> diger) cagiran modulden BAGIMSIZ olarak burada
  // garanti edilir.
  lockAndGet(tx: Prisma.TransactionClient, ticketId: string): Promise<TicketRow>;

  // stateMachine dogrulamasi + durum guncelleme + history/audit/outbox
  // yazimini AYNI transaction'da yapar. Cagiran taraf transaction'i kendi
  // acmis ve ticket'i zaten kilitlemis olmalidir.
  applyStatusTransition(
    tx: Prisma.TransactionClient,
    params: ApplyStatusTransitionParams,
  ): Promise<TicketRow>;
}
