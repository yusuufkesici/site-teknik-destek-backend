import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import type { UserRow } from '../repositories/user.repository';

interface SiteOverlap {
  targetSiteIds: string[];
  hasIntersection: boolean;
  isSubset: boolean;
}

// Onaylanan Faz 3 plani Bolum 12, duzeltme #10/uc rev: hedefin RESIDENT
// olmasi + SITE_MANAGER'in yetki sinirlarinin tek otoritesi. "Kaynak yok"
// (404) ile "kaynak var ama alan-seviyesi yetki yok" (403) katmanlari
// burada ayristirilir (karar #15).
@Injectable()
export class UserAccessPolicy {
  constructor(private readonly membershipQuery: MembershipQueryService) {}

  async assertManagerCanAccessResident(
    requester: AuthenticatedUser,
    target: UserRow,
    client: PrismaClientLike,
  ): Promise<void> {
    if (target.role !== 'RESIDENT') {
      throw this.notFound();
    }

    if (requester.role === 'OPERATIONS') {
      return;
    }

    const overlap = await this.loadSiteOverlap(requester.id, target.id, client);
    if (!overlap.hasIntersection) {
      throw this.notFound();
    }
  }

  async assertSiteManagerCanUpdateGlobalProfile(
    requester: AuthenticatedUser,
    target: UserRow,
    client: PrismaClientLike,
  ): Promise<void> {
    if (target.role !== 'RESIDENT') {
      throw this.notFound();
    }

    if (requester.role === 'OPERATIONS') {
      return;
    }

    const overlap = await this.loadSiteOverlap(requester.id, target.id, client);
    if (!overlap.hasIntersection) {
      throw this.notFound();
    }

    if (!overlap.isSubset) {
      throw new DomainError(
        ERROR_CODES.USER_PROFILE_CHANGE_FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Bu kullanicinin global profilini degistirme yetkiniz yok.',
      );
    }
  }

  private async loadSiteOverlap(
    requesterId: string,
    targetId: string,
    client: PrismaClientLike,
  ): Promise<SiteOverlap> {
    const [managedSiteIds, targetMemberships] = await Promise.all([
      this.membershipQuery.listManagedSiteIds(requesterId, { client }),
      this.membershipQuery.listActiveMembershipsForUser(targetId, { client }),
    ]);

    const managedSet = new Set(managedSiteIds);
    const targetSiteIds = targetMemberships.map((membership) => membership.siteId);

    return {
      targetSiteIds,
      hasIntersection: targetSiteIds.some((siteId) => managedSet.has(siteId)),
      isSubset: targetSiteIds.length > 0 && targetSiteIds.every((siteId) => managedSet.has(siteId)),
    };
  }

  private notFound(): DomainError {
    return new DomainError(
      ERROR_CODES.USER_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Kullanici bulunamadi.',
    );
  }
}
