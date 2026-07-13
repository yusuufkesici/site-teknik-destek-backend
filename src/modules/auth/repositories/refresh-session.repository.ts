import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';

export interface RefreshSessionForUpdate {
  id: string;
  userId: string;
  tokenHash: string;
  deviceId: string | null;
  userAgent: string | null;
  ipAddress: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateRefreshSessionInput {
  id: string;
  userId: string;
  tokenHash: string;
  deviceId?: string;
  userAgent?: string;
  ipAddress: string;
  expiresAt: Date;
}

@Injectable()
export class RefreshSessionRepository {
  // 'id' ve 'tokenHash' cagiran tarafindan transaction ONCESI uretilir
  // (onaylanan Faz 2 plani Bolum 7/8, override §7 — duzeltme #4).
  async create(client: PrismaClientLike, input: CreateRefreshSessionInput): Promise<void> {
    await client.refreshSession.create({
      data: {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        deviceId: input.deviceId,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        expiresAt: input.expiresAt,
      },
    });
  }

  // FOR UPDATE: rotation/reuse-detection sirasinda satir kilidi
  // (onaylanan Faz 2 plani Bolum 8, adim 3a).
  async findByHashForUpdate(
    client: PrismaClientLike,
    tokenHash: string,
  ): Promise<RefreshSessionForUpdate | null> {
    const rows = await client.$queryRaw<RefreshSessionForUpdate[]>`
      SELECT
        id,
        user_id AS "userId",
        token_hash AS "tokenHash",
        device_id AS "deviceId",
        user_agent AS "userAgent",
        ip_address AS "ipAddress",
        expires_at AS "expiresAt",
        revoked_at AS "revokedAt",
        replaced_by_token_id AS "replacedByTokenId",
        created_at AS "createdAt",
        last_used_at AS "lastUsedAt"
      FROM refresh_sessions
      WHERE token_hash = ${tokenHash}
      LIMIT 1
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  async revokeAllForUser(client: PrismaClientLike, userId: string): Promise<void> {
    await client.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async markRotated(client: PrismaClientLike, oldId: string, newId: string): Promise<void> {
    await client.refreshSession.update({
      where: { id: oldId },
      data: { revokedAt: new Date(), replacedByTokenId: newId, lastUsedAt: new Date() },
    });
  }

  async revoke(client: PrismaClientLike, id: string): Promise<void> {
    await client.refreshSession.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  // Logout: token bulunamasa da hata firlatilmaz (enumeration korumasi,
  // karar #8); guncellenen satir varsa audit icin id'si dondurulur.
  async revokeByHash(client: PrismaClientLike, tokenHash: string): Promise<{ id: string } | null> {
    const rows = await client.$queryRaw<{ id: string }[]>`
      UPDATE refresh_sessions
      SET revoked_at = now()
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      RETURNING id
    `;

    return rows[0] ?? null;
  }
}
