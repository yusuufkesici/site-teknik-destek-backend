import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import type { AssignmentWithTicketRow } from '../repositories/assignment.repository';

// Faz 5 Bolum 9/14: GET /assignments/:id/materials icin IDOR matrisi.
// Mutasyon uclarindaki (accept/reject/status/cancel/material-add) sahiplik
// kontrolleri TicketAssignmentWorkflowService icinde, ilgili kilitli satirla
// birlikte yapilir - burada yalniz salt-okunur erisim kontrolu var.
@Injectable()
export class AssignmentAuthorizationPolicy {
  constructor(private readonly membershipQuery: MembershipQueryService) {}

  async assertCanReadMaterials(
    actor: AuthenticatedUser,
    assignment: AssignmentWithTicketRow,
    client: PrismaClientLike,
  ): Promise<void> {
    switch (actor.role) {
      case 'TECHNICIAN':
        if (assignment.technicianId !== actor.id) this.notFound();
        return;
      case 'SITE_MANAGER': {
        const isManager = await this.membershipQuery.hasActiveManagerMembership(
          actor.id,
          assignment.ticket.siteId,
          { client },
        );
        if (!isManager) this.notFound();
        return;
      }
      case 'OPERATIONS':
        return; // kosulsuz
      default:
        this.notFound();
    }
  }

  private notFound(): never {
    throw new DomainError(
      ERROR_CODES.ASSIGNMENT_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Assignment bulunamadi.',
    );
  }
}
