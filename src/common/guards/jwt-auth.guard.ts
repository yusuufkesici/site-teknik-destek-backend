import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { UserRole } from '../../generated/prisma-client/enums';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service';
import { UserAuthRepository } from '../../modules/auth/repositories/user-auth.repository';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user.type';

interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

interface JwtPayload {
  sub: string;
  role: UserRole;
  sessionId: string;
  tokenVersion: number;
}

// Passport kullanilmaz: tokenVersion kontrolu icin her istekte DB okumasi
// gerekiyor, bu dogrudan JwtService + repository ile daha az bagimlilikla
// cozulur (onaylanan Faz 2 plani Bolum 9).
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly userAuthRepo: UserAuthRepository,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    const payload = await this.verifyAgainstAnySecret(token);

    if (!payload) {
      throw new UnauthorizedException();
    }

    const user = await this.userAuthRepo.findActiveById(this.prisma, payload.sub);

    if (!user || user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException();
    }

    request.user = {
      id: user.id,
      role: user.role,
      sessionId: payload.sessionId,
      tokenVersion: user.tokenVersion,
    };

    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return null;
    }

    return token;
  }

  // Duzeltme #8: algoritma acikca sinirlandirilir; birden fazla secret
  // (rotasyon) sirayla denenir; gecersiz payload sekli generic 401'e duser.
  private async verifyAgainstAnySecret(token: string): Promise<JwtPayload | null> {
    const secrets = this.config.getOrThrow<string[]>('auth.jwtAccessSecrets');

    for (const secret of secrets) {
      try {
        const decoded: unknown = await this.jwtService.verifyAsync(token, {
          secret,
          algorithms: ['HS256'],
        });

        const validated = this.assertValidPayload(decoded);
        if (validated) {
          return validated;
        }
      } catch {
        // bu secret ile dogrulanamadi, siradaki secret denenir
      }
    }

    return null;
  }

  private assertValidPayload(decoded: unknown): JwtPayload | null {
    if (typeof decoded !== 'object' || decoded === null) {
      return null;
    }

    const candidate = decoded as Record<string, unknown>;
    const { sub, role, sessionId, tokenVersion } = candidate;

    if (typeof sub !== 'string' || !isUUID(sub)) {
      return null;
    }

    if (typeof sessionId !== 'string' || !isUUID(sessionId)) {
      return null;
    }

    if (typeof role !== 'string' || !Object.values(UserRole).includes(role as UserRole)) {
      return null;
    }

    if (typeof tokenVersion !== 'number' || !Number.isInteger(tokenVersion) || tokenVersion < 0) {
      return null;
    }

    return { sub, role: role as UserRole, sessionId, tokenVersion };
  }
}
