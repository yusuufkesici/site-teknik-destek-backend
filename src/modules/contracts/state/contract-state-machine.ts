import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { ContractStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 7 plani Bolum 7: sozlesme durum gecis tablosu. Butun
// gecisler yalniz OPERATIONS'a aciktir (RolesGuard controller'da keser) -
// bu nedenle TicketStateMachine'in aksine rol parametresi yoktur.
const TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  DRAFT: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'EXPIRED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'EXPIRED', 'TERMINATED'],
  EXPIRED: [],
  TERMINATED: [],
};

export interface ContractTransitionContext {
  // Birlesik PATCH'te onerilen FINAL endDate (dto.endDate ?? mevcut) - plan
  // Bolum 12(e) adim 6: guard'lar final degerler uzerinden calisir.
  finalEndDate: Date;
  // UTC geceyarisina indirgenmis bugun (billable-window.util.utcToday()).
  today: Date;
}

@Injectable()
export class ContractStateMachine {
  assertTransition(
    from: ContractStatus,
    to: ContractStatus,
    context: ContractTransitionContext,
  ): void {
    if (from === to) {
      throw new DomainError(
        ERROR_CODES.CONTRACT_STATUS_UNCHANGED,
        HttpStatus.CONFLICT,
        'Sozlesme zaten bu durumda.',
      );
    }

    if (!TRANSITIONS[from].includes(to)) {
      throw new DomainError(
        ERROR_CODES.CONTRACT_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        `${from} durumundan ${to} durumuna gecis yapilamaz.`,
        { from, to },
      );
    }

    // Plan Bolum 4.2: aktivasyon yalniz endDate >= bugun iken; sozlesme
    // endDate gununun TAMAMI boyunca gecerli sayilir.
    if (to === 'ACTIVE' && context.finalEndDate.getTime() < context.today.getTime()) {
      throw new DomainError(
        ERROR_CODES.CONTRACT_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        'Bitis tarihi gecmis bir sozlesme aktive edilemez.',
        { from, to, reason: 'END_DATE_ALREADY_PASSED' },
      );
    }

    // Plan Bolum 4.2 duzeltme #1 (KATI sinir): EXPIRED yalniz
    // endDate < bugun iken; endDate === bugun ise sozlesme o gun boyunca
    // hala gecerlidir, EXPIRED reddedilir.
    if (to === 'EXPIRED' && context.finalEndDate.getTime() >= context.today.getTime()) {
      throw new DomainError(
        ERROR_CODES.CONTRACT_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        'Bitis tarihi henuz gecmemis bir sozlesme EXPIRED yapilamaz.',
        { from, to, reason: 'END_DATE_NOT_YET_REACHED' },
      );
    }
  }
}
