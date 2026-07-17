import { InvoiceStateMachine } from './invoice-state-machine';
import type { InvoiceStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 7 plani Bolum 8/19: 5x5 matrisin tum hucreleri. OVERDUE
// hedefine HICBIR gecis Faz 7'de acik degildir (ISSUED->OVERDUE dahil);
// PAID ve CANCELLED terminaldir; OVERDUE'dan cikis yollari (Faz 8 cron'u
// OVERDUE uretmeye basladiginda) PAID/CANCELLED'dir.
describe('InvoiceStateMachine', () => {
  const machine = new InvoiceStateMachine();
  const STATUSES: InvoiceStatus[] = ['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED'];

  const ALLOWED: Record<InvoiceStatus, InvoiceStatus[]> = {
    DRAFT: ['ISSUED', 'CANCELLED'],
    ISSUED: ['PAID', 'CANCELLED'],
    PAID: [],
    OVERDUE: ['PAID', 'CANCELLED'],
    CANCELLED: [],
  };

  describe('tam gecis matrisi (25 hucre)', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) {
          it(`${from} -> ${to}: 409 INVOICE_STATUS_UNCHANGED`, () => {
            expect(() => machine.assertTransition(from, to)).toThrow(
              expect.objectContaining({ code: 'INVOICE_STATUS_UNCHANGED' }),
            );
          });
        } else if (to === 'OVERDUE') {
          it(`${from} -> ${to}: 409 (Faz 7'de manuel OVERDUE yasak)`, () => {
            expect(() => machine.assertTransition(from, to)).toThrow(
              expect.objectContaining({ code: 'INVOICE_INVALID_STATUS_TRANSITION' }),
            );
          });
        } else if (ALLOWED[from].includes(to)) {
          it(`${from} -> ${to}: izinli`, () => {
            expect(() => machine.assertTransition(from, to)).not.toThrow();
          });
        } else {
          it(`${from} -> ${to}: 409 INVOICE_INVALID_STATUS_TRANSITION`, () => {
            expect(() => machine.assertTransition(from, to)).toThrow(
              expect.objectContaining({ code: 'INVOICE_INVALID_STATUS_TRANSITION' }),
            );
          });
        }
      }
    }
  });

  it('DRAFT -> PAID reddedilir (once ISSUED olmali)', () => {
    expect(() => machine.assertTransition('DRAFT', 'PAID')).toThrow(
      expect.objectContaining({ code: 'INVOICE_INVALID_STATUS_TRANSITION' }),
    );
  });

  it('OVERDUE -> ISSUED geri alma desteklenmez', () => {
    expect(() => machine.assertTransition('OVERDUE', 'ISSUED')).toThrow(
      expect.objectContaining({ code: 'INVOICE_INVALID_STATUS_TRANSITION' }),
    );
  });

  // Faz 8 (plan Bolum 7.1, karar #4): assertSystemOverdueTransition YALNIZ
  // sistem-tetiklemeli InvoiceOverdueScanJob'un kullandigi ayri metot -
  // assertTransition'in "OVERDUE'ya manuel gecis yasak" davranisi (yukaridaki
  // 25 hucre) bu metottan tamamen bagimsiz kalmaya devam eder.
  describe('assertSystemOverdueTransition', () => {
    it('ISSUED -> OVERDUE (sistem yolu): izinli', () => {
      expect(() => machine.assertSystemOverdueTransition('ISSUED')).not.toThrow();
    });

    it.each<InvoiceStatus>(['DRAFT', 'PAID', 'OVERDUE', 'CANCELLED'])(
      '%s -> OVERDUE (sistem yolu): 409 INVOICE_INVALID_STATUS_TRANSITION',
      (from) => {
        expect(() => machine.assertSystemOverdueTransition(from)).toThrow(
          expect.objectContaining({ code: 'INVOICE_INVALID_STATUS_TRANSITION' }),
        );
      },
    );

    it('assertTransition hala ISSUED -> OVERDUE manuel gecisini reddeder (regresyon)', () => {
      expect(() => machine.assertTransition('ISSUED', 'OVERDUE')).toThrow(
        expect.objectContaining({ code: 'INVOICE_INVALID_STATUS_TRANSITION' }),
      );
    });
  });
});
