import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { Prisma } from '../../../generated/prisma-client/client';
import type { SuppliedBy } from '../../../generated/prisma-client/enums';

export interface AssignmentMaterialRow {
  id: string;
  assignmentId: string;
  materialId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  totalPrice: Prisma.Decimal;
  suppliedBy: SuppliedBy;
  note: string | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface AssignmentMaterialWithMaterialRow extends AssignmentMaterialRow {
  material: { id: string; name: string; code: string; unit: string };
}

export interface CreateAssignmentMaterialInput {
  assignmentId: string;
  materialId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  totalPrice: Prisma.Decimal;
  suppliedBy: SuppliedBy;
  note?: string;
  createdByUserId: string;
}

@Injectable()
export class AssignmentMaterialRepository {
  async create(
    client: PrismaClientLike,
    input: CreateAssignmentMaterialInput,
  ): Promise<AssignmentMaterialWithMaterialRow> {
    return client.assignmentMaterial.create({
      data: {
        assignmentId: input.assignmentId,
        materialId: input.materialId,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        totalPrice: input.totalPrice,
        suppliedBy: input.suppliedBy,
        note: input.note,
        createdByUserId: input.createdByUserId,
      },
      include: { material: { select: { id: true, name: true, code: true, unit: true } } },
    });
  }

  async listByAssignment(
    client: PrismaClientLike,
    assignmentId: string,
  ): Promise<AssignmentMaterialWithMaterialRow[]> {
    return client.assignmentMaterial.findMany({
      where: { assignmentId },
      include: { material: { select: { id: true, name: true, code: true, unit: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
