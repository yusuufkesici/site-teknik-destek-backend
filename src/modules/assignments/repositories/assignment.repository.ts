import { Injectable } from '@nestjs/common';
import type { CursorPayload } from '../../../common/utils/pagination.util';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { AssignmentStatus, TicketStatus } from '../../../generated/prisma-client/enums';

export interface AssignmentRow {
  id: string;
  ticketId: string;
  technicianId: string;
  assignedByUserId: string;
  assignmentStatus: AssignmentStatus;
  assignedAt: Date;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  enRouteAt: Date | null;
  arrivedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  resolutionNote: string | null;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentWithTicketRow extends AssignmentRow {
  ticket: { id: string; siteId: string; code: string; status: TicketStatus };
}

export interface CreateAssignmentInput {
  ticketId: string;
  technicianId: string;
  assignedByUserId: string;
}

export interface ApplyStatusEventInput {
  assignmentStatus: AssignmentStatus;
  timestampField?: 'enRouteAt' | 'arrivedAt' | 'startedAt' | 'completedAt';
  resolutionNote?: string;
  isCurrent?: boolean;
}

export interface ListForTechnicianFilter {
  technicianId: string;
  status?: AssignmentStatus;
  cursor: CursorPayload | null;
  limit: number;
}

// Faz 5 Bolum 3: kilit sirasini (ticket -> assignment -> diger) bu
// repository DAYATMAZ - TicketAssignmentWorkflowService cagirma sirasiyla
// garanti eder. Assignment tablosunda version kolonu yok; eszamanlilik
// kontrolu tamamen FOR UPDATE satir kilidiyle saglanir.
@Injectable()
export class AssignmentRepository {
  // Ticket kilidinden ONCE hangi ticket'a ait oldugunu ogrenmek icin
  // kilitsiz on-okuma (assignmentId ile gelen tum mutasyon uclarinin ortak
  // ilk adimi - boylece ticket satiri assignment satirindan ONCE kilitlenir).
  async findTicketIdById(client: PrismaClientLike, id: string): Promise<string | null> {
    const row = await client.assignment.findUnique({ where: { id }, select: { ticketId: true } });
    return row?.ticketId ?? null;
  }

  // Faz 9 Slice 4: $queryRawUnsafe yerine tagged $queryRaw - parametreler
  // Prisma tarafindan bind edilir, SQL string birlestirmesi yoktur. SQL
  // metni, FOR UPDATE satir kilidi ve donus tipi degismedi
  // (invoice.repository.findByIdForUpdate ile ayni idiom).
  async findByIdForUpdate(client: PrismaClientLike, id: string): Promise<AssignmentRow | null> {
    const rows = await client.$queryRaw<AssignmentRow[]>`
      SELECT
        id,
        ticket_id AS "ticketId",
        technician_id AS "technicianId",
        assigned_by_user_id AS "assignedByUserId",
        assignment_status AS "assignmentStatus",
        assigned_at AS "assignedAt",
        accepted_at AS "acceptedAt",
        rejected_at AS "rejectedAt",
        rejection_reason AS "rejectionReason",
        en_route_at AS "enRouteAt",
        arrived_at AS "arrivedAt",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        resolution_note AS "resolutionNote",
        is_current AS "isCurrent",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM assignments
      WHERE id = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async findCurrentForUpdate(
    client: PrismaClientLike,
    ticketId: string,
  ): Promise<AssignmentRow | null> {
    const rows = await client.$queryRaw<AssignmentRow[]>`
      SELECT
        id,
        ticket_id AS "ticketId",
        technician_id AS "technicianId",
        assigned_by_user_id AS "assignedByUserId",
        assignment_status AS "assignmentStatus",
        assigned_at AS "assignedAt",
        accepted_at AS "acceptedAt",
        rejected_at AS "rejectedAt",
        rejection_reason AS "rejectionReason",
        en_route_at AS "enRouteAt",
        arrived_at AS "arrivedAt",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        resolution_note AS "resolutionNote",
        is_current AS "isCurrent",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM assignments
      WHERE ticket_id = ${ticketId} AND is_current = true
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  // Frontend enablement plani E4 (docs/frontend-enablement-plan.md Bolum 3):
  // findCurrentForUpdate'in FOR UPDATE'siz, transaction disinda kullanilabilen
  // salt-okunur karsiligi. uq_assignments_one_current_per_ticket partial
  // unique index'i en fazla bir satir garantiler; kilitli metot yalniz
  // workflow transaction'larinda kullanilmaya devam eder.
  async findCurrentByTicketId(
    client: PrismaClientLike,
    ticketId: string,
  ): Promise<AssignmentRow | null> {
    return client.assignment.findFirst({ where: { ticketId, isCurrent: true } });
  }

  async findActiveTechnician(
    client: PrismaClientLike,
    technicianId: string,
  ): Promise<{ id: string } | null> {
    return client.user.findFirst({
      where: { id: technicianId, role: 'TECHNICIAN', isActive: true, deletedAt: null },
      select: { id: true },
    });
  }

  async create(client: PrismaClientLike, input: CreateAssignmentInput): Promise<AssignmentRow> {
    return client.assignment.create({
      data: {
        ticketId: input.ticketId,
        technicianId: input.technicianId,
        assignedByUserId: input.assignedByUserId,
      },
    });
  }

  // Reassign: onceki current PENDING/ACCEPTED/ACTIVE ise REASSIGNED yapilir.
  // Ticket REJECTED durumundan reassign edilirse onceki assignment zaten
  // REJECTED - status DEGISTIRILMEZ (tarihcesi bozulmaz), yalniz isCurrent
  // kapatilir (Faz 5 Bolum 5/7, karar #2 ile tutarli).
  async supersede(
    client: PrismaClientLike,
    id: string,
    newStatus: Extract<AssignmentStatus, 'REASSIGNED'> | null,
  ): Promise<void> {
    await client.assignment.update({
      where: { id },
      data: newStatus ? { assignmentStatus: newStatus, isCurrent: false } : { isCurrent: false },
    });
  }

  async markAccepted(client: PrismaClientLike, id: string): Promise<AssignmentRow> {
    return client.assignment.update({
      where: { id },
      data: { assignmentStatus: 'ACCEPTED', acceptedAt: new Date() },
    });
  }

  async markRejected(client: PrismaClientLike, id: string, reason: string): Promise<AssignmentRow> {
    return client.assignment.update({
      where: { id },
      data: {
        assignmentStatus: 'REJECTED',
        rejectedAt: new Date(),
        rejectionReason: reason,
        isCurrent: false,
      },
    });
  }

  async markCancelled(client: PrismaClientLike, id: string): Promise<AssignmentRow> {
    return client.assignment.update({
      where: { id },
      data: { assignmentStatus: 'CANCELLED', isCurrent: false },
    });
  }

  async applyStatusEvent(
    client: PrismaClientLike,
    id: string,
    input: ApplyStatusEventInput,
  ): Promise<AssignmentRow> {
    const timestampUpdate: Partial<
      Record<'enRouteAt' | 'arrivedAt' | 'startedAt' | 'completedAt', Date>
    > = {};
    if (input.timestampField) {
      timestampUpdate[input.timestampField] = new Date();
    }

    return client.assignment.update({
      where: { id },
      data: {
        assignmentStatus: input.assignmentStatus,
        ...timestampUpdate,
        ...(input.resolutionNote !== undefined ? { resolutionNote: input.resolutionNote } : {}),
        ...(input.isCurrent !== undefined ? { isCurrent: input.isCurrent } : {}),
      },
    });
  }

  async findByIdWithTicket(
    client: PrismaClientLike,
    id: string,
  ): Promise<AssignmentWithTicketRow | null> {
    return client.assignment.findFirst({
      where: { id },
      include: { ticket: { select: { id: true, siteId: true, code: true, status: true } } },
    });
  }

  async listForTechnician(
    client: PrismaClientLike,
    filter: ListForTechnicianFilter,
  ): Promise<AssignmentWithTicketRow[]> {
    const cursorWhere = filter.cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(filter.cursor.createdAt) } },
            { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
          ],
        }
      : {};

    return client.assignment.findMany({
      where: {
        technicianId: filter.technicianId,
        ...(filter.status ? { assignmentStatus: filter.status } : {}),
        ...cursorWhere,
      },
      include: { ticket: { select: { id: true, siteId: true, code: true, status: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }
}
