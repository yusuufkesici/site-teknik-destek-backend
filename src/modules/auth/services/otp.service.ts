import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { maskPhone } from '../../../common/utils/mask.util';
import { UserRole } from '../../../generated/prisma-client/enums';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import {
  AUTH_AUDIT_ACTIONS,
  NIL_UUID,
} from '../../../infrastructure/audit/auth-audit-actions.constant';
import { RateLimitExceededError } from '../../../infrastructure/rate-limit/rate-limit-exceeded.error';
import { RateLimiterService } from '../../../infrastructure/rate-limit/rate-limiter.service';
import { SMS_PROVIDER, type SmsProvider } from '../../../infrastructure/sms/sms-provider.interface';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import { OtpChallengeRepository } from '../repositories/otp-challenge.repository';
import { UserAuthRepository, type AuthUser } from '../repositories/user-auth.repository';
import type { RequestContext } from '../types/request-context.type';
import { generateNumericOtp, hmacSha256 } from '../utils/otp-crypto.util';

// YALNIZ requestOtp() akisini yonetir. verifyOtp/login orkestrasyonu
// AuthService'in tek transaction sorumlulugundadir (onaylanan Faz 2 plani
// Bolum 5, duzeltme #5).
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpRepo: OtpChallengeRepository,
    private readonly userAuthRepo: UserAuthRepository,
    private readonly membershipQuery: MembershipQueryService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  async requestOtp(phone: string, ctx: RequestContext): Promise<void> {
    const eligibleUser = await this.checkRateLimitsAndEligibility(phone, ctx);

    if (!eligibleUser) {
      // Enumeration korumasi: rate-limit/cooldown/eligibility red sebebi
      // asla client'a sizmaz, hepsi ayni generic sonuca duser (Bolum 6, adim 6).
      await this.audit.log(this.prisma, {
        action: AUTH_AUDIT_ACTIONS.OTP_REQUEST_REJECTED,
        entityId: NIL_UUID,
        metadata: { phoneMasked: maskPhone(phone) },
        ipAddress: ctx.ip,
      });
      await this.constantDelay();
      return;
    }

    const hmacSecret = this.config.getOrThrow<string>('auth.otpHmacSecret');
    const expiresInSeconds = this.config.getOrThrow<number>('auth.otpExpiresInSeconds');
    const maxAttempts = this.config.getOrThrow<number>('auth.otpMaxAttempts');

    const code = generateNumericOtp(6);
    const codeHash = hmacSha256(hmacSecret, `${phone}:${code}`);

    await this.prisma.$transaction(async (tx) => {
      await this.otpRepo.invalidateOpen(tx, phone);
      await this.otpRepo.create(tx, {
        userId: eligibleUser.id,
        phoneNumber: phone,
        purpose: 'LOGIN',
        codeHash,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
        maxAttempts,
        requestedIp: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });

    try {
      // 'code' hicbir log satirina yazilmaz (CLAUDE.md).
      await this.sms.sendOtp(phone, code);
    } catch {
      await this.audit.log(this.prisma, {
        action: AUTH_AUDIT_ACTIONS.OTP_DELIVERY_FAILED,
        actorUserId: eligibleUser.id,
        metadata: { phoneMasked: maskPhone(phone) },
      });
    }

    await this.audit.log(this.prisma, {
      action: AUTH_AUDIT_ACTIONS.OTP_REQUESTED,
      actorUserId: eligibleUser.id,
      metadata: { phoneMasked: maskPhone(phone) },
      ipAddress: ctx.ip,
    });
  }

  private async checkRateLimitsAndEligibility(
    phone: string,
    ctx: RequestContext,
  ): Promise<AuthUser | null> {
    try {
      await this.rateLimiter.consume('otpPhone', `phone:${phone}`);
      await this.rateLimiter.consume('otpIp', `ip:${ctx.ip}`);
      await this.rateLimiter.consume('otpCooldown', `phone:${phone}`);
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return null;
      }
      throw error;
    }

    const user = await this.userAuthRepo.findActiveByPhone(this.prisma, phone);
    if (!user) {
      return null;
    }

    // Contract kontrolu YOK (karar #1): OPERATIONS/TECHNICIAN icin aktif
    // kullanici yeterli; RESIDENT/SITE_MANAGER icin aktif site uyeligi sarti.
    const eligible =
      user.role === UserRole.OPERATIONS ||
      user.role === UserRole.TECHNICIAN ||
      (await this.membershipQuery.hasAnyActiveSiteMembership(user.id, { client: this.prisma }));

    return eligible ? user : null;
  }

  private async constantDelay(): Promise<void> {
    await sleep(200);
  }
}
