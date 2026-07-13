import { AUTH_AUDIT_ACTIONS } from '../../../infrastructure/audit/auth-audit-actions.constant';
import { RateLimitExceededError } from '../../../infrastructure/rate-limit/rate-limit-exceeded.error';
import { AuthService } from './auth.service';
import { hmacSha256 } from '../utils/otp-crypto.util';

describe('AuthService.verifyOtp', () => {
  const phone = '+905551234567';
  const code = '123456';
  const otpHmacSecret = 'a'.repeat(32);
  const ctx = { ip: '127.0.0.1', userAgent: 'jest' };

  function buildService(options: {
    challenge?: unknown;
    findActiveByIdResult?: unknown;
    hasActiveSiteMembershipResult?: boolean;
  }) {
    const tx = 'tx-marker';
    const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)) };
    const otpService = { requestOtp: jest.fn().mockResolvedValue(undefined) };
    const tokenService = {
      signAccessTokenWithCompensation: jest.fn().mockResolvedValue('signed.jwt.token'),
      rotate: jest.fn(),
      revoke: jest.fn(),
    };
    const otpChallengeRepo = {
      findActiveForUpdate: jest.fn().mockResolvedValue(options.challenge ?? null),
      invalidate: jest.fn().mockResolvedValue(undefined),
      incrementAttemptAndMaybeInvalidate: jest
        .fn()
        .mockResolvedValue({ attemptCount: 1, invalidated: false }),
      consume: jest.fn().mockResolvedValue(undefined),
    };
    const userAuthRepo = {
      findActiveById: jest.fn().mockResolvedValue(options.findActiveByIdResult ?? null),
      touchLastLogin: jest.fn().mockResolvedValue(undefined),
    };
    const membershipQuery = {
      hasAnyActiveSiteMembership: jest
        .fn()
        .mockResolvedValue(options.hasActiveSiteMembershipResult ?? false),
    };
    const refreshSessionRepo = { create: jest.fn().mockResolvedValue(undefined) };
    const rateLimiter = { consume: jest.fn().mockResolvedValue(undefined) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'auth.otpHmacSecret': otpHmacSecret,
          'auth.refreshTokenExpiresInSeconds': 2592000,
          'auth.refreshTokenPepper': 'pepper-value-32-characters-min!!',
          'auth.jwtAccessExpiresInSeconds': 900,
        };
        return values[key];
      }),
    };

    const service = new AuthService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      otpService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tokenService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      otpChallengeRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userAuthRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      membershipQuery as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      refreshSessionRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rateLimiter as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config as any,
    );

    return {
      service,
      prisma,
      otpChallengeRepo,
      userAuthRepo,
      membershipQuery,
      refreshSessionRepo,
      rateLimiter,
      audit,
      tokenService,
    };
  }

  function baseChallenge(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ch-1',
      userId: 'user-1',
      phoneNumber: phone,
      purpose: 'LOGIN',
      codeHash: hmacSha256(otpHmacSecret, `${phone}:${code}`),
      expiresAt: new Date(Date.now() + 60000),
      consumedAt: null,
      invalidatedAt: null,
      attemptCount: 0,
      maxAttempts: 5,
      requestedIp: '127.0.0.1',
      userAgent: null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('challenge bulunamazsa AUTH_INVALID_OTP firlatir (transaction throw etmez)', async () => {
    const { service, prisma } = buildService({ challenge: null });

    await expect(service.verifyOtp(phone, code, ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });
    await expect(prisma.$transaction.mock.results[0]?.value).resolves.toBeDefined();
  });

  it('savunmaci on-kontrol: attemptCount>=maxAttempts olan satir hash hic karsilastirilmadan reddedilir', async () => {
    const challenge = baseChallenge({ attemptCount: 5, maxAttempts: 5 });
    const { service, otpChallengeRepo, audit } = buildService({ challenge });

    await expect(service.verifyOtp(phone, code, ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });

    expect(otpChallengeRepo.invalidate).toHaveBeenCalledWith('tx-marker', 'ch-1');
    expect(otpChallengeRepo.incrementAttemptAndMaybeInvalidate).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.OTP_MAX_ATTEMPTS_REACHED }),
    );
  });

  it('yanlis kodda attemptCount atomik olarak artirilir ve OTP_VERIFY_FAILED audit yazilir', async () => {
    const challenge = baseChallenge();
    const { service, otpChallengeRepo, audit } = buildService({ challenge });
    otpChallengeRepo.incrementAttemptAndMaybeInvalidate.mockResolvedValue({
      attemptCount: 1,
      invalidated: false,
    });

    await expect(service.verifyOtp(phone, 'WRONG1', ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });

    expect(otpChallengeRepo.incrementAttemptAndMaybeInvalidate).toHaveBeenCalledWith(
      'tx-marker',
      'ch-1',
      5,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.OTP_VERIFY_FAILED }),
    );
  });

  it('5. hatali denemede attemptCount artisiyla BIRLIKTE ayni transactionda invalid edilir', async () => {
    const challenge = baseChallenge({ attemptCount: 4, maxAttempts: 5 });
    const { service, otpChallengeRepo, audit } = buildService({ challenge });
    otpChallengeRepo.incrementAttemptAndMaybeInvalidate.mockResolvedValue({
      attemptCount: 5,
      invalidated: true,
    });

    await expect(service.verifyOtp(phone, 'WRONG1', ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: AUTH_AUDIT_ACTIONS.OTP_MAX_ATTEMPTS_REACHED,
        metadata: expect.objectContaining({ attemptCount: 5 }),
      }),
    );
  });

  it('OtpChallenge.userId null ise NOT_ELIGIBLE -> AUTH_INVALID_OTP (kullanici sorgusu hic yapilmaz)', async () => {
    const challenge = baseChallenge({ userId: null });
    const { service, userAuthRepo } = buildService({ challenge });

    await expect(service.verifyOtp(phone, code, ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });
    expect(userAuthRepo.findActiveById).not.toHaveBeenCalled();
  });

  it('kullanici artik aktif degilse NOT_ELIGIBLE -> AUTH_INVALID_OTP', async () => {
    const challenge = baseChallenge();
    const { service } = buildService({ challenge, findActiveByIdResult: null });

    await expect(service.verifyOtp(phone, code, ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });
  });

  it('RESIDENT icin aktif site uyeligi yoksa NOT_ELIGIBLE -> AUTH_INVALID_OTP', async () => {
    const challenge = baseChallenge();
    const user = {
      id: 'user-1',
      role: 'RESIDENT',
      isActive: true,
      tokenVersion: 0,
      firstName: 'A',
      lastName: 'B',
    };
    const { service, refreshSessionRepo } = buildService({
      challenge,
      findActiveByIdResult: user,
      hasActiveSiteMembershipResult: false,
    });

    await expect(service.verifyOtp(phone, code, ctx)).rejects.toMatchObject({
      code: 'AUTH_INVALID_OTP',
    });
    expect(refreshSessionRepo.create).not.toHaveBeenCalled();
  });

  it('basarili girişte tek transactionda refresh session olusturulur, lastLogin guncellenir, audit yazilir ve JWT doner', async () => {
    const challenge = baseChallenge();
    const user = {
      id: 'user-1',
      role: 'RESIDENT',
      isActive: true,
      tokenVersion: 3,
      firstName: 'Ali',
      lastName: 'Veli',
    };
    const { service, refreshSessionRepo, userAuthRepo, audit, tokenService } = buildService({
      challenge,
      findActiveByIdResult: user,
      hasActiveSiteMembershipResult: true,
    });

    const result = await service.verifyOtp(phone, code, ctx);

    expect(refreshSessionRepo.create).toHaveBeenCalledTimes(1);
    expect(userAuthRepo.touchLastLogin).toHaveBeenCalledWith('tx-marker', 'user-1');
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: AUTH_AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS }),
    );
    expect(tokenService.signAccessTokenWithCompensation).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.user).toEqual({ id: 'user-1', role: 'RESIDENT', fullName: 'Ali Veli' });
    expect(result.expiresIn).toBe(900);
  });

  it('OPERATIONS rolu icin membership kontrolu yapilmadan basarili login olur', async () => {
    const challenge = baseChallenge();
    const user = {
      id: 'ops-1',
      role: 'OPERATIONS',
      isActive: true,
      tokenVersion: 0,
      firstName: 'Op',
      lastName: 'S',
    };
    const { service, membershipQuery } = buildService({ challenge, findActiveByIdResult: user });

    const result = await service.verifyOtp(phone, code, ctx);

    expect(membershipQuery.hasAnyActiveSiteMembership).not.toHaveBeenCalled();
    expect(result.user.role).toBe('OPERATIONS');
  });

  it('verify IP rate limiti asilirsa AUTH_RATE_LIMITED firlatir ve transaction hic baslamaz', async () => {
    const { service, rateLimiter, prisma } = buildService({});
    rateLimiter.consume.mockRejectedValueOnce(new RateLimitExceededError('otpVerifyIp'));

    await expect(service.verifyOtp(phone, code, ctx)).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMITED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AuthService.requestOtp', () => {
  it('gecersiz telefon formati icin dogrudan VALIDATION_ERROR firlatir (otpService hic cagrilmaz)', async () => {
    const otpService = { requestOtp: jest.fn() };
    const service = new AuthService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      otpService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    await expect(service.requestOtp('not-a-phone', { ip: '127.0.0.1' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(otpService.requestOtp).not.toHaveBeenCalled();
  });
});
