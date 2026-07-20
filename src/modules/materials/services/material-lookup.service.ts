import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import {
  buildPage,
  decodeCursor,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import type { ListMaterialsQueryDto } from '../dto/list-materials-query.dto';
import type { MaterialRow } from '../repositories/material.repository';
import { MaterialRepository } from '../repositories/material.repository';

const DEFAULT_PAGE_LIMIT = 20;

// MaterialsModule'un export ettigi tek servis (Faz 5 Bolum 2) -
// MaterialRepository asla export edilmez. Frontend enablement plani E3:
// salt-okunur katalog listesi de ayni servis uzerinden sunulur (yeni servis
// sinifi acilmaz, tek-export deseni korunur).
@Injectable()
export class MaterialLookupService {
  constructor(
    private readonly materialRepo: MaterialRepository,
    private readonly prisma: PrismaService,
  ) {}

  async listActiveCatalog(query: ListMaterialsQueryDto): Promise<PaginatedResult<MaterialRow>> {
    let cursor = null;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Gecersiz cursor.',
        );
      }
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const rows = await this.materialRepo.listActive(this.prisma, { cursor, limit });
    return buildPage(rows, limit);
  }

  async assertActiveMaterial(client: PrismaClientLike, materialId: string): Promise<MaterialRow> {
    const material = await this.materialRepo.findAliveById(client, materialId);
    if (!material) {
      throw new DomainError(
        ERROR_CODES.MATERIAL_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Material bulunamadi.',
      );
    }
    if (!material.isActive) {
      throw new DomainError(
        ERROR_CODES.MATERIAL_INACTIVE,
        HttpStatus.CONFLICT,
        'Material aktif degil.',
      );
    }
    return material;
  }
}
