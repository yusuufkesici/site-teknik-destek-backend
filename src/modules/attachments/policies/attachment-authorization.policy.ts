import { HttpStatus, Injectable } from '@nestjs/common';
import { TECHNICIAN_ALLOWED_ATTACHMENT_TYPES } from '../../../common/constants/attachment.constant';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { AttachmentType } from '../../../generated/prisma-client/enums';
import type { AssignmentAttachmentCheckRow } from '../../assignments/services/assignment-lookup.service';
import type { TicketRow } from '../../tickets/repositories/ticket.repository';

const ACTIVE_TECHNICIAN_ASSIGNMENT_STATUSES = ['ACCEPTED', 'ACTIVE'] as const;
const UPLOAD_FORBIDDEN_TICKET_STATUSES = ['CLOSED', 'CANCELLED'] as const;

export type AssignmentLookupFn = (
  assignmentId: string,
) => Promise<AssignmentAttachmentCheckRow | null>;

// Onaylanan Faz 6 plani Bolum 7: assignment lookup evrensel/once degil,
// role gore kosullu cagirilir - bir rolun erisemedigi bir assignment
// hakkinda var/yok, kime ait, hangi durumda bilgisi asla sizdirilmaz.
@Injectable()
export class AttachmentAuthorizationPolicy {
  async assertCanUpload(
    actor: AuthenticatedUser,
    ticket: TicketRow,
    rawAssignmentId: string | undefined,
    attachmentType: AttachmentType,
    lookupAssignment: AssignmentLookupFn,
  ): Promise<void> {
    if (actor.role === 'RESIDENT' || actor.role === 'SITE_MANAGER') {
      if (UPLOAD_FORBIDDEN_TICKET_STATUSES.includes(ticket.status as never)) {
        throw new DomainError(
          ERROR_CODES.TICKET_UPDATE_FORBIDDEN,
          HttpStatus.FORBIDDEN,
          'Ticket bu durumda guncellenemez.',
        );
      }
      if (rawAssignmentId !== undefined) {
        // Lookup YAPILMAZ - assignment var olsa bile bilgisi sizdirilmaz.
        throw new DomainError(
          ERROR_CODES.ATTACHMENT_UPLOAD_NOT_ALLOWED,
          HttpStatus.FORBIDDEN,
          'Bu rol assignment iliskili dosya yukleyemez.',
        );
      }
      return;
    }

    if (actor.role === 'TECHNICIAN') {
      if (rawAssignmentId === undefined) throw this.assignmentNotFound();

      const assignment = await lookupAssignment(rawAssignmentId);
      const isOwnActiveCurrentAssignment =
        assignment !== null &&
        assignment.technicianId === actor.id &&
        assignment.isCurrent &&
        ACTIVE_TECHNICIAN_ASSIGNMENT_STATUSES.includes(assignment.status as never);

      if (!isOwnActiveCurrentAssignment) throw this.assignmentNotFound();

      if (assignment.ticketId !== ticket.id) {
        throw new DomainError(
          ERROR_CODES.ATTACHMENT_ASSIGNMENT_MISMATCH,
          HttpStatus.CONFLICT,
          'Assignment bu ticket a ait degil.',
        );
      }

      if (!TECHNICIAN_ALLOWED_ATTACHMENT_TYPES.includes(attachmentType as never)) {
        throw new DomainError(
          ERROR_CODES.ATTACHMENT_TYPE_NOT_ALLOWED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Teknisyen bu attachment tipini kullanamaz.',
        );
      }
      return;
    }

    // OPERATIONS: ticket durumu ve attachmentType'tan bagimsiz izin verilir.
    if (rawAssignmentId !== undefined) {
      const assignment = await lookupAssignment(rawAssignmentId);
      if (!assignment) throw this.assignmentNotFound();
      if (assignment.ticketId !== ticket.id) {
        throw new DomainError(
          ERROR_CODES.ATTACHMENT_ASSIGNMENT_MISMATCH,
          HttpStatus.CONFLICT,
          'Assignment bu ticket a ait degil.',
        );
      }
    }
  }

  private assignmentNotFound(): never {
    throw new DomainError(
      ERROR_CODES.ASSIGNMENT_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Assignment bulunamadi.',
    );
  }
}
