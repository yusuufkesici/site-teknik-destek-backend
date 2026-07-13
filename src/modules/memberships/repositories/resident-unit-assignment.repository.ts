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
