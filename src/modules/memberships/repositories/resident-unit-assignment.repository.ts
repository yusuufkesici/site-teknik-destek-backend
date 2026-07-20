import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';

export interface ResidentUnitAssignmentRow {
  id: string;
  userId: string;
  unitId: string;
  isPrimary: boolean;
  isActive: boolean;
  startsAt: Date;
  endsAt: Date | null;
}

// Frontend enablement plani E1 (docs/frontend-enablement-plan.md Bolum 3):
// GET /users/me/units icin unit ozetiyle birlikte satir. unit.siteId'nin
// Prisma tipi nullable'dir (SITE satirlarinda null) - UNIT satirlarinda
// chk_facility_root DB kisiti doluluk garantisi verir, dogrulama mapper'da
// acikca yapilir (non-null assertion kullanilmaz).
export interface ResidentUnitAssignmentWithUnitRow {
  id: string;
  unitId: string;
  isPrimary: boolean;
  startsAt: Date;
  unit: { id: string; name: string; code: string; siteId: string | null };
}

@Injectable()
export class ResidentUnitAssignmentRepository {
  // Onboarding'in idempotency/cakisma kararlari icin: kullanicinin HERHANGI
  // bir unit'teki aktif assignment'i (onaylanan Faz 3 plani Bolum 9,
  // duzeltme #6 - tek-aktif-unit varsayimi).
  async findActiveForUser(
    client: PrismaClientLike,
    userId: string,
  ): Promise<ResidentUnitAssignmentRow | null> {
    return client.residentUnitAssignment.findFirst({
      where: { userId, isActive: true },
    });
  }

  // Frontend enablement plani E1: yalniz cagiranin KENDI aktif kayitlari,
  // unit ozetiyle. @@index([userId, isActive]) mevcut; salt-okunur.
  async listActiveForUserWithUnit(
    client: PrismaClientLike,
    userId: string,
  ): Promise<ResidentUnitAssignmentWithUnitRow[]> {
    return client.residentUnitAssignment.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        unitId: true,
        isPrimary: true,
        startsAt: true,
        unit: { select: { id: true, name: true, code: true, siteId: true } },
      },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
    });
  }

  async create(
    client: PrismaClientLike,
    input: { userId: string; unitId: string; isPrimary: boolean },
  ): Promise<ResidentUnitAssignmentRow> {
    return client.residentUnitAssignment.create({
      data: {
        userId: input.userId,
        unitId: input.unitId,
        isPrimary: input.isPrimary,
        isActive: true,
      },
    });
  }

  // Unit assignment deactivate: assignment->unit->site tutarliligi TEK
  // sorguda dogrulanir ve satir kilitlenir (onaylanan Faz 3 plani Bolum 8,
  // duzeltme #7).
  async findScopedForUpdate(
    client: PrismaClientLike,
    params: { assignmentId: string; unitId: string; siteId: string },
  ): Promise<ResidentUnitAssignmentRow | null> {
    const rows = await client.$queryRaw<ResidentUnitAssignmentRow[]>`
      SELECT
        rua.id,
        rua.user_id AS "userId",
        rua.unit_id AS "unitId",
        rua.is_primary AS "isPrimary",
        rua.is_active AS "isActive",
        rua.starts_at AS "startsAt",
        rua.ends_at AS "endsAt"
      FROM resident_unit_assignments rua
      JOIN facilities f ON f.id = rua.unit_id
      WHERE rua.id = ${params.assignmentId}
        AND rua.unit_id = ${params.unitId}
        AND f.site_id = ${params.siteId}
        AND f.type = 'UNIT'
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  async deactivate(client: PrismaClientLike, assignmentId: string): Promise<void> {
    await client.residentUnitAssignment.update({
      where: { id: assignmentId },
      data: { isActive: false, endsAt: new Date() },
    });
  }

  // Site-scoped kullanici pasiflestirme (onaylanan Faz 3 plani Bolum 10):
  // yalniz bu site'in unit'lerine bagli aktif assignment'lari sonlandirir.
  async deactivateAllForUserInSite(
    client: PrismaClientLike,
    params: { userId: string; siteId: string },
  ): Promise<number> {
    const result = await client.residentUnitAssignment.updateMany({
      where: { userId: params.userId, isActive: true, unit: { siteId: params.siteId } },
      data: { isActive: false, endsAt: new Date() },
    });

    return result.count;
  }
}
