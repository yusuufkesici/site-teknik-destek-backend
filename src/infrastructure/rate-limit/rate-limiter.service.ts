import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { RateLimitExceededError, type RateLimiterName } from './rate-limit-exceeded.error';

// Dort named singleton limiter; kota/sure yalniz constructor'da bir kez
// kurulur, cagri-basi parametre DEGILDIR (onaylanan Faz 2 plani Bolum 10,
// duzeltme #1). Bellek-ici — tek instance varsayar (plan Bolum 14 risk #2).
@Injectable()
export class RateLimiterService {
  private readonly limiters: Record<RateLimiterName, RateLimiterMemory>;

  constructor(config: ConfigService) {
    this.limiters = {
      otpPhone: new RateLimiterMemory({ points: 3, duration: 600 }),
      otpIp: new RateLimiterMemory({ points: 10, duration: 600 }),
      otpCooldown: new RateLimiterMemory({
        points: 1,
        duration: config.getOrThrow<number>('auth.otpResendCooldownSeconds'),
      }),
      otpVerifyIp: new RateLimiterMemory({ points: 20, duration: 600 }),
    };
  }

  async consume(name: RateLimiterName, key: string): Promise<void> {
    try {
      await this.limiters[name].consume(key, 1);
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        throw new RateLimitExceededError(name, rejection.msBeforeNext);
      }
      throw rejection; // beklenmeyen altyapi hatasi, yutulmaz
    }
  }
}
