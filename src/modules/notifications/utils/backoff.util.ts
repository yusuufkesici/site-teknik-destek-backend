import { randomInt } from 'node:crypto';

const BASE_MS = 5_000;
const MAX_DELAY_MS = 1_800_000; // 30 dk

// Full-jitter exponential backoff (AWS deseni) - onaylanan
// docs/phase-8-plan.md Bolum 5.1/5.2: N replika ayni anda hata alsa bile
// senkron retry firtinasini onler. Saf fonksiyon, DB/zaman kaynagina
// bagimli degil - dogrudan birim test edilebilir. Math.random() yerine
// crypto.randomInt() kullanilir (proje lint kurali: guvenli olmayan
// rastgelelik yasak).
export function computeBackoffDelayMs(attemptCount: number): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_MS * 2 ** attemptCount);
  return randomInt(cap);
}
