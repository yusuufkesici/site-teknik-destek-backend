import { Injectable } from '@nestjs/common';
import type { DomainAuditAction } from '../../common/constants/domain-audit-actions.constant';
import type { PrismaClientLike } from '../../common/types/prisma-client-like.type';
import type { Prisma } from '../../generated/prisma-client/client';
import { NIL_UUID, type AuthAuditAction } from './auth-audit-actions.constant';

export interface AuditLogEntry {
  actorUserId?: string;
  // Faz 3: DomainAuditAction eklendi (additive, geriye-uyumlu) - onaylanan
  // Faz 3 plani Bolum 2/12, duzeltme #8.
  action: AuthAuditAction | DomainAuditAction;
  entityType?: string;
  entityId?: string;
  siteId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// Transaction-aware: 'client' parametresi Prisma.TransactionClient
// olabilir, boylece cagiran servisin transaction'i icinde ayni satirin
// commit/rollback'ine tabi olur (onaylanan Faz 2 plani Bolum 11).
@Injectable()
export class AuditWriter {
  async log(client: PrismaClientLike, entry: AuditLogEntry): Promise<void> {
    await client.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType ?? 'Auth',
        entityId: entry.entityId ?? NIL_UUID,
        siteId: entry.siteId,
        metadata: entry.metadata as Prisma.InputJsonValue | undefined,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      },
    });
  }
}
