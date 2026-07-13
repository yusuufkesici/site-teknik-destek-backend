import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { TicketStatus } from '../../../generated/prisma-client/enums';

interface Phase4Transition {
  from: TicketStatus;
  to: TicketStatus;
}

// Onaylanan Faz 4 plani Bolum 8, duzeltme #1/#2: Faz 4'un KOSULSUZ
// calisma-zamani siniri. TicketStateMachine gelecek fazlar icin tam/saf
// tablo tanimlar, ama hicbir Faz 4 endpoint'i ona dogrudan guvenmez.
// Bu kontrol, ticket'in DB'de nasil bir durumda oldugu (seed data, manuel
// mudahale, ileride baska bir yol) FARK ETMEKSIZIN calisir - "assignment
// hic olusturulmadigi icin ASSIGNED'a zaten ulasilamaz" varsayimina
// DAYANMAZ. Faz 5 geldiginde bu policy tamamen kaldirilip yerini gercek
// TicketAssignmentWorkflowService (overrides.md Bolum 9) alacak.
const PHASE4_ALLOWED_TRANSITIONS: ReadonlyArray<Phase4Transition> = [
  { from: 'OPEN', to: 'TRIAGED' },
  { from: 'OPEN', to: 'CANCELLED' },
  { from: 'TRIAGED', to: 'CANCELLED' },
];

@Injectable()
export class Phase4TicketTransitionPolicy {
  assertAllowedInThisPhase(from: TicketStatus, to: TicketStatus): void {
    const allowed = PHASE4_ALLOWED_TRANSITIONS.some((t) => t.from === from && t.to === to);
    if (!allowed) {
      throw new DomainError(
        ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        'Bu gecis Faz 4 kapsaminda desteklenmiyor.',
        { from, to },
      );
    }
  }
}
