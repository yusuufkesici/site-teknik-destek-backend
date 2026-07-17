import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../common/types/prisma-client-like.type';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service';
import type { ActiveMembership } from './repositories/site-membership.repository';
import { SiteMembershipRepository } from './repositories/site-membership.repository';

export interface MembershipQueryOptions {
  client?: PrismaClientLike;
  now?: Date;
}

// "Bu kullanicinin bu siteye erisimi var mi?" sorularinin TEK otoritesi
// (onaylanan Faz 3 plani Bolum 6, karar #4). Salt-okunur; yazma islemleri
// SiteMembershipRepository/ResidentUnitAssignmentRepository uzerinden
// dogrudan cagirilir (UsersService).
@Injectable()
export class MembershipQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteMembershipRepo: SiteMembershipRepository,
  ) {}

  // Faz 2'den tasindi/yeniden adlandirildi (eski MembershipReadRepository.
  // hasActiveSiteMembership) - siteId FARKETMEKSIZIN herhangi bir aktif
  // uyelik var mi (login eligibility icin). Davranis birebir ayni.
  async hasAnyActiveSiteMembership(
    userId: string,
    opts?: MembershipQueryOptions,
  ): Promise<boolean> {
    const client = opts?.client ?? this.prisma;
    const now = opts?.now ?? new Date();
    return this.siteMembershipRepo.hasAnyActiveMembership(client, userId, now);
  }

  async hasActiveSiteMembership(
    userId: string,
    siteId: string,
    opts?: MembershipQueryOptions,
  ): Promise<boolean> {
    const client = opts?.client ?? this.prisma;
    const now = opts?.now ?? new Date();
    return this.siteMembershipRepo.hasActiveForSite(client, userId, siteId, now);
  }

  async hasActiveManagerMembership(
    userId: string,
    siteId: string,
    opts?: MembershipQueryOptions,
  ): Promise<boolean> {
    const client = opts?.client ?? this.prisma;
    const now = opts?.now ?? new Date();
    return this.siteMembershipRepo.hasActiveManagerForSite(client, userId, siteId, now);
  }

  // Faz 2'den degismeden tasindi (/auth/me icin).
  async listActiveMembershipsForUser(
    userId: string,
    opts?: MembershipQueryOptions,
  ): Promise<ActiveMembership[]> {
    const client = opts?.client ?? this.prisma;
    const now = opts?.now ?? new Date();
    return this.siteMembershipRepo.listActiveForUser(client, userId, now);
  }

  async listManagedSiteIds(userId: string, opts?: MembershipQueryOptions): Promise<string[]> {
    const client = opts?.client ?? this.prisma;
    const now = opts?.now ?? new Date();
    return this.siteMembershipRepo.findManagedSiteIds(client, userId, now);
  }

  // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.2/6.4): bildirim
  // alicisi cozumlemesi icin - yalniz ilgili site'nin aktif MANAGER
  // uyeliklerini doner.
  async listActiveManagerUserIds(siteId: string, opts?: MembershipQueryOptions): Promise<string[]> {
    const client = opts?.client ?? this.prisma;
    const now = opts?.now ?? new Date();
    return this.siteMembershipRepo.findActiveManagerUserIdsForSite(client, siteId, now);
  }
}
