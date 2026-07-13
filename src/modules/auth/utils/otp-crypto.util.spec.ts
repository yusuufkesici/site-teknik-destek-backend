import {
  generateNumericOtp,
  hashRefreshToken,
  hmacSha256,
  timingSafeEqualHex,
} from './otp-crypto.util';

describe('otp-crypto.util', () => {
  describe('hmacSha256', () => {
    it('ayni secret+payload icin ayni hash uretir', () => {
      const a = hmacSha256('secret', 'payload');
      const b = hmacSha256('secret', 'payload');
      expect(a).toBe(b);
    });

    it('farkli payload icin farkli hash uretir', () => {
      const a = hmacSha256('secret', 'payload-1');
      const b = hmacSha256('secret', 'payload-2');
      expect(a).not.toBe(b);
    });
  });

  describe('timingSafeEqualHex', () => {
    it('ayni hex degerlerde true doner', () => {
      const hash = hmacSha256('secret', 'value');
      expect(timingSafeEqualHex(hash, hash)).toBe(true);
    });

    it('farkli hex degerlerde false doner', () => {
      const a = hmacSha256('secret', 'value-a');
      const b = hmacSha256('secret', 'value-b');
      expect(timingSafeEqualHex(a, b)).toBe(false);
    });

    it('farkli uzunluktaki degerlerde guvenli sekilde false doner', () => {
      expect(timingSafeEqualHex('ab', 'abcd')).toBe(false);
    });
  });

  describe('generateNumericOtp', () => {
    // Math.random KULLANILMADIGININ birincil dogrulamasi statiktir:
    // eslint.config.mjs'deki 'no-restricted-syntax' kurali Math.random()
    // cagrisini proje genelinde derleme zamaninda yasaklar (onaylanan Faz 2
    // plani Bolum 12). Burada yalniz crypto.randomInt tabanli ciktinin
    // beklenen sayisal/uzunluk formatinda oldugu dogrulanir.
    it('istenen uzunlukta, bastan sifirla doldurulmus sayisal kod uretir', () => {
      const code = generateNumericOtp(6);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('cok sayida uretimde her zaman gecerli araliktadir (0-999999)', () => {
      for (let i = 0; i < 50; i += 1) {
        const code = generateNumericOtp(6);
        const value = Number(code);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(10 ** 6);
      }
    });
  });

  describe('hashRefreshToken', () => {
    it('pepper + raw token icin deterministik sha256 hex uretir', () => {
      const a = hashRefreshToken('pepper', 'raw-token');
      const b = hashRefreshToken('pepper', 'raw-token');
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('farkli pepper icin farkli hash uretir', () => {
      const a = hashRefreshToken('pepper-1', 'raw-token');
      const b = hashRefreshToken('pepper-2', 'raw-token');
      expect(a).not.toBe(b);
    });
  });
});
