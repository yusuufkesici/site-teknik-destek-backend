import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { TicketStatus } from '../../../generated/prisma-client/enums';

interface DirectTransition {
  from: TicketStatus;
  to: TicketStatus;
}

// Onaylanan Faz 5 plani Bolum 11: Phase4TicketTransitionPolicy'nin kalici
// yerini alir. Yalnizca assignment akisina AIT OLMAYAN, genel ticket
// endpoint'lerinden (POST /tickets/:id/status, POST /tickets/:id/cancel)
// dogrudan yapilabilecek gecisleri listeler.
//
// Assignment'a ait tum gecisler (TRIAGED->ASSIGNED, REJECTED->ASSIGNED,
// ASSIGNED->ACCEPTED, ASSIGNED->REJECTED, ASSIGNED->CANCELLED,
// ACCEPTED->EN_ROUTE, EN_ROUTE->ARRIVED, ARRIVED->IN_PROGRESS,
// IN_PROGRESS<->WAITING_MATERIAL, IN_PROGRESS->COMPLETED) BURADA YOKTUR -
// yalniz TicketAssignmentWorkflowService (TICKET_TRANSITION_PORT uzerinden)
// bu gecisleri yapabilir. Genel uctan denenirse 409
// TICKET_INVALID_STATUS_TRANSITION doner.
//
// COMPLETED->IN_PROGRESS (reopen) kesinlesen karar geregi (Faz 5 acik karar
// #2 cozumu) bu fazda desteklenmiyor - allowlist'te KASITLI olarak yok.
const DIRECT_TRANSITIONS: ReadonlyArray<DirectTransition> = [
  { from: 'OPEN', to: 'TRIAGED' },
  { from: 'OPEN', to: 'CANCELLED' },
  { from: 'TRIAGED', to: 'CANCELLED' },
  { from: 'COMPLETED', to: 'CLOSED' },
];

@Injectable()
export class TicketDirectTransitionPolicy {
  assertAllowedDirectly(from: TicketStatus, to: TicketStatus): void {
    const allowed = DIRECT_TRANSITIONS.some((t) => t.from === from && t.to === to);
    if (!allowed) {
      throw new DomainError(
        ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        'Bu gecis genel ticket ucundan desteklenmiyor.',
        { from, to },
      );
    }
  }
}
