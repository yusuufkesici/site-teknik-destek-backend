import { Injectable } from '@nestjs/common';
import type { CursorPayload } from '../../../common/utils/pagination.util';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { UserRole } from '../../../generated/prisma-client/enums';

export interface UserContactRow {
  id: string;
  phoneNumber: string;
}

export interface UserRow {
  id: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  isActive: boolean;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateUserInput {
  phoneNumber: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  incrementTokenVersion?: boolean;
}

// Faz 2'nin salt-okunur UserAuthRepository'sinden bilincli olarak ayri
// (onaylanan Faz 3 plani Bolum 11, karar #10). UsersModule disina hic
// export edilmez; UsersModule kendi domain'inin yazma islemlerini burada
// yapar.
@Injectable()
export class UserRepository {
  // Onaylanan Faz 3 plani Bolum 9, duzeltme #4: onboarding'in eszamanlilik
  // stratejisi. Transaction-scoped advisory lock; commit/rollback'te
  // otomatik serbest kalir.
  async acquirePhoneLock(client: PrismaClientLike, phoneNumber: string): Promise<void> {
    // pg_advisory_xact_lock 'void' doner - $queryRaw bunu deserialize edemez,
    // bu yuzden sonuc beklemeyen $executeRaw kullanilir.
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phoneNumber})::bigint)`;
  }

  async findByPhone(client: PrismaClientLike, phoneNumber: string): Promise<UserRow | null> {
    return client.user.findUnique({ where: { phoneNumber } });
  }

  async findAliveById(client: PrismaClientLike, id: string): Promise<UserRow | null> {
    return client.user.findFirst({ where: { id, deletedAt: null } });
  }

  async create(client: PrismaClientLike, input: CreateUserInput): Promise<UserRow> {
    return client.user.create({
      data: {
        phoneNumber: input.phoneNumber,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
      },
    });
  }

  async update(client: PrismaClientLike, id: string, input: UpdateUserInput): Promise<UserRow> {
    return client.user.update({
      where: { id },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        phoneNumber: input.phoneNumber,
        tokenVersion: input.incrementTokenVersion ? { increment: 1 } : undefined,
      },
    });
  }

  async deactivateGlobally(client: PrismaClientLike, id: string): Promise<UserRow> {
    return client.user.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.2/6.5): bildirim
  // alicisi cozumlemesi icin dar okuma metotlari. UsersModule disina
  // DOGRUDAN acilmaz - tek yuzey UserContactLookupService'tir.
  async findActivePhoneById(client: PrismaClientLike, id: string): Promise<UserContactRow | null> {
    return client.user.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true, phoneNumber: true },
    });
  }

  async findActivePhonesByIds(client: PrismaClientLike, ids: string[]): Promise<UserContactRow[]> {
    if (ids.length === 0) return [];
    return client.user.findMany({
      where: { id: { in: ids }, isActive: true, deletedAt: null },
      select: { id: true, phoneNumber: true },
    });
  }

  // Acikca isimlendirilmis, role-scoped sorgu (implementation-overrides.md
  // #3'un istedigi "OPERATIONS icin acikca adlandirilmis" deseni) - anonim
  // "tum kullanicilar" sorgusu degildir. Mevcut @@index([role, isActive])
  // kullanilir.
  async listActiveByRole(client: PrismaClientLike, role: UserRole): Promise<UserContactRow[]> {
    return client.user.findMany({
      where: { role, isActive: true, deletedAt: null },
      select: { id: true, phoneNumber: true },
    });
  }

  // Onaylanan Faz 3 plani Bolum 4/11: GET /sites/:siteId/users. JOIN yerine
  // EXISTS kullanilir - bir kullanicinin ayni sitede birden fazla aktif
  // membership_role satiri (ör. hem MANAGER hem RESIDENT) olabildiginden
  // (uq_site_membership_active partial index (user_id,site_id,
  // membership_role)), JOIN yinelenen satirlar uretebilir.
  async listBySite(
    client: PrismaClientLike,
    params: { siteId: string; cursor: CursorPayload | null; limit: number },
  ): Promise<UserRow[]> {
    if (params.cursor) {
      return client.$queryRaw<UserRow[]>`
        SELECT
          u.id,
          u.phone_number AS "phoneNumber",
          u.first_name AS "firstName",
          u.last_name AS "lastName",
          u.role,
          u.is_active AS "isActive",
          u.token_version AS "tokenVersion",
          u.created_at AS "createdAt",
          u.updated_at AS "updatedAt",
          u.deleted_at AS "deletedAt"
        FROM users u
        WHERE u.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM site_memberships sm
            WHERE sm.user_id = u.id
              AND sm.site_id = ${params.siteId}
              AND sm.is_active = true
              AND sm.starts_at <= now()
              AND (sm.ends_at IS NULL OR sm.ends_at > now())
          )
          AND (u.created_at, u.id) > (${new Date(params.cursor.createdAt)}, ${params.cursor.id}::uuid)
        ORDER BY u.created_at ASC, u.id ASC
        LIMIT ${params.limit + 1}
      `;
    }

    return client.$queryRaw<UserRow[]>`
      SELECT
        u.id,
        u.phone_number AS "phoneNumber",
        u.first_name AS "firstName",
        u.last_name AS "lastName",
        u.role,
        u.is_active AS "isActive",
        u.token_version AS "tokenVersion",
        u.created_at AS "createdAt",
        u.updated_at AS "updatedAt",
        u.deleted_at AS "deletedAt"
      FROM users u
      WHERE u.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM site_memberships sm
          WHERE sm.user_id = u.id
            AND sm.site_id = ${params.siteId}
            AND sm.is_active = true
            AND sm.starts_at <= now()
            AND (sm.ends_at IS NULL OR sm.ends_at > now())
        )
      ORDER BY u.created_at ASC, u.id ASC
      LIMIT ${params.limit + 1}
    `;
  }
}
