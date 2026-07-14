import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';

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

// Faz 5 Bolum 15: material katalog CRUD/listeleme endpoint'i yok - bu
// repository yalniz assignment-materials ekleme akisinin ihtiyaci kadar
// salt-okunur bir lookup sunar.
@Injectable()
export class MaterialRepository {
  async findAliveById(client: PrismaClientLike, id: string): Promise<MaterialRow | null> {
    return client.material.findFirst({ where: { id, deletedAt: null } });
  }
}
