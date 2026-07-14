import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import { TicketAuthorizationPolicy } from '../policies/ticket-authorization.policy';
import type { TicketRow } from '../repositories/ticket.repository';
import { TicketRepository } from '../repositories/ticket.repository';

// TicketsModule'un AttachmentsModule icin export ettigi dar servis
// (onaylanan Faz 6 plani Bolum 3) - TicketRepository/
// TicketAuthorizationPolicy hicbir zaman dogrudan export edilmez.
@Injectable()
export class TicketReadAccessService {
  constructor(
    private readonly ticketRepo: TicketRepository,
    private readonly policy: TicketAuthorizationPolicy,
  ) {}

  async assertReadableAndGet(
    actor: AuthenticatedUser,
    ticketId: string,
    client: PrismaClientLike,
  ): Promise<TicketRow> {
    const ticket = await this.ticketRepo.findAliveById(client, ticketId);
    if (!ticket) {
      throw new DomainError(
        ERROR_CODES.TICKET_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket bulunamadi.',
      );
    }
    await this.policy.assertCanRead(actor, ticket, client);
    return ticket;
  }
}
