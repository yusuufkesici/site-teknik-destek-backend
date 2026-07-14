import type { Readable } from 'node:stream';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DOMAIN_AUDIT_ACTIONS } from '../../../common/constants/domain-audit-actions.constant';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import {
  buildPage,
  decodeCursor,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/events/outbox.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../../infrastructure/storage/storage-provider.interface';
import { AssignmentLookupService } from '../../assignments/services/assignment-lookup.service';
import { TicketReadAccessService } from '../../tickets/services/ticket-read-access.service';
import type { ListAttachmentsQueryDto } from '../dto/list-attachments-query.dto';
import type { UploadAttachmentDto } from '../dto/upload-attachment.dto';
import { AttachmentAuthorizationPolicy } from '../policies/attachment-authorization.policy';
import type { TicketAttachmentRow } from '../repositories/ticket-attachment.repository';
import { TicketAttachmentRepository } from '../repositories/ticket-attachment.repository';
import { detectImageMimeType } from '../security/file-signature.util';

const DEFAULT_PAGE_LIMIT = 20;
const LOCAL_STORAGE_PROVIDER_NAME = 'local';

export interface DownloadStreamResult {
  attachment: TicketAttachmentRow;
  stream: Readable;
}

// Onaylanan Faz 6 plani Bolum 9: storage finalize -> DB insert -> DB
// basarisizsa compensating delete. Her asamada best-effort cleanup (hata
// yalniz loglanir/yutulur, asil domain hatasi degismeden firlatilir).
@Injectable()
export class AttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachmentRepo: TicketAttachmentRepository,
    private readonly ticketAccess: TicketReadAccessService,
    private readonly assignmentLookup: AssignmentLookupService,
    private readonly policy: AttachmentAuthorizationPolicy,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxService,
  ) {}

  async upload(
    actor: AuthenticatedUser,
    ticketId: string,
    dto: UploadAttachmentDto,
    file: Express.Multer.File | undefined,
  ): Promise<TicketAttachmentRow> {
    if (!file || file.size === 0) {
      if (file) await this.safeDeleteTemp(file.path);
      throw new DomainError(
        ERROR_CODES.ATTACHMENT_FILE_REQUIRED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Dosya zorunludur ve bos olamaz.',
      );
    }

    const detectedMimeType = await detectImageMimeType(file.path);
    if (!detectedMimeType || detectedMimeType !== file.mimetype) {
      await this.safeDeleteTemp(file.path);
      throw new DomainError(
        ERROR_CODES.ATTACHMENT_UNSUPPORTED_TYPE,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'Desteklenmeyen veya beyan edilen tur ile uyusmayan dosya.',
      );
    }

    const ticket = await this.assertUploadAllowed(actor, ticketId, dto, file);

    let finalized: { storageKey: string; checksum: string; size: number };
    try {
      finalized = await this.storage.finalize({ tempPath: file.path, mimeType: detectedMimeType });
    } catch {
      await this.safeDeleteTemp(file.path);
      throw new DomainError(
        ERROR_CODES.ATTACHMENT_STORAGE_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Dosya depolanamadi.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.attachmentRepo.create(tx, {
          ticketId,
          assignmentId: dto.assignmentId ?? null,
          uploadedByUserId: actor.id,
          attachmentType: dto.attachmentType,
          storageProvider: LOCAL_STORAGE_PROVIDER_NAME,
          storageKey: finalized.storageKey,
          originalFileName: file.originalname,
          mimeType: detectedMimeType,
          fileSize: finalized.size,
          checksum: finalized.checksum,
        });

        const auditMetadata = {
          attachmentId: created.id,
          ticketId,
          assignmentId: created.assignmentId,
          mimeType: created.mimeType,
          fileSize: created.fileSize,
          attachmentType: created.attachmentType,
          storageProvider: created.storageProvider,
        };

        await this.audit.log(tx, {
          action: DOMAIN_AUDIT_ACTIONS.ATTACHMENT_UPLOADED,
          actorUserId: actor.id,
          entityType: 'TicketAttachment',
          entityId: created.id,
          siteId: ticket.siteId,
          metadata: auditMetadata,
        });

        await this.outbox.publishInTx(tx, {
          eventType: 'AttachmentUploaded',
          aggregateType: 'TicketAttachment',
          aggregateId: created.id,
          payload: auditMetadata,
        });

        return created;
      });
    } catch (error) {
      await this.storage.delete(finalized.storageKey).catch(() => undefined);
      throw error;
    }
  }

  async list(
    actor: AuthenticatedUser,
    ticketId: string,
    query: ListAttachmentsQueryDto,
  ): Promise<PaginatedResult<TicketAttachmentRow>> {
    await this.ticketAccess.assertReadableAndGet(actor, ticketId, this.prisma);

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

    const rows = await this.attachmentRepo.listByTicket(this.prisma, { ticketId, cursor, limit });
    return buildPage(rows, limit);
  }

  // Onaylanan Faz 6 plani Bolum 10: attachment yok / soft-deleted / parent
  // ticket okunamiyor - ucu de ayni sonucu (404 ATTACHMENT_NOT_FOUND)
  // uretir; TICKET_NOT_FOUND disari sizmaz.
  async openDownloadStream(
    actor: AuthenticatedUser,
    attachmentId: string,
  ): Promise<DownloadStreamResult> {
    const attachment = await this.attachmentRepo.findAliveById(this.prisma, attachmentId);
    if (!attachment) throw this.attachmentNotFound();

    try {
      await this.ticketAccess.assertReadableAndGet(actor, attachment.ticketId, this.prisma);
    } catch (error) {
      if (error instanceof DomainError && error.code === ERROR_CODES.TICKET_NOT_FOUND) {
        throw this.attachmentNotFound();
      }
      throw error;
    }

    try {
      const stream = await this.storage.openReadStream(attachment.storageKey);
      return { attachment, stream };
    } catch {
      throw new DomainError(
        ERROR_CODES.ATTACHMENT_STORAGE_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Dosya depolama alaninda bulunamadi.',
      );
    }
  }

  private async assertUploadAllowed(
    actor: AuthenticatedUser,
    ticketId: string,
    dto: UploadAttachmentDto,
    file: Express.Multer.File,
  ) {
    try {
      const ticket = await this.ticketAccess.assertReadableAndGet(actor, ticketId, this.prisma);
      await this.policy.assertCanUpload(
        actor,
        ticket,
        dto.assignmentId,
        dto.attachmentType,
        (assignmentId) => this.assignmentLookup.findForAttachmentCheck(this.prisma, assignmentId),
      );
      return ticket;
    } catch (error) {
      await this.safeDeleteTemp(file.path);
      throw error;
    }
  }

  private async safeDeleteTemp(tempPath: string): Promise<void> {
    await this.storage.deleteTemp(tempPath).catch(() => undefined);
  }

  private attachmentNotFound(): never {
    throw new DomainError(
      ERROR_CODES.ATTACHMENT_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Attachment bulunamadi.',
    );
  }
}
