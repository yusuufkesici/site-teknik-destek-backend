import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import { maskPhone } from '../../../common/utils/mask.util';
import { normalizeE164 } from '../../../common/utils/phone.util';
import { UserRole } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { AUTH_AUDIT_ACTIONS } from '../../../infrastructure/audit/auth-audit-actions.constant';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { RateLimitExceededError } from '../../../infrastructure/rate-limit/rate-limit-exceeded.error';
import { RateLimiterService } from '../../../infrastructure/rate-limit/rate-limiter.service';
import type { ActiveMembership } from '../../memberships/repositories/site-membership.repository';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import { OtpChallengeRepository } from '../repositories/otp-challenge.repository';
import { RefreshSessionRepository } from '../repositories/refresh-session.repository';
import { UserAuthRepository } from '../repositories/user-auth.repository';
import type { RequestContext } from '../types/request-context.type';
import { hashRefreshToken, hmacSha256, timingSafeEqualHex } from '../utils/otp-crypto.util';
import { OtpService } from './otp.service';
import type { TokenPair } from './token.service';
import { TokenService } from './token.service';

export interface AuthenticatedUserSummary {
  id: string;
  role: UserRole;
  fullName: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUserSummary;
}

type OtpVerifyTxResult =
  | { kind: 'SUCCESS'; userId: string; role: UserRole; tokenVersion: number; fullName: string }
  | { kind: 'INVALID_OTP' }
  | { kind: 'NOT_ELIGIBLE' };

// AuthService.verifyOtp: OTP tuketimi + eligibility + refresh session +
// lastLoginAt + audit'in TEK transaction orkestratoru (onaylanan Faz 2
// plani Bolum 5/7, duzeltme #5). Atomik login iki bagimsiz service
// transaction'ina bolunmez.
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly tokenService: TokenService,
    private readonly otpChallengeRepo: OtpChallengeRepository,
    private readonly userAuthRepo: UserAuthRepository,
    private readonly membershipQuery: MembershipQueryService,
    private readonly refreshSessionRepo: RefreshSessionRepository,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  async requestOtp(rawPhone: string, ctx: RequestContext): Promise<{ message: string }> {
    const phone = this.requireNormalizedPhone(rawPhone);
    await this.otpService.requestOtp(phone, ctx);
    // Her kosulda ayni cevap (enumeration korumasi).
    return { message: 'Numara sistemde kayitliysa dogrulama kodu gonderildi.' };
  }

  async verifyOtp(rawPhone: string, code: string, ctx: RequestContext): Promise<LoginResult> {
    const phone = this.requireNormalizedPhone(rawPhone);

    try {
      await this.rateLimiter.consume('otpVerifyIp', `ip:${ctx.ip}`);
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        throw new DomainError(
          ERROR_CODES.AUTH_RATE_LIMITED,
          HttpStatus.TOO_MANY_REQUESTS,
          'Cok fazla deneme yapildi, lutfen daha sonra tekrar deneyin.',
        );
      }
      throw error;
    }

    const otpHmacSecret = this.config.getOrThrow<string>('auth.otpHmacSecret');
    const refreshTtlSeconds = this.config.getOrThrow<number>('auth.refreshTokenExpiresInSeconds');
    const refreshPepper = this.config.getOrThrow<string>('auth.refreshTokenPepper');
    const accessTtlSeconds = this.config.getOrThrow<number>('auth.jwtAccessExpiresInSeconds');

    // Override §7 / duzeltme #4: session id + raw refresh token + hash
    // transaction ONCESI uretilir; yalniz hash DB'ye yazilir.
    const sessionId = randomUUID();
    const rawRefresh = randomBytes(48).toString('base64url');
    const tokenHash = hashRefreshToken(refreshPepper, rawRefresh);

    const result = await this.prisma.$transaction(async (tx): Promise<OtpVerifyTxResult> => {
      const ch = await this.otpChallengeRepo.findActiveForUpdate(tx, phone);
      if (!ch) {
        return { kind: 'INVALID_OTP' };
      }

      // Duzeltme #11 - savunmaci on-kontrol: hash karsilastirmasindan once.
      if (ch.attemptCount >= ch.maxAttempts) {
        await this.otpChallengeRepo.invalidate(tx, ch.id);
        await this.audit.log(tx, {
          action: AUTH_AUDIT_ACTIONS.OTP_MAX_ATTEMPTS_REACHED,
          entityId: ch.id,
          metadata: { phoneMasked: maskPhone(phone), attemptCount: ch.attemptCount },
        });
        return { kind: 'INVALID_OTP' };
      }

      const incoming = hmacSha256(otpHmacSecret, `${phone}:${code}`);
      if (!timingSafeEqualHex(incoming, ch.codeHash)) {
        // Duzeltme #2: tek atomik UPDATE, ayni transaction'da.
        const { attemptCount, invalidated } =
          await this.otpChallengeRepo.incrementAttemptAndMaybeInvalidate(tx, ch.id, ch.maxAttempts);
        await this.audit.log(tx, {
          action: invalidated
            ? AUTH_AUDIT_ACTIONS.OTP_MAX_ATTEMPTS_REACHED
            : AUTH_AUDIT_ACTIONS.OTP_VERIFY_FAILED,
          entityId: ch.id,
          metadata: { phoneMasked: maskPhone(phone), attemptCount },
        });
        return { kind: 'INVALID_OTP' };
      }

      await this.otpChallengeRepo.consume(tx, ch.id);

      // Duzeltme #3: OtpChallenge.userId nullable, ortuk varsayim yapilmaz.
      if (ch.userId === null) {
        return { kind: 'NOT_ELIGIBLE' };
      }

      const user = await this.userAuthRepo.findActiveById(tx, ch.userId);
      if (!user) {
        return { kind: 'NOT_ELIGIBLE' };
      }

      // Duzeltme #3: eligibility kontrolu 'tx' ile, kok PrismaService ile DEGIL.
      const eligible =
        user.role === UserRole.OPERATIONS ||
        user.role === UserRole.TECHNICIAN ||
        (await this.membershipQuery.hasAnyActiveSiteMembership(user.id, { client: tx }));

      if (!eligible) {
        return { kind: 'NOT_ELIGIBLE' };
      }

      await this.refreshSessionRepo.create(tx, {
        id: sessionId,
        userId: user.id,
        tokenHash,
        deviceId: ctx.deviceId,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ip,
        expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
      });
      await this.userAuthRepo.touchLastLogin(tx, user.id);
      await this.audit.log(tx, {
        action: AUTH_AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS,
        actorUserId: user.id,
        entityId: user.id,
        ipAddress: ctx.ip,
      });

      return {
        kind: 'SUCCESS',
        userId: user.id,
        role: user.role,
        tokenVersion: user.tokenVersion,
        fullName: `${user.firstName} ${user.lastName}`,
      };
    });

    if (result.kind !== 'SUCCESS') {
      // INVALID_OTP/NOT_ELIGIBLE hepsi ayni generic hataya eslenir
      // (enumeration korumasi).
      throw new DomainError(
        ERROR_CODES.AUTH_INVALID_OTP,
        HttpStatus.UNAUTHORIZED,
        'Telefon numarasi veya dogrulama kodu gecersiz.',
      );
    }

    const accessToken = await this.tokenService.signAccessTokenWithCompensation(
      { sub: result.userId, role: result.role, sessionId, tokenVersion: result.tokenVersion },
      sessionId,
    );

    return {
      accessToken,
      refreshToken: rawRefresh,
      expiresIn: accessTtlSeconds,
      user: { id: result.userId, role: result.role, fullName: result.fullName },
    };
  }

  async refresh(rawRefreshToken: string, ctx: RequestContext): Promise<TokenPair> {
    return this.tokenService.rotate(rawRefreshToken, ctx);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    await this.tokenService.revoke(rawRefreshToken);
  }

  async me(
    userId: string,
  ): Promise<{ id: string; role: UserRole; fullName: string; memberships: ActiveMembership[] }> {
    const user = await this.userAuthRepo.findActiveById(this.prisma, userId);
    if (!user) {
      throw new DomainError(
        ERROR_CODES.UNAUTHORIZED,
        HttpStatus.UNAUTHORIZED,
        'Kullanici bulunamadi.',
      );
    }

    const memberships = await this.membershipQuery.listActiveMembershipsForUser(userId, {
      client: this.prisma,
    });

    return {
      id: user.id,
      role: user.role,
      fullName: `${user.firstName} ${user.lastName}`,
      memberships,
    };
  }

  private requireNormalizedPhone(rawPhone: string): string {
    const normalized = normalizeE164(rawPhone);
    if (!normalized) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_ERROR,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Gecersiz telefon numarasi formati.',
      );
    }
    return normalized;
  }
}
