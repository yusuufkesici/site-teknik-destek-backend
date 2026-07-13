import { CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { MembershipQueryService } from '../../modules/memberships/membership-query.service';
import { ERROR_CODES } from '../constants/error-codes.constant';
import { DomainError } from '../errors/domain-error';
import type { AuthenticatedUser } from '../types/authenticated-user.type';

interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

// Route-param tabanli (:siteId), JwtAuthGuard/RolesGuard'dan SONRA calisir,
// global degildir (@UseGuards(SiteScopeGuard) ile route bazinda eklenir).
// Yalniz "bu kullanicinin bu siteye erisimi var mi?" sorusuna cevap verir -
// site kaydinin GERCEKTEN var olup olmadigini DOGRULAMAZ; bu servis
// katmaninin sorumlulugudur (onaylanan Faz 3 plani Bolum 7, duzeltme #9).
@Injectable()
export class SiteScopeGuard implements CanActivate {
  constructor(private readonly membershipQuery: MembershipQueryService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const siteId = (request.params as Record<string, string | undefined>).siteId;

    if (!siteId) {
      throw new Error(
        "SiteScopeGuard yalniz ':siteId' parametresi iceren route'larda kullanilabilir.",
      );
    }

    const user = request.user;
    if (!user) {
      throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
    }

    // Bolum 2 varsayim #1: sirket personelinin site uyeligi yoktur,
    // siteId'den bagimsiz erisimi vardir.
    if (user.role === 'OPERATIONS') {
      return true;
    }

    if (user.role === 'SITE_MANAGER') {
      const hasAccess = await this.membershipQuery.hasActiveManagerMembership(user.id, siteId);
      if (hasAccess) {
        return true;
      }
    }

    // Karar #7/#15: siteId asla guvenilir kabul edilmez; erisimi olmayan
    // kullaniciya "kaynak yok" (404) donulur, "yasak" (403) degil.
    throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
  }
}
