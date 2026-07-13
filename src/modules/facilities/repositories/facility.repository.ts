import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { FacilityType } from '../../../generated/prisma-client/enums';

export interface FacilityRow {
  id: string;
  type: FacilityType;
  name: string;
  code: string;
  parentId: string | null;
  siteId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateFacilityInput {
  type: FacilityType;
  name: string;
  code: string;
  parentId: string | null;
  siteId: string | null;
}

@Injectable()
export class FacilityRepository {
  async create(client: PrismaClientLike, input: CreateFacilityInput): Promise<FacilityRow> {
    return client.facility.create({
      data: {
        type: input.type,
        name: input.name,
        code: input.code,
        parentId: input.parentId,
        siteId: input.siteId,
      },
    });
  }

  async findAliveById(client: PrismaClientLike, id: string): Promise<FacilityRow | null> {
    return client.facility.findFirst({
      where: { id, deletedAt: null },
    });
  }

  // Onaylanan Faz 3 plani Bolum 8: parent hiyerarsi dogrulamasi sirasinda
  // parent satiri FOR SHARE ile kilitlenir (yalnix okunuyor, degistirilmiyor;
  // FOR UPDATE degil).
  async lockForShare(client: PrismaClientLike, id: string): Promise<FacilityRow | null> {
    const rows = await client.$queryRaw<FacilityRow[]>`
      SELECT
        id,
        type,
        name,
        code,
        parent_id AS "parentId",
        site_id AS "siteId",
        is_active AS "isActive",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM facilities
      WHERE id = ${id}
      FOR SHARE
    `;

    return rows[0] ?? null;
  }

  async findTreeForSite(client: PrismaClientLike, siteId: string): Promise<FacilityRow[]> {
    return client.facility.findMany({
      where: {
        deletedAt: null,
        OR: [{ id: siteId }, { siteId }],
      },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });
  }
}
