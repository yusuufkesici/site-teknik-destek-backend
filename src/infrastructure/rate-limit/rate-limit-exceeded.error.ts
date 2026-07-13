export type RateLimiterName = 'otpPhone' | 'otpIp' | 'otpCooldown' | 'otpVerifyIp';

// Ham key (telefon/IP) tasimaz - yalniz hangi limiter'in asildigi ve ne
// zaman sifirlanacagi (onaylanan Faz 2 plani Bolum 10, duzeltme #12).
export class RateLimitExceededError extends Error {
  constructor(
    public readonly limiterName: RateLimiterName,
    public readonly msBeforeNext?: number,
  ) {
    super(`Rate limit exceeded: ${limiterName}`);
  }
}
