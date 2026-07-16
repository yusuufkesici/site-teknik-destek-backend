// Onaylanan docs/phase-8-plan.md Bolum 4: bozuk/eksik payload uretici
// tarafinda bir bug'dir, retry hicbir zaman duzeltmez - OutboxRelay bu
// hatayi gordugunde kalan deneme hakkindan BAGIMSIZ olarak dogrudan
// FAILED'e gecer (normal retryable backoff dongusune girmez).
export class NonRetryableDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableDispatchError';
  }
}
