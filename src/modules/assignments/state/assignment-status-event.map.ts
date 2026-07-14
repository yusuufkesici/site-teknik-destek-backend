import type { AssignmentStatus, TicketStatus } from '../../../generated/prisma-client/enums';

export const ASSIGNMENT_STATUS_EVENT_NAMES = [
  'EN_ROUTE',
  'ARRIVED',
  'START',
  'WAIT_MATERIAL',
  'RESUME',
  'COMPLETE',
] as const;

export type AssignmentStatusEventName = (typeof ASSIGNMENT_STATUS_EVENT_NAMES)[number];

export interface AssignmentStatusEventRule {
  fromAssignmentStatus: AssignmentStatus;
  toAssignmentStatus: AssignmentStatus;
  toTicketStatus: TicketStatus;
  timestampField?: 'enRouteAt' | 'arrivedAt' | 'startedAt' | 'completedAt';
}

// Faz 5 Bolum 5: saf/test edilebilir esleme tablosu. Rol kisitlamasi burada
// TEKRARLANMAZ - TicketStateMachine'in mevcut tablosundan gelir (ornegin
// WAIT_MATERIAL/RESUME icin OPERATIONS izinli, digerleri icin degil - bu
// zaten TicketStateMachine.TRANSITIONS icinde tanimli).
const ASSIGNMENT_STATUS_EVENTS: Record<AssignmentStatusEventName, AssignmentStatusEventRule> = {
  EN_ROUTE: {
    fromAssignmentStatus: 'ACCEPTED',
    toAssignmentStatus: 'ACTIVE',
    toTicketStatus: 'EN_ROUTE',
    timestampField: 'enRouteAt',
  },
  ARRIVED: {
    fromAssignmentStatus: 'ACTIVE',
    toAssignmentStatus: 'ACTIVE',
    toTicketStatus: 'ARRIVED',
    timestampField: 'arrivedAt',
  },
  START: {
    fromAssignmentStatus: 'ACTIVE',
    toAssignmentStatus: 'ACTIVE',
    toTicketStatus: 'IN_PROGRESS',
    timestampField: 'startedAt',
  },
  WAIT_MATERIAL: {
    fromAssignmentStatus: 'ACTIVE',
    toAssignmentStatus: 'ACTIVE',
    toTicketStatus: 'WAITING_MATERIAL',
  },
  RESUME: {
    fromAssignmentStatus: 'ACTIVE',
    toAssignmentStatus: 'ACTIVE',
    toTicketStatus: 'IN_PROGRESS',
  },
  COMPLETE: {
    fromAssignmentStatus: 'ACTIVE',
    toAssignmentStatus: 'COMPLETED',
    toTicketStatus: 'COMPLETED',
    timestampField: 'completedAt',
  },
};

export function getAssignmentStatusEventRule(
  event: AssignmentStatusEventName,
): AssignmentStatusEventRule {
  return ASSIGNMENT_STATUS_EVENTS[event];
}
