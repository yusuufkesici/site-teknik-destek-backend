import { Injectable } from '@nestjs/common';
import type { CursorPayload } from '../../../common/utils/pagination.util';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { Prisma } from '../../../generated/prisma-client/client';
import type {
  TicketCategory,
  TicketSource,
  TicketStatus,
  TicketUrgency,
} from '../../../generated/prisma-client/enums';

export interface TicketRow {
  id: string;
  code: string;
  createdByUserId: string;
  siteId: string;
  facilityId: string;
  title: string;
  description: string;
  category: TicketCategory;
  urgency: TicketUrgency;
  status: TicketStatus;
  source: TicketSource;
  slaTargetAt: Date | null;
  isRecurring: boolean;
  operationNote: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TicketStatusHistoryRow {
  id: string;
  ticketId: string;
  previousStatus: TicketStatus | null;
  newStatus: TicketStatus;
  changedByUserId: string;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface CreateTicketInput {
  code: string;
  createdByUserId: string;
  siteId: string;
  facilityId: string;
  title: string;
  description: string;
  category: TicketCategory;
  urgency: TicketUrgency;
  source: TicketSource;
  slaTargetAt: Date | null;
  // slaTargetAt tam olarak bu ana gore hesaplandigi icin acikca gecirilir -
  // DB'nin @default(now())'ina birakilirsa, INSERT anindaki gercek zaman
  // slaTargetAt hesaplanirken kullanilan JS Date'ten birkac milisaniye
  // kayabilir (transaction/sorgu gecikmesi), createdAt+N saat esitligini bozar.
  createdAt: Date;
}

export interface AddHistoryInput {
  ticketId: string;
  previousStatus: TicketStatus | null;
  newStatus: TicketStatus;
  changedByUserId: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateTicketFieldsInput {
  title?: string;
  description?: string;
  category?: TicketCategory;
  urgency?: TicketUrgency;
  operationNote?: string;
  slaTargetAt?: Date | null;
}

export type TicketListFilter =
  | {
      scope: 'RESIDENT';
      residentId: string;
      cursor: CursorPayload | null;
      limit: number;
    }
  | {
      scope: 'SITE_MANAGER';
      siteId: string;
      status?: TicketStatus;
      urgency?: TicketUrgency;
      cursor: CursorPayload | null;
      limit: number;
    }
  | {
      scope: 'OPERATIONS';
      siteId?: string;
      status?: TicketStatus;
      urgency?: TicketUrgency;
      cursor: CursorPayload | null;
      limit: number;
    };

// Onaylanan Faz 4 plani Bolum 9: siteId/rol filtresi olmadan calisan
// parametresiz bir liste metodu yok - TicketListFilter her zaman zorunlu.
@Injectable()
export class TicketRepository {
  async nextCode(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<
      { nextval: bigint }[]
    >`SELECT nextval('ticket_code_seq') AS nextval`;
    const year = new Date().getUTCFullYear();
    return `TKT-${year}-${rows[0].nextval.toString().padStart(6, '0')}`;
  }

  async create(client: PrismaClientLike, input: CreateTicketInput): Promise<TicketRow> {
    return client.ticket.create({
      data: {
        code: input.code,
        createdByUserId: input.createdByUserId,
        siteId: input.siteId,
        facilityId: input.facilityId,
        title: input.title,
        description: input.description,
        category: input.category,
        urgency: input.urgency,
        source: input.source,
        slaTargetAt: input.slaTargetAt,
        createdAt: input.createdAt,
      },
    });
  }

  async findAliveById(client: PrismaClientLike, id: string): Promise<TicketRow | null> {
    return client.ticket.findFirst({ where: { id, deletedAt: null } });
  }

  // PATCH/durum degisikligi/iptal transaction'larinin kilit sirasi (Bolum
  // 13): ticket satiri her zaman once FOR UPDATE ile kilitlenir.
  async findByIdForUpdate(client: PrismaClientLike, id: string): Promise<TicketRow | null> {
    const rows = await client.$queryRaw<TicketRow[]>`
      SELECT
        id,
        code,
        created_by_user_id AS "createdByUserId",
        site_id AS "siteId",
        facility_id AS "facilityId",
        title,
        description,
        category,
        urgency,
        status,
        source,
        sla_target_at AS "slaTargetAt",
        is_recurring AS "isRecurring",
        operation_note AS "operationNote",
        completed_at AS "completedAt",
        cancelled_at AS "cancelledAt",
        cancellation_reason AS "cancellationReason",
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM tickets
      WHERE id = ${id} AND deleted_at IS NULL
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  // Duzeltme #6/#11: cagiran servis version'i onceden dogrulamis olsa da,
  // WHERE version=currentVersion ikinci bir savunma hattidir (eslesme
  // yoksa 0 satir guncellenir, null doner).
  async updateFields(
    client: PrismaClientLike,
    id: string,
    currentVersion: number,
    data: UpdateTicketFieldsInput,
  ): Promise<TicketRow | null> {
    const result = await client.ticket.updateMany({
      where: { id, version: currentVersion },
      data: {
        title: data.title,
        description: data.description,
        category: data.category,
        urgency: data.urgency,
        operationNote: data.operationNote,
        slaTargetAt: data.slaTargetAt,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    return this.findAliveById(client, id);
  }

  async updateStatus(
    client: PrismaClientLike,
    id: string,
    currentVersion: number,
    newStatus: TicketStatus,
    extra: { cancelledAt?: Date; cancellationReason?: string; completedAt?: Date },
  ): Promise<TicketRow | null> {
    const result = await client.ticket.updateMany({
      where: { id, version: currentVersion },
      data: {
        status: newStatus,
        cancelledAt: extra.cancelledAt,
        cancellationReason: extra.cancellationReason,
        completedAt: extra.completedAt,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    return this.findAliveById(client, id);
  }

  // Append-only (Bolum 15/karar): guncelleme veya silme metodu yok.
  async addHistory(client: PrismaClientLike, entry: AddHistoryInput): Promise<void> {
    await client.ticketStatusHistory.create({
      data: {
        ticketId: entry.ticketId,
        previousStatus: entry.previousStatus,
        newStatus: entry.newStatus,
        changedByUserId: entry.changedByUserId,
        reason: entry.reason ?? null,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async listHistory(client: PrismaClientLike, ticketId: string): Promise<TicketStatusHistoryRow[]> {
    return client.ticketStatusHistory.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async existsAssignmentForTechnician(
    client: PrismaClientLike,
    ticketId: string,
    technicianId: string,
  ): Promise<boolean> {
    const row = await client.assignment.findFirst({
      where: { ticketId, technicianId },
      select: { id: true },
    });
    return row !== null;
  }

  // Cursor: createdAt DESC + id DESC (Bolum 14). Prisma'nin tipli where
  // agaciyla ifade edilir (composite tuple karsilastirmasi OR/AND ile
  // esdegeridir) - raw SQL yalniz FOR UPDATE gerektiren yerlerde kullanilir.
  // RESIDENT dalinda TicketAuthorizationPolicy.assertCanRead ile tutarli
  // olmasi icin aktif site-membership filtresi (site.siteMembers.some)
  // ayrica uygulanir - taci taşinmis bir sakinin "hayalet" ticket satiri
  // listede gorunmez (onaylanan Faz 4 plani Bolum 9/19).
  async list(client: PrismaClientLike, filter: TicketListFilter): Promise<TicketRow[]> {
    const cursorWhere = filter.cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(filter.cursor.createdAt) } },
            { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
          ],
        }
      : {};

    if (filter.scope === 'RESIDENT') {
      const now = new Date();
      return client.ticket.findMany({
        where: {
          deletedAt: null,
          createdByUserId: filter.residentId,
          site: {
            siteMembers: {
              some: {
                userId: filter.residentId,
                isActive: true,
                startsAt: { lte: now },
                OR: [{ endsAt: null }, { endsAt: { gt: now } }],
              },
            },
          },
          ...cursorWhere,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
      });
    }

    if (filter.scope === 'SITE_MANAGER') {
      return client.ticket.findMany({
        where: {
          deletedAt: null,
          siteId: filter.siteId,
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.urgency ? { urgency: filter.urgency } : {}),
          ...cursorWhere,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
      });
    }

    // OPERATIONS
    return client.ticket.findMany({
      where: {
        deletedAt: null,
        ...(filter.siteId ? { siteId: filter.siteId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.urgency ? { urgency: filter.urgency } : {}),
        ...cursorWhere,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }
}
