import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { CursorPayload } from '../../../common/utils/pagination.util';

export interface MaterialRow {
  id: string;
  name: string;
  code: string;
  unit: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ListActiveMaterialsFilter {
  cursor: CursorPayload | null;
  limit: number;
}

// Faz 5 Bolum 15: material katalog CRUD endpoint'i yok - bu repository
// yalniz assignment-materials ekleme akisinin lookup'ini ve frontend
// enablement planindaki (docs/frontend-enablement-plan.md E3) salt-okunur
// aktif katalog listesini sunar.
@Injectable()
export class MaterialRepository {
  async findAliveById(client: PrismaClientLike, id: string): Promise<MaterialRow | null> {
    return client.material.findFirst({ where: { id, deletedAt: null } });
  }

  // Yalniz aktif ve silinmemis katalog; filtre parametresi client'tan
  // ALINMAZ (sabit kural). Cursor deseni ticket.repository.list ile ayni:
  // createdAt DESC + id DESC, limit+1 kayit (buildPage sozlesmesi).
  async listActive(
    client: PrismaClientLike,
    filter: ListActiveMaterialsFilter,
  ): Promise<MaterialRow[]> {
    const cursorWhere = filter.cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(filter.cursor.createdAt) } },
            { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
          ],
        }
      : {};

    return client.material.findMany({
      where: { isActive: true, deletedAt: null, ...cursorWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }
}
