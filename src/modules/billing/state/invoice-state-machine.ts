import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { InvoiceStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 7 plani Bolum 8: fatura durum gecis tablosu. OVERDUE enum'da
// kalir ama Faz 7'de HICBIR gecisle ulasilamaz (manuel ISSUED->OVERDUE dahil
// reddedilir; otomatik overdue taramasi Faz 8 cron'unun isidir). PAID ve
// CANCELLED terminaldir. Tum gecisler OPERATIONS-only (RolesGuard keser).
const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['PAID', 'CANCELLED'],
  PAID: [],
  OVERDUE: ['PAID', 'CANCELLED'], // Faz 8 cron'u OVERDUE uretmeye basladiginda gecerli cikis yollari.
  CANCELLED: [],
};

@Injectable()
export class InvoiceStateMachine {
  assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
    if (from === to) {
      throw new DomainError(
        ERROR_CODES.INVOICE_STATUS_UNCHANGED,
        HttpStatus.CONFLICT,
        'Fatura zaten bu durumda.',
      );
    }

    // Faz 7 karari: OVERDUE hedefine hicbir gecis acik degil.
    if (to === 'OVERDUE') {
      throw new DomainError(
        ERROR_CODES.INVOICE_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        'OVERDUE durumuna manuel gecis desteklenmiyor.',
        { from, to },
      );
    }

    if (!TRANSITIONS[from].includes(to)) {
      throw new DomainError(
        ERROR_CODES.INVOICE_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        `${from} durumundan ${to} durumuna gecis yapilamaz.`,
        { from, to },
      );
    }
  }

  // Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.1/Revizyon karar #4):
  // OVERDUE'ya YALNIZ sistem-tetiklemeli InvoiceOverdueScanJob ulasir -
  // actor/API yolu (changeStatus -> assertTransition) bu metodu HICBIR
  // SEKILDE kullanmaz, dolayisiyla assertTransition'daki "OVERDUE'ya
  // manuel gecis kapali" guard'i etkilenmez/zayiflamaz. Ayri bir metot
  // olmasinin nedeni tam olarak budur.
  assertSystemOverdueTransition(from: InvoiceStatus): void {
    if (from !== 'ISSUED') {
      throw new DomainError(
        ERROR_CODES.INVOICE_INVALID_STATUS_TRANSITION,
        HttpStatus.CONFLICT,
        `Sistem kaynakli OVERDUE gecisi yalniz ISSUED durumundan yapilabilir (mevcut: ${from}).`,
        { from, to: 'OVERDUE' },
      );
    }
  }
}
