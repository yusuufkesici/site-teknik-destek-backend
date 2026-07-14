import type { AssignmentRow, AssignmentWithTicketRow } from '../repositories/assignment.repository';

export function toAssignmentResponse(row: AssignmentRow) {
  return {
    id: row.id,
    ticketId: row.ticketId,
    technicianId: row.technicianId,
    assignedByUserId: row.assignedByUserId,
    assignmentStatus: row.assignmentStatus,
    assignedAt: row.assignedAt,
    acceptedAt: row.acceptedAt,
    rejectedAt: row.rejectedAt,
    rejectionReason: row.rejectionReason,
    enRouteAt: row.enRouteAt,
    arrivedAt: row.arrivedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    resolutionNote: row.resolutionNote,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Faz 5 Bolum 12: resident telefonu/adi veya baska PII icermez - ticket
// icin yalniz id/code/status ozet alanlari.
export function toMyAssignmentResponse(row: AssignmentWithTicketRow) {
  return {
    ...toAssignmentResponse(row),
    ticket: { id: row.ticket.id, code: row.ticket.code, status: row.ticket.status },
  };
}
