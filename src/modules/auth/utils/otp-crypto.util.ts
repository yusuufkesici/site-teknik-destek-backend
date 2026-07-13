import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

// crypto.randomInt tabanli — ASLA Math.random (CLAUDE.md, onaylanan Faz 2
// plani karar #7; ayrica eslint.config.mjs'de proje genelinde yasaklandi).
export function generateNumericOtp(length: number): string {
  const max = 10 ** length;
  const value = randomInt(0, max);
  return value.toString().padStart(length, '0');
}

export function hmacSha256(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Timing-safe karsilastirma: uzunluk farkinda erken donmek yerine sabit
// zamanli hale getirmek icin once uzunluk kontrolu yapilir (buffer uzunlugu
// farkliysa timingSafeEqual zaten firlatir).
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

export function hashRefreshToken(pepper: string, rawToken: string): string {
  return createHash('sha256')
    .update(pepper + rawToken)
    .digest('hex');
}
