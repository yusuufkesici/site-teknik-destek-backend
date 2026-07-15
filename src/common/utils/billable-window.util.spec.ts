import {
  addUtcDays,
  computeBillableWindowEnd,
  toUtcDateOnly,
  utcToday,
} from './billable-window.util';

// Onaylanan Faz 7 plani Bolum 19: LEAST formulunun her iki dali + sinir
// degerleri. Pencere ust siniri HARIC (exclusive) tarihtir.
describe('billable-window.util', () => {
  const endDate = new Date(Date.UTC(2026, 11, 31)); // 2026-12-31

  describe('computeBillableWindowEnd', () => {
    it('terminatedAt yoksa endDate + 1 gun doner (ACTIVE/EXPIRED)', () => {
      const windowEnd = computeBillableWindowEnd(endDate, null);
      expect(windowEnd.toISOString().slice(0, 10)).toBe('2027-01-01');
    });

    it('terminatedAt < endDate ise LEAST terminatedAt dalini secer', () => {
      const terminatedAt = new Date('2026-06-15T10:30:00Z');
      const windowEnd = computeBillableWindowEnd(endDate, terminatedAt);
      expect(windowEnd.toISOString().slice(0, 10)).toBe('2026-06-16');
    });

    it('terminatedAt > endDate ise LEAST endDate dalini secer (pencere dogal siniri asamaz)', () => {
      const terminatedAt = new Date('2027-02-10T08:00:00Z');
      const windowEnd = computeBillableWindowEnd(endDate, terminatedAt);
      expect(windowEnd.toISOString().slice(0, 10)).toBe('2027-01-01');
    });

    it('terminatedAt UTC gunu === endDate ise iki dal esittir (endDate + 1)', () => {
      const terminatedAt = new Date('2026-12-31T23:59:59Z');
      const windowEnd = computeBillableWindowEnd(endDate, terminatedAt);
      expect(windowEnd.toISOString().slice(0, 10)).toBe('2027-01-01');
    });

    it('terminatedAt saat bileseni UTC gunune indirgenir (gun ortasi fesih)', () => {
      const terminatedAt = new Date('2026-03-01T00:00:01Z');
      const windowEnd = computeBillableWindowEnd(endDate, terminatedAt);
      expect(windowEnd.toISOString().slice(0, 10)).toBe('2026-03-02');
    });
  });

  describe('toUtcDateOnly / addUtcDays / utcToday', () => {
    it('toUtcDateOnly saat bilesenini UTC geceyarisina indirger', () => {
      const value = new Date('2026-05-10T21:45:12.345Z');
      expect(toUtcDateOnly(value).toISOString()).toBe('2026-05-10T00:00:00.000Z');
    });

    it('addUtcDays ay/yil sinirini dogru gecer', () => {
      const jan31 = new Date(Date.UTC(2026, 0, 31));
      expect(addUtcDays(jan31, 1).toISOString().slice(0, 10)).toBe('2026-02-01');
      const dec31 = new Date(Date.UTC(2026, 11, 31));
      expect(addUtcDays(dec31, 1).toISOString().slice(0, 10)).toBe('2027-01-01');
    });

    it('utcToday UTC geceyarisi bir tarih doner', () => {
      const today = utcToday();
      expect(today.getUTCHours()).toBe(0);
      expect(today.getUTCMinutes()).toBe(0);
      expect(today.getUTCSeconds()).toBe(0);
      expect(today.getUTCMilliseconds()).toBe(0);
    });
  });
});
