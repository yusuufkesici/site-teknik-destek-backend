import { Injectable } from '@nestjs/common';
import type { CursorPayload } from '../../../common/utils/pagination.util';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { AttachmentType } from '../../../generated/prisma-client/enums';

export interface TicketAttachmentRow {
  id: string;
  ticketId: string;
  assignmentId: string | null;
  uploadedByUserId: string;
  attachmentType: AttachmentType;
  storageProvider: string;
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface CreateTicketAttachmentInput {
  ticketId: string;
  assignmentId: string | null;
  uploadedByUserId: string;
  attachmentType: AttachmentType;
  storageProvider: string;
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
}

export interface ListByTicketFilter {
  ticketId: string;
  cursor: CursorPayload | null;
  limit: number;
}

// Onaylanan Faz 6 plani Bolum 3/9: parametresiz "tum kayitlar" sorgusu
// yok - her okuma ticketId veya id ile scope'ludur (overrides #3).
@Injectable()
export class TicketAttachmentRepository {
  async create(
    client: PrismaClientLike,
    input: CreateTicketAttachmentInput,
  ): Promise<TicketAttachmentRow> {
    return client.ticketAttachment.create({
      data: {
        ticketId: input.ticketId,
        assignmentId: input.assignmentId,
        uploadedByUserId: input.uploadedByUserId,
        attachmentType: input.attachmentType,
        storageProvider: input.storageProvider,
        storageKey: input.storageKey,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        checksum: input.checksum,
      },
    });
  }

  async findAliveById(client: PrismaClientLike, id: string): Promise<TicketAttachmentRow | null> {
    return client.ticketAttachment.findFirst({ where: { id, deletedAt: null } });
  }

  async listByTicket(
    client: PrismaClientLike,
    filter: ListByTicketFilter,
  ): Promise<TicketAttachmentRow[]> {
    const cursorWhere = filter.cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(filter.cursor.createdAt) } },
            { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
          ],
        }
      : {};

    return client.ticketAttachment.findMany({
      where: {
        ticketId: filter.ticketId,
        deletedAt: null,
        ...cursorWhere,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }
}
