import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import {
  buildPage,
  decodeCursor,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { TicketReadAccessService } from '../../tickets/services/ticket-read-access.service';
import { AssignmentAuthorizationPolicy } from '../policies/assignment-authorization.policy';
import type { ListMyAssignmentsQueryDto } from '../dto/list-my-assignments-query.dto';
import type { AssignmentMaterialWithMaterialRow } from '../repositories/assignment-material.repository';
import { AssignmentMaterialRepository } from '../repositories/assignment-material.repository';
import type { AssignmentRow, AssignmentWithTicketRow } from '../repositories/assignment.repository';
import { AssignmentRepository } from '../repositories/assignment.repository';

const DEFAULT_PAGE_LIMIT = 20;

// Faz 5 Bolum 2: salt-okunur uclar (my-list, materials read, current
// assignment kesfi). Yazma islemleri TicketAssignmentWorkflowService'te
// toplanir.
@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignmentRepo: AssignmentRepository,
    private readonly assignmentMaterialRepo: AssignmentMaterialRepository,
    private readonly authPolicy: AssignmentAuthorizationPolicy,
    private readonly ticketAccess: TicketReadAccessService,
  ) {}

  async listMy(
    actor: AuthenticatedUser,
    query: ListMyAssignmentsQueryDto,
  ): Promise<PaginatedResult<AssignmentWithTicketRow>> {
    let cursor = null;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Gecersiz cursor.',
        );
      }
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const rows = await this.assignmentRepo.listForTechnician(this.prisma, {
      technicianId: actor.id,
      status: query.status,
      cursor,
      limit,
    });
    return buildPage(rows, limit);
  }

  async listMaterials(
    actor: AuthenticatedUser,
    assignmentId: string,
  ): Promise<AssignmentMaterialWithMaterialRow[]> {
    const assignment = await this.assignmentRepo.findByIdWithTicket(this.prisma, assignmentId);
    if (!assignment) {
      throw new DomainError(
        ERROR_CODES.ASSIGNMENT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Assignment bulunamadi.',
      );
    }
    await this.authPolicy.assertCanReadMaterials(actor, assignment, this.prisma);
    return this.assignmentMaterialRepo.listByAssignment(this.prisma, assignmentId);
  }

  // Frontend enablement plani E4: once parent ticket erisimi yeniden
  // dogrulanir (uniform 404 - ticket yok/erisilemezse TICKET_NOT_FOUND),
  // sonra current assignment okunur. Current yoksa (OPEN/TRIAGED/terminal
  // durumlar) 404 ASSIGNMENT_NOT_FOUND doner - bos kaynak icin 200+null
  // zarfi projede kullanilmaz (dev-sms-inbox emsali).
  async getCurrentForTicket(actor: AuthenticatedUser, ticketId: string): Promise<AssignmentRow> {
    await this.ticketAccess.assertReadableAndGet(actor, ticketId, this.prisma);

    const current = await this.assignmentRepo.findCurrentByTicketId(this.prisma, ticketId);
    if (!current) {
      throw new DomainError(
        ERROR_CODES.ASSIGNMENT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Assignment bulunamadi.',
      );
    }

    return current;
  }
}
