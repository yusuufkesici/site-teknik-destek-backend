import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { FacilityRow } from '../../facilities/repositories/facility.repository';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import { ResidentUnitAssignmentRepository } from '../../memberships/repositories/resident-unit-assignment.repository';
import type { UpdateTicketDto } from '../dto/update-ticket.dto';
import type { TicketRow } from '../repositories/ticket.repository';
import { TicketRepository } from '../repositories/ticket.repository';

// Onaylanan Faz 4 plani Bolum 7: tum yetki mantigi burada - service'te
// inline kontrol yok (Faz 3'un UserAccessPolicy konvansiyonuyla tutarli,
// architecture.md Bolum 12'nin create-yetkisini service'e gomen ornek
// kodundan bilincli sapma).
@Injectable()
export class TicketAuthorizationPolicy {
  constructor(
    private readonly membershipQuery: MembershipQueryService,
    private readonly residentUnitAssignmentRepo: ResidentUnitAssignmentRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  // Duzeltme #8: ticket henuz olusmadigi icin TICKET_NOT_FOUND semantik
  // olarak yanlis - erisim reddi FACILITY_NOT_FOUND doner.
  async assertCanCreate(
    actor: AuthenticatedUser,
    facility: FacilityRow,
    client: PrismaClientLike,
  ): Promise<void> {
    if (actor.role === 'TECHNICIAN') {
      throw new DomainError(
        ERROR_CODES.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Teknisyen ticket olusturamaz.',
      );
    }

    if (actor.role === 'RESIDENT') {
      if (facility.type !== 'UNIT') this.facilityNotFound();
      const assignment = await this.residentUnitAssignmentRepo.findActiveForUser(client, actor.id);
      if (!assignment || assignment.unitId !== facility.id) this.facilityNotFound();
      return;
    }

    if (actor.role === 'SITE_MANAGER') {
      // chk_facility_root DB kisiti SITE-disi facility'lerde siteId'nin
      // hep dolu oldugunu garanti eder; yine de tipe guvenmek yerine acikca
      // dogrulanir (non-null assertion kullanilmaz).
      if (!facility.siteId) this.facilityNotFound();
      const ok = await this.membershipQuery.hasActiveManagerMembership(actor.id, facility.siteId, {
        client,
      });
      if (!ok) this.facilityNotFound();
      return;
    }

    // OPERATIONS: kosulsuz
  }

  async assertCanRead(
    actor: AuthenticatedUser,
    ticket: TicketRow,
    client: PrismaClientLike,
  ): Promise<void> {
    switch (actor.role) {
      case 'RESIDENT': {
        if (ticket.createdByUserId !== actor.id) this.ticketNotFound();
        const hasMembership = await this.membershipQuery.hasActiveSiteMembership(
          actor.id,
          ticket.siteId,
          {
            client,
          },
        );
        if (!hasMembership) this.ticketNotFound();
        return;
      }
      case 'SITE_MANAGER': {
        const isManager = await this.membershipQuery.hasActiveManagerMembership(
          actor.id,
          ticket.siteId,
          {
            client,
          },
        );
        if (!isManager) this.ticketNotFound();
        return;
      }
      case 'TECHNICIAN': {
        const hasAssignment = await this.ticketRepo.existsAssignmentForTechnician(
          client,
          ticket.id,
          actor.id,
        );
        if (!hasAssignment) this.ticketNotFound();
        return;
      }
      case 'OPERATIONS':
        return; // kosulsuz - Bolum 3 karar #1 (overrides.md #5 kazanir)
    }
  }

  assertCanUpdateFields(actor: AuthenticatedUser, ticket: TicketRow, dto: UpdateTicketDto): void {
    if (dto.operationNote !== undefined && actor.role !== 'OPERATIONS') {
      throw new DomainError(
        ERROR_CODES.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'operationNote yalniz OPERATIONS tarafindan yazilabilir.',
      );
    }

    const wantsContentChange =
      dto.title !== undefined ||
      dto.description !== undefined ||
      dto.category !== undefined ||
      dto.urgency !== undefined;

    if (!wantsContentChange || actor.role === 'OPERATIONS') return;

    if (
      actor.role === 'RESIDENT' &&
      (ticket.createdByUserId !== actor.id || ticket.status !== 'OPEN')
    ) {
      throw new DomainError(
        ERROR_CODES.TICKET_UPDATE_FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Ticket bu durumda guncellenemez.',
      );
    }

    if (actor.role === 'SITE_MANAGER' && !['OPEN', 'TRIAGED'].includes(ticket.status)) {
      throw new DomainError(
        ERROR_CODES.TICKET_UPDATE_FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Ticket bu durumda guncellenemez.',
      );
    }
  }

  private facilityNotFound(): never {
    throw new DomainError(
      ERROR_CODES.FACILITY_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Facility bulunamadi.',
    );
  }

  private ticketNotFound(): never {
    throw new DomainError(ERROR_CODES.TICKET_NOT_FOUND, HttpStatus.NOT_FOUND, 'Ticket bulunamadi.');
  }
}
