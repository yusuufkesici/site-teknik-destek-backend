import { ContractStateMachine } from './contract-state-machine';
import type { ContractStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 7 plani Bolum 7/19: 5x5 gecis matrisinin TUM hucreleri +
// katı EXPIRED siniri (endDate === bugun -> RED) + aktivasyon guard'i.
describe('ContractStateMachine', () => {
  const machine = new ContractStateMachine();
  const STATUSES: ContractStatus[] = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED'];

  const today = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15
  const futureEnd = new Date(Date.UTC(2026, 11, 31));
  const pastEnd = new Date(Date.UTC(2026, 0, 31));

  // Gecerli gecisler (guard'lar saglanmis kabul edilerek).
  const ALLOWED: Record<ContractStatus, ContractStatus[]> = {
    DRAFT: ['ACTIVE', 'TERMINATED'],
    ACTIVE: ['SUSPENDED', 'EXPIRED', 'TERMINATED'],
    SUSPENDED: ['ACTIVE', 'EXPIRED', 'TERMINATED'],
    EXPIRED: [],
    TERMINATED: [],
  };

  function contextFor(to: ContractStatus) {
    // EXPIRED hedefi icin endDate gecmiste, digerleri icin gelecekte olmali
    // ki tablo-hucresi davranisi guard'a takilmadan test edilebilsin.
    return { finalEndDate: to === 'EXPIRED' ? pastEnd : futureEnd, today };
  }

  describe('tam gecis matrisi (25 hucre)', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) {
          it(`${from} -> ${to}: 409 CONTRACT_STATUS_UNCHANGED`, () => {
            expect(() => machine.assertTransition(from, to, contextFor(to))).toThrow(
              expect.objectContaining({ code: 'CONTRACT_STATUS_UNCHANGED' }),
            );
          });
        } else if (ALLOWED[from].includes(to)) {
          it(`${from} -> ${to}: izinli`, () => {
            expect(() => machine.assertTransition(from, to, contextFor(to))).not.toThrow();
          });
        } else {
          it(`${from} -> ${to}: 409 CONTRACT_INVALID_STATUS_TRANSITION`, () => {
            expect(() => machine.assertTransition(from, to, contextFor(to))).toThrow(
              expect.objectContaining({ code: 'CONTRACT_INVALID_STATUS_TRANSITION' }),
            );
          });
        }
      }
    }
  });

  describe('aktivasyon guard: endDate >= bugun', () => {
    it('endDate gecmiste ise DRAFT->ACTIVE reddedilir (END_DATE_ALREADY_PASSED)', () => {
      expect(() =>
        machine.assertTransition('DRAFT', 'ACTIVE', { finalEndDate: pastEnd, today }),
      ).toThrow(
        expect.objectContaining({
          code: 'CONTRACT_INVALID_STATUS_TRANSITION',
          meta: expect.objectContaining({ reason: 'END_DATE_ALREADY_PASSED' }),
        }),
      );
    });

    it('endDate === bugun ise aktivasyon IZINLIDIR (sozlesme o gun boyunca gecerli)', () => {
      expect(() =>
        machine.assertTransition('DRAFT', 'ACTIVE', { finalEndDate: today, today }),
      ).not.toThrow();
      expect(() =>
        machine.assertTransition('SUSPENDED', 'ACTIVE', { finalEndDate: today, today }),
      ).not.toThrow();
    });

    it('endDate gecmiste ise SUSPENDED->ACTIVE de reddedilir', () => {
      expect(() =>
        machine.assertTransition('SUSPENDED', 'ACTIVE', { finalEndDate: pastEnd, today }),
      ).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID_STATUS_TRANSITION' }));
    });
  });

  describe('KATI EXPIRED siniri: yalniz endDate < bugun', () => {
    it('endDate === bugun ise ACTIVE->EXPIRED REDDEDILIR (kati sinir)', () => {
      expect(() =>
        machine.assertTransition('ACTIVE', 'EXPIRED', { finalEndDate: today, today }),
      ).toThrow(
        expect.objectContaining({
          code: 'CONTRACT_INVALID_STATUS_TRANSITION',
          meta: expect.objectContaining({ reason: 'END_DATE_NOT_YET_REACHED' }),
        }),
      );
    });

    it('endDate === bugun ise SUSPENDED->EXPIRED de reddedilir', () => {
      expect(() =>
        machine.assertTransition('SUSPENDED', 'EXPIRED', { finalEndDate: today, today }),
      ).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID_STATUS_TRANSITION' }));
    });

    it('endDate dun ise ACTIVE->EXPIRED izinlidir', () => {
      const yesterday = new Date(Date.UTC(2026, 6, 14));
      expect(() =>
        machine.assertTransition('ACTIVE', 'EXPIRED', { finalEndDate: yesterday, today }),
      ).not.toThrow();
    });

    it('endDate gelecekte ise ACTIVE->EXPIRED reddedilir', () => {
      expect(() =>
        machine.assertTransition('ACTIVE', 'EXPIRED', { finalEndDate: futureEnd, today }),
      ).toThrow(expect.objectContaining({ code: 'CONTRACT_INVALID_STATUS_TRANSITION' }));
    });
  });

  it('ayni-durum kontrolu tablo kontrolunden ONCE calisir (terminal durumda bile UNCHANGED doner)', () => {
    expect(() =>
      machine.assertTransition('TERMINATED', 'TERMINATED', { finalEndDate: futureEnd, today }),
    ).toThrow(expect.objectContaining({ code: 'CONTRACT_STATUS_UNCHANGED' }));
    expect(() =>
      machine.assertTransition('EXPIRED', 'EXPIRED', { finalEndDate: pastEnd, today }),
    ).toThrow(expect.objectContaining({ code: 'CONTRACT_STATUS_UNCHANGED' }));
  });
});
