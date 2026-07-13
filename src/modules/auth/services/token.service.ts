import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { UserRole } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { AUTH_AUDIT_ACTIONS } from '../../../infrastructure/audit/auth-audit-actions.constant';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { RefreshSessionRepository } from '../repositories/refresh-session.repository';
import type { RequestContext } from '../types/request-context.type';
import { hashRefreshToken } from '../utils/otp-crypto.util';

export interface AccessTokenPayloadInput {
  sub: string;
  role: UserRole;
  sessionId: string;
  tokenVersion: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

type RefreshTxResult =
  | { kind: 'SUCCESS'; newSessionId: string; userId: string; role: UserRole; tokenVersion: number }
  | { kind: 'NOT_FOUND' }
  | { kind: 'EXPIRED' }
  | { kind: 'REUSE_DETECTED' }
  | { kind: 'USER_INACTIVE' };

// TokenService iki ayri sorumluluk tasir: rotate() (kendi transaction'inin
// sahibi) ve signAccessToken()/signAccessTokenWithCompensation() (stateless
// JWT imzalama, DB'siz) — coklu-secret imzalama mantigi tek yerde yasar
// (onaylanan Faz 2 plani Bolum 5/8, duzeltme #5).
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly refreshSessionRepo: RefreshSessionRepository,
    private readonly audit: AuditWriter,
  ) {}

  async signAccessToken(payload: AccessTokenPayloadInput): Promise<string> {
    const secrets = this.config.getOrThrow<string[]>('auth.jwtAccessSecrets');
    const expiresIn = this.config.getOrThrow<number>('auth.jwtAccessExpiresInSeconds');

    return this.jwtService.signAsync(
      {
        sub: payload.sub,
        role: payload.role,
        sessionId: payload.sessionId,
        tokenVersion: payload.tokenVersion,
      },
      { secret: secrets[0], expiresIn, algorithm: 'HS256' },
    );
  }

  // Karar #4: JWT imzalama transaction commit'inden SONRA yapilir; imzalama
  // basarisiz olursa yeni olusturulan refresh session best-effort revoke
  // edilir (telafi). Hem AuthService.verifyOtp hem rotate() bunu kullanir.
  async signAccessTokenWithCompensation(
    payload: AccessTokenPayloadInput,
    sessionIdToRevokeOnFailure: string,
  ): Promise<string> {
    try {
      return await this.signAccessToken(payload);
    } catch (error) {
      try {
        await this.refreshSessionRepo.revoke(this.prisma, sessionIdToRevokeOnFailure);
      } catch (compensationError) {
        this.logger.fatal(
          { err: compensationError, sessionId: sessionIdToRevokeOnFailure },
          'Refresh session telafi revoke islemi basarisiz - manuel temizlik gerekebilir',
        );
      }
      throw error;
    }
  }

  async rotate(rawRefresh: string, ctx: RequestContext): Promise<TokenPair> {
    const pepper = this.config.getOrThrow<string>('auth.refreshTokenPepper');
    const refreshTtlSeconds = this.config.getOrThrow<number>('auth.refreshTokenExpiresInSeconds');
    const accessTtlSeconds = this.config.getOrThrow<number>('auth.jwtAccessExpiresInSeconds');

    // Duzeltme #4: yeni session id/raw token/hash transaction ONCESI uretilir.
    const incomingHash = hashRefreshToken(pepper, rawRefresh);
    const newSessionId = randomUUID();
    const newRaw = randomBytes(48).toString('base64url');
    const newTokenHash = hashRefreshToken(pepper, newRaw);

    const result = await this.prisma.$transaction(async (tx): Promise<RefreshTxResult> => {
      const session = await this.refreshSessionRepo.findByHashForUpdate(tx, incomingHash);
      if (!session) {
        return { kind: 'NOT_FOUND' };
      }

      if (session.revokedAt) {
        // Reuse detection: throw yok, transaction normal commit eder (override §8).
        await this.refreshSessionRepo.revokeAllForUser(tx, session.userId);
        await this.audit.log(tx, {
          action: AUTH_AUDIT_ACTIONS.REFRESH_TOKEN_REUSE_DETECTED,
          actorUserId: session.userId,
          entityId: session.id,
        });
        return { kind: 'REUSE_DETECTED' };
      }

      if (session.expiresAt < new Date()) {
        return { kind: 'EXPIRED' };
      }

      const user = await tx.user.findFirst({
        where: { id: session.userId, isActive: true, deletedAt: null },
        select: { role: true, tokenVersion: true },
      });

      if (!user) {
        await this.refreshSessionRepo.revoke(tx, session.id);
        return { kind: 'USER_INACTIVE' };
      }

      await this.refreshSessionRepo.create(tx, {
        id: newSessionId,
        userId: session.userId,
        tokenHash: newTokenHash,
        deviceId: ctx.deviceId,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ip,
        expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
      });
      await this.refreshSessionRepo.markRotated(tx, session.id, newSessionId);
      await this.audit.log(tx, {
        action: AUTH_AUDIT_ACTIONS.REFRESH_TOKEN_ROTATED,
        actorUserId: session.userId,
        entityId: newSessionId,
        metadata: { oldSessionId: session.id },
      });

      return {
        kind: 'SUCCESS',
        newSessionId,
        userId: session.userId,
        role: user.role,
        tokenVersion: user.tokenVersion,
      };
    });

    if (result.kind !== 'SUCCESS') {
      // NOT_FOUND|EXPIRED|REUSE_DETECTED|USER_INACTIVE hepsi ayni generic
      // hataya eslenir; newRaw/newTokenHash hic DB'ye yazilmadigindan atilir.
      throw new DomainError(
        ERROR_CODES.AUTH_INVALID_REFRESH,
        HttpStatus.UNAUTHORIZED,
        'Refresh token gecersiz veya suresi dolmus.',
      );
    }

    const accessToken = await this.signAccessTokenWithCompensation(
      {
        sub: result.userId,
        role: result.role,
        sessionId: result.newSessionId,
        tokenVersion: result.tokenVersion,
      },
      result.newSessionId,
    );

    return { accessToken, refreshToken: newRaw, expiresIn: accessTtlSeconds };
  }

  async revoke(rawRefresh: string): Promise<void> {
    const pepper = this.config.getOrThrow<string>('auth.refreshTokenPepper');
    const hash = hashRefreshToken(pepper, rawRefresh);
    const revoked = await this.refreshSessionRepo.revokeByHash(this.prisma, hash);

    if (revoked) {
      await this.audit.log(this.prisma, {
        action: AUTH_AUDIT_ACTIONS.REFRESH_TOKEN_REVOKED,
        entityId: revoked.id,
      });
    }
  }
}
