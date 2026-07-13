import { RateLimitExceededError } from '../../../infrastructure/rate-limit/rate-limit-exceeded.error';
import {
  AUTH_AUDIT_ACTIONS,
  NIL_UUID,
} from '../../../infrastructure/audit/auth-audit-actions.constant';
import { OtpService } from './otp.service';

describe('OtpService.requestOtp', () => {
  const phone = '+905551234567';
  const ctx = { ip: '127.0.0.1', userAgent: 'jest' };

  function buildService(overrides: {
    findActiveByPhoneResult?: unknown;
    hasActiveSiteMembershipResult?: boolean;
    sendOtpImpl?: () => Promise<void>;
  }) {
    const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn('tx')) };
    const otpRepo = {
      invalidateOpen: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    };
    const userAuthRepo = {
      findActiveByPhone: jest.fn().mockResolvedValue(overrides.findActiveByPhoneResult ?? null),
    };
    const membershipQuery = {
      hasAnyActiveSiteMembership: jest
        .fn()
        .mockResolvedValue(overrides.hasActiveSiteMembershipResult ?? false),
    };
    const sms = {
      sendOtp: overrides.sendOtpImpl
        ? jest.fn(overrides.sendOtpImpl)
        : jest.fn().mockResolvedValue(undefined),
    };
    const rateLimiter = { consume: jest.fn().mockResolvedValue(undefined) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'auth.otpHmacSecret': 'a'.repeat(32),
          'auth.otpExpiresInSeconds': 180,
          'auth.otpMaxAttempts': 5,
        };
        return values[key];
      }),
    };

    const service = new OtpService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      otpRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userAuthRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      membershipQuery as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sms as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rateLimiter as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config as any,
    );

    return { service, prisma, otpRepo, userAuthRepo, membershipQuery, sms, rateLimiter, audit };
  }

  it('kayitli ve uygun RESIDENT icin OTP olusturur ve SMS gonderir', async () => {
    const user = {
      id: 'user-1',
      role: 'RESIDENT',
      isActive: true,
      tokenVersion: 0,
      firstName: 'A',
      lastName: 'B',
    };
    const { service, otpRepo, sms, audit, membershipQuery } = buildService({
      findActiveByPhoneResult: user,
      hasActiveSiteMembershipResult: true,
    });

    await service.requestOtp(phone, ctx);

    expect(membershipQuery.hasAnyActiveSiteMembership).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ client: expect.anything() }),
    );
    expect(otpRepo.invalidateOpen).toHaveBeenCalledWith('tx', phone);
    expect(otpRepo.create).toHaveBeenCalledTimes(1);
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.OTP_REQUESTED }),
    );
  });

  it('OPERATIONS rolu icin contract/membership kontrolu yapilmadan eligible sayilir', async () => {
    const user = {
      id: 'ops-1',
      role: 'OPERATIONS',
      isActive: true,
      tokenVersion: 0,
      firstName: 'Op',
      lastName: 'S',
    };
    const { service, membershipQuery, otpRepo } = buildService({ findActiveByPhoneResult: user });

    await service.requestOtp(phone, ctx);

    expect(membershipQuery.hasAnyActiveSiteMembership).not.toHaveBeenCalled();
    expect(otpRepo.create).toHaveBeenCalledTimes(1);
  });

  it('kayitsiz numarada generic red + audit + hic OTP olusturulmaz (enumeration korumasi)', async () => {
    const { service, otpRepo, audit, sms } = buildService({ findActiveByPhoneResult: null });

    await service.requestOtp(phone, ctx);

    expect(otpRepo.create).not.toHaveBeenCalled();
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: AUTH_AUDIT_ACTIONS.OTP_REQUEST_REJECTED,
        entityId: NIL_UUID,
      }),
    );
  });

  it('uyeligi olmayan RESIDENT icin generic red doner', async () => {
    const user = {
      id: 'res-1',
      role: 'RESIDENT',
      isActive: true,
      tokenVersion: 0,
      firstName: 'A',
      lastName: 'B',
    };
    const { service, otpRepo } = buildService({
      findActiveByPhoneResult: user,
      hasActiveSiteMembershipResult: false,
    });

    await service.requestOtp(phone, ctx);

    expect(otpRepo.create).not.toHaveBeenCalled();
  });

  it('rate limit asiminda istisna disariya sizmaz, generic red doner', async () => {
    const user = {
      id: 'user-1',
      role: 'RESIDENT',
      isActive: true,
      tokenVersion: 0,
      firstName: 'A',
      lastName: 'B',
    };
    const { service, rateLimiter, otpRepo, audit } = buildService({
      findActiveByPhoneResult: user,
      hasActiveSiteMembershipResult: true,
    });
    rateLimiter.consume.mockRejectedValueOnce(new RateLimitExceededError('otpPhone'));

    await expect(service.requestOtp(phone, ctx)).resolves.toBeUndefined();
    expect(otpRepo.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.OTP_REQUEST_REJECTED }),
    );
  });

  it('SMS gonderimi basarisiz olsa da istisna firlatmaz, OTP_DELIVERY_FAILED audit yazar', async () => {
    const user = {
      id: 'user-1',
      role: 'RESIDENT',
      isActive: true,
      tokenVersion: 0,
      firstName: 'A',
      lastName: 'B',
    };
    const { service, audit } = buildService({
      findActiveByPhoneResult: user,
      hasActiveSiteMembershipResult: true,
      sendOtpImpl: () => Promise.reject(new Error('sms down')),
    });

    await expect(service.requestOtp(phone, ctx)).resolves.toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.OTP_DELIVERY_FAILED }),
    );
  });
});
