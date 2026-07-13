import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { TicketStatus, UserRole } from '../../../generated/prisma-client/enums';

interface TransitionRule {
  to: TicketStatus;
  roles: UserRole[];
  requiresReason?: boolean;
}

// Onaylanan Faz 4 plani Bolum 8: docs/architecture.md Bolum 10'daki 16
// gecisin tamami, saf/test edilebilir bicimde. Bu tablo GELECEK fazlar
// icin de dogru olsun diye TAM tutulur - ama hicbir Faz 4 endpoint'i bu
// tabloya DOGRUDAN guvenmez (once Phase4TicketTransitionPolicy calisir,
// bkz. phase4-ticket-transition-policy.ts).
const TRANSITIONS: Record<TicketStatus, TransitionRule[]> = {
  OPEN: [
    { to: 'TRIAGED', roles: ['OPERATIONS'] },
    { to: 'CANCELLED', roles: ['RESIDENT', 'SITE_MANAGER', 'OPERATIONS'], requiresReason: true },
  ],
  TRIAGED: [
    { to: 'ASSIGNED', roles: ['OPERATIONS'] },
    { to: 'CANCELLED', roles: ['SITE_MANAGER', 'OPERATIONS'], requiresReason: true },
  ],
  ASSIGNED: [
    { to: 'ACCEPTED', roles: ['TECHNICIAN'] },
    { to: 'REJECTED', roles: ['TECHNICIAN'], requiresReason: true },
    { to: 'CANCELLED', roles: ['OPERATIONS'], requiresReason: true },
  ],
  REJECTED: [{ to: 'ASSIGNED', roles: ['OPERATIONS'] }],
  ACCEPTED: [{ to: 'EN_ROUTE', roles: ['TECHNICIAN'] }],
  EN_ROUTE: [{ to: 'ARRIVED', roles: ['TECHNICIAN'] }],
  ARRIVED: [{ to: 'IN_PROGRESS', roles: ['TECHNICIAN'] }],
  IN_PROGRESS: [
    { to: 'WAITING_MATERIAL', roles: ['TECHNICIAN', 'OPERATIONS'] },
    { to: 'COMPLETED', roles: ['TECHNICIAN'] },
  ],
  WAITING_MATERIAL: [{ to: 'IN_PROGRESS', roles: ['TECHNICIAN', 'OPERATIONS'] }],
  COMPLETED: [
    { to: 'CLOSED', roles: ['OPERATIONS'] },
    { to: 'IN_PROGRESS', roles: ['OPERATIONS'], requiresReason: true },
  ],
  CLOSED: [],
  CANCELLED: [],
};

@Injectable()
export class TicketStateMachine {
  assertTransition(from: TicketStatus, to: TicketStatus, role: UserRole, reason?: string): void {
    if (from === to) {
      throw new DomainError(
        ERROR_CODES.TICKET_STATUS_UNCHANGED,
        HttpStatus.CONFLICT,
        'Ticket zaten bu durumda.',
      );
    }

    const rule = TRANSITIONS[from]?.find((r) => r.to === to);
    if (!rule) {
      throw new DomainError(
        ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        `${from} durumundan ${to} durumuna gecis yapilamaz.`,
        { from, to },
      );
    }

    if (!rule.roles.includes(role)) {
      throw new DomainError(
        ERROR_CODES.TICKET_TRANSITION_FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Bu gecis icin yetkiniz yok.',
        { from, to },
      );
    }

    if (rule.requiresReason && !reason?.trim()) {
      throw new DomainError(
        ERROR_CODES.TICKET_TRANSITION_REASON_REQUIRED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Bu gecis icin gerekce zorunlu.',
        { from, to },
      );
    }
  }
}
