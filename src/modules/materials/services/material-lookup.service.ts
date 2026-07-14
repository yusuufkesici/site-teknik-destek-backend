import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { MaterialRow } from '../repositories/material.repository';
import { MaterialRepository } from '../repositories/material.repository';

// MaterialsModule'un export ettigi tek servis (Faz 5 Bolum 2) -
// MaterialRepository asla export edilmez.
@Injectable()
export class MaterialLookupService {
  constructor(private readonly materialRepo: MaterialRepository) {}

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
