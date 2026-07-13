import type { ConfigService } from '@nestjs/config';
import { RateLimitExceededError } from './rate-limit-exceeded.error';
import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  function buildService(): RateLimiterService {
    const config = { getOrThrow: jest.fn().mockReturnValue(5) } as unknown as ConfigService;
    return new RateLimiterService(config);
  }

  it('otpPhone limiti (3/600s) 3 istekten sonra asilir', async () => {
    const service = buildService();
    await service.consume('otpPhone', 'phone:+905551234567');
    await service.consume('otpPhone', 'phone:+905551234567');
    await service.consume('otpPhone', 'phone:+905551234567');

    await expect(service.consume('otpPhone', 'phone:+905551234567')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it('farkli named limiter lar birbirinden bagimsiz kota tutar (ayri instance)', async () => {
    const service = buildService();
    await service.consume('otpPhone', 'phone:+905551234567');
    await service.consume('otpPhone', 'phone:+905551234567');
    await service.consume('otpPhone', 'phone:+905551234567');

    await expect(service.consume('otpIp', 'ip:127.0.0.1')).resolves.toBeUndefined();
  });

  it('ayni limiter farkli key icin bagimsiz kota tutar', async () => {
    const service = buildService();
    await service.consume('otpPhone', 'phone:+905551111111');
    await service.consume('otpPhone', 'phone:+905551111111');
    await service.consume('otpPhone', 'phone:+905551111111');

    await expect(service.consume('otpPhone', 'phone:+905552222222')).resolves.toBeUndefined();
  });

  it('otpVerifyIp limiti (20/600s) otpIp limitinden (10/600s) bagimsizdir', async () => {
    const service = buildService();
    for (let i = 0; i < 10; i += 1) {
      await service.consume('otpIp', 'ip:127.0.0.1');
    }
    await expect(service.consume('otpIp', 'ip:127.0.0.1')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    await expect(service.consume('otpVerifyIp', 'ip:127.0.0.1')).resolves.toBeUndefined();
  });

  it('firlatilan hata ham key tasimaz, yalniz limiterName icerir (duzeltme #12)', async () => {
    const service = buildService();
    await service.consume('otpCooldown', 'phone:+905551234567');

    const error = await service
      .consume('otpCooldown', 'phone:+905551234567')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitExceededError);
    const typedError = error as RateLimitExceededError;
    expect(typedError.limiterName).toBe('otpCooldown');
    expect(JSON.stringify(typedError)).not.toContain('+905551234567');
  });
});
