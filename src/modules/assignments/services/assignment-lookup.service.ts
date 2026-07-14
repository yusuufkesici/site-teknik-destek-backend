import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { AssignmentStatus } from '../../../generated/prisma-client/enums';
import { AssignmentRepository } from '../repositories/assignment.repository';

export interface AssignmentAttachmentCheckRow {
  id: string;
  ticketId: string;
  technicianId: string;
  status: AssignmentStatus;
  isCurrent: boolean;
}

// AssignmentsModule'un AttachmentsModule icin export ettigi dar servis
// (onaylanan Faz 6 plani Bolum 3) - AssignmentRepository hicbir zaman
// dogrudan export edilmez. MaterialLookupService ile ayni desen.
@Injectable()
export class AssignmentLookupService {
  constructor(private readonly assignmentRepo: AssignmentRepository) {}

  async findForAttachmentCheck(
    client: PrismaClientLike,
    assignmentId: string,
  ): Promise<AssignmentAttachmentCheckRow | null> {
    const assignment = await this.assignmentRepo.findByIdWithTicket(client, assignmentId);
    if (!assignment) return null;

    return {
      id: assignment.id,
      ticketId: assignment.ticketId,
      technicianId: assignment.technicianId,
      status: assignment.assignmentStatus,
      isCurrent: assignment.isCurrent,
    };
  }
}
