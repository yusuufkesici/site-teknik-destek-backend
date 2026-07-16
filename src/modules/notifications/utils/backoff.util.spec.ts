import { computeBackoffDelayMs } from './backoff.util';

describe('computeBackoffDelayMs', () => {
  it('attemptCount=0 icin [0, 5000) araliginda deger doner', () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs(0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(5_000);
    }
  });

  it('attemptCount=3 icin ust sinir 5000*2^3=40000 degerini asmaz', () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs(3);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(40_000);
    }
  });

  it('yuksek attemptCount degerlerinde MAX_DELAY_MS (30 dk) tavanini asmaz', () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs(20);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1_800_000);
    }
  });

  it('ayni attemptCount icin ardisik cagrilar full-jitter geregi farkli degerler uretebilir', () => {
    const values = new Set(Array.from({ length: 30 }, () => computeBackoffDelayMs(5)));
    expect(values.size).toBeGreaterThan(1);
  });
});
