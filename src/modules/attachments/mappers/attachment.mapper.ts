import type { TicketAttachmentRow } from '../repositories/ticket-attachment.repository';

export interface AttachmentResponse {
  id: string;
  ticketId: string;
  assignmentId: string | null;
  attachmentType: TicketAttachmentRow['attachmentType'];
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  uploadedByUserId: string;
  createdAt: Date;
}

// Onaylanan Faz 6 plani Bolum 6/8: storageProvider/storageKey/checksum
// asla response'a girmez - acik alan listesi (spread degil).
export function toAttachmentResponse(row: TicketAttachmentRow): AttachmentResponse {
  return {
    id: row.id,
    ticketId: row.ticketId,
    assignmentId: row.assignmentId,
    attachmentType: row.attachmentType,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
  };
}
