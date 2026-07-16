import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { MembershipRole } from '../../../generated/prisma-client/enums';

export interface SiteMembershipRow {
  id: string;
  userId: string;
  siteId: string;
  membershipRole: MembershipRole;
  isActive: boolean;
  startsAt: Date;
  endsAt: Date | null;
}

export interface ActiveMembership {
  siteId: string;
  membershipRole: MembershipRole;
}

@Injectable()
export class SiteMembershipRepository {
  // Onaylanan Faz 3 plani Bolum 9, duzeltme #5: idempotent + tarihce
  // koruyan upsert. En son satir FOR UPDATE ile kilitlenerek okunur;
  // aktifse oldugu gibi donulur; gecmis (pasif) bir satir varsa YENIDEN
  // AKTIF EDILMEZ, yeni bir satir acilir; hic yoksa yeni satir acilir.
  // Paralel create yarisinda dogabilecek P2002 burada YUTULMAZ - cagiran
  // servis kendi $transaction sinirinda yakalar (onaylanan plan: "ayni
  // transaction icinde kurtarma denenmez").
  async upsertActive(
    client: PrismaClientLike,
    input: { userId: string; siteId: string; membershipRole: MembershipRole },
  ): Promise<SiteMembershipRow> {
    const latest = await this.findLatestForUpdate(
      client,
      input.userId,
      input.siteId,
      input.membershipRole,
    );

    if (latest?.isActive) {
      return latest;
    }

    const created = await client.siteMembership.create({
      data: {
        userId: input.userId,
        siteId: input.siteId,
        membershipRole: input.membershipRole,
        isActive: true,
      },
    });

    return {
      id: created.id,
      userId: created.userId,
      siteId: created.siteId,
      membershipRole: created.membershipRole,
      isActive: created.isActive,
      startsAt: created.startsAt,
      endsAt: created.endsAt,
    };
  }

  private async findLatestForUpdate(
    client: PrismaClientLike,
    userId: string,
    siteId: string,
    membershipRole: MembershipRole,
  ): Promise<SiteMembershipRow | null> {
    const rows = await client.$queryRaw<SiteMembershipRow[]>`
      SELECT
        id,
        user_id AS "userId",
        site_id AS "siteId",
        membership_role AS "membershipRole",
        is_active AS "isActive",
        starts_at AS "startsAt",
        ends_at AS "endsAt"
      FROM site_memberships
      WHERE user_id = ${userId} AND site_id = ${siteId} AND membership_role = ${membershipRole}
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  // Site-scoped pasiflestirme (onaylanan Faz 3 plani Bolum 10): yalnix bu
  // site'a ait aktif uyelik(ler)i sonlandirir, baska site'lara dokunmaz.
  async deactivateForSite(
    client: PrismaClientLike,
    params: { userId: string; siteId: string },
  ): Promise<number> {
    const result = await client.siteMembership.updateMany({
      where: { userId: params.userId, siteId: params.siteId, isActive: true },
      data: { isActive: false, endsAt: new Date() },
    });

    return result.count;
  }

  // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.2/6.4):
  // findManagedSiteIds'in ters yonu - "bu site'nin aktif MANAGER'lari
  // kimler" (ContractExpiring/InvoiceOverdue bildirim alicisi cozumlemesi
  // icin). Ayni filtre/index deseni (@@index([siteId, membershipRole,
  // isActive])), baska site'nin yoneticisi asla donmez.
  async findActiveManagerUserIdsForSite(
    client: PrismaClientLike,
    siteId: string,
    now: Date,
  ): Promise<string[]> {
    const rows = await client.siteMembership.findMany({
      where: {
        siteId,
        membershipRole: 'MANAGER',
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { userId: true },
    });

    return rows.map((row) => row.userId);
  }

  async findManagedSiteIds(client: PrismaClientLike, userId: string, now: Date): Promise<string[]> {
    const rows = await client.siteMembership.findMany({
      where: {
        userId,
        membershipRole: 'MANAGER',
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { siteId: true },
    });

    return rows.map((row) => row.siteId);
  }

  async listActiveForUser(
    client: PrismaClientLike,
    userId: string,
    now: Date,
  ): Promise<ActiveMembership[]> {
    return client.siteMembership.findMany({
      where: {
        userId,
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { siteId: true, membershipRole: true },
    });
  }

  async hasActiveForSite(
    client: PrismaClientLike,
    userId: string,
    siteId: string,
    now: Date,
  ): Promise<boolean> {
    const row = await client.siteMembership.findFirst({
      where: {
        userId,
        siteId,
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { id: true },
    });

    return row !== null;
  }

  async hasActiveManagerForSite(
    client: PrismaClientLike,
    userId: string,
    siteId: string,
    now: Date,
  ): Promise<boolean> {
    const row = await client.siteMembership.findFirst({
      where: {
        userId,
        siteId,
        membershipRole: 'MANAGER',
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { id: true },
    });

    return row !== null;
  }

  async hasAnyActiveMembership(
    client: PrismaClientLike,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const row = await client.siteMembership.findFirst({
      where: {
        userId,
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      select: { id: true },
    });

    return row !== null;
  }
}
