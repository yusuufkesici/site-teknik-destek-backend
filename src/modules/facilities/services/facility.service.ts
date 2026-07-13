import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DOMAIN_AUDIT_ACTIONS } from '../../../common/constants/domain-audit-actions.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { isUniqueConstraintViolation } from '../../../common/utils/prisma-error.util';
import type { FacilityType } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import type { FacilityRow } from '../repositories/facility.repository';
import { FacilityRepository } from '../repositories/facility.repository';
import { FacilityValidatorService } from './facility-validator.service';

export interface FacilityTreeNode extends FacilityRow {
  children: FacilityTreeNode[];
}

// Onaylanan Faz 3 plani Bolum 8: her create* metodu tek transaction icinde
// parent'i FOR SHARE kilitler, hiyerarsi/siteId'yi FacilityValidatorService
// ile dogrular, satiri olusturur ve FACILITY_CREATED audit'ini yazar. Kod
// cakismasi (P2002) transaction disinda yakalanip FACILITY_CODE_CONFLICT'e
// cevrilir (ayni, zaten abort olmus transaction icinde kurtarma denenmez).
@Injectable()
export class FacilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facilityRepo: FacilityRepository,
    private readonly validator: FacilityValidatorService,
    private readonly audit: AuditWriter,
  ) {}

  async createSite(
    input: { name: string; code: string },
    actor: AuthenticatedUser,
  ): Promise<FacilityRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.facilityRepo.create(tx, {
          type: 'SITE',
          name: input.name,
          code: input.code,
          parentId: null,
          siteId: null,
        });

        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.FACILITY_CREATED,
          actorUserId: actor.id,
          entityType: 'Facility',
          entityId: created.id,
          siteId: created.id,
          metadata: { type: 'SITE', code: created.code },
        });

        return created;
      });
    } catch (error) {
      throw this.translateCreateError(error);
    }
  }

  async createBlock(
    siteId: string,
    input: { name: string; code: string },
    actor: AuthenticatedUser,
  ): Promise<FacilityRow> {
    return this.createChild('BLOCK', siteId, input, actor);
  }

  async createUnit(
    blockId: string,
    input: { name?: string; code: string },
    actor: AuthenticatedUser,
  ): Promise<FacilityRow> {
    return this.createChild(
      'UNIT',
      blockId,
      { name: input.name ?? input.code, code: input.code },
      actor,
    );
  }

  async createCommonArea(
    parentId: string,
    input: { name: string; code: string },
    actor: AuthenticatedUser,
  ): Promise<FacilityRow> {
    return this.createChild('COMMON_AREA', parentId, input, actor);
  }

  async getTree(siteId: string): Promise<FacilityTreeNode> {
    const site = await this.facilityRepo.findAliveById(this.prisma, siteId);
    if (!site || site.type !== 'SITE') {
      throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
    }

    const rows = await this.facilityRepo.findTreeForSite(this.prisma, siteId);
    return this.buildTree(site, rows);
  }

  private async createChild(
    type: Exclude<FacilityType, 'SITE'>,
    parentId: string,
    input: { name: string; code: string },
    actor: AuthenticatedUser,
  ): Promise<FacilityRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const parent = await this.facilityRepo.lockForShare(tx, parentId);
        const siteId = this.validator.assertValidParentAndDeriveSiteId(type, parent);

        const created = await this.facilityRepo.create(tx, {
          type,
          name: input.name,
          code: input.code,
          parentId,
          siteId,
        });

        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.FACILITY_CREATED,
          actorUserId: actor.id,
          entityType: 'Facility',
          entityId: created.id,
          siteId,
          metadata: { type, code: created.code, parentId },
        });

        return created;
      });
    } catch (error) {
      throw this.translateCreateError(error);
    }
  }

  private translateCreateError(error: unknown): unknown {
    if (isUniqueConstraintViolation(error)) {
      return new DomainError(
        ERROR_CODES.FACILITY_CODE_CONFLICT,
        HttpStatus.CONFLICT,
        'Bu ust facility altinda ayni koda sahip bir kayit zaten var.',
      );
    }
    return error;
  }

  private buildTree(site: FacilityRow, rows: FacilityRow[]): FacilityTreeNode {
    const byParent = new Map<string, FacilityRow[]>();
    for (const row of rows) {
      if (row.id === site.id) {
        continue;
      }
      const parentId = row.parentId ?? '';
      const siblings = byParent.get(parentId) ?? [];
      siblings.push(row);
      byParent.set(parentId, siblings);
    }

    const attachChildren = (node: FacilityRow): FacilityTreeNode => ({
      ...node,
      children: (byParent.get(node.id) ?? []).map(attachChildren),
    });

    return attachChildren(site);
  }
}
