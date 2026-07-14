import type { TicketAttachmentRow } from '../repositories/ticket-attachment.repository';
import { toAttachmentResponse } from './attachment.mapper';

function buildRow(overrides: Partial<TicketAttachmentRow> = {}): TicketAttachmentRow {
  return {
    id: 'attachment-1',
    ticketId: 'ticket-1',
    assignmentId: null,
    uploadedByUserId: 'user-1',
    attachmentType: 'ISSUE' as never,
    storageProvider: 'local',
    storageKey: 'attachments/secret-key',
    originalFileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    checksum: 'a'.repeat(64),
    createdAt: new Date('2026-07-14T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('toAttachmentResponse', () => {
  it('storageProvider/storageKey/checksum alanlarini sizdirmaz', () => {
    const response = toAttachmentResponse(buildRow());
    expect(response).not.toHaveProperty('storageProvider');
    expect(response).not.toHaveProperty('storageKey');
    expect(response).not.toHaveProperty('checksum');
    expect(response).not.toHaveProperty('deletedAt');
  });

  it('gerekli alanlari aynen tasir', () => {
    const row = buildRow({ assignmentId: 'assignment-1' });
    const response = toAttachmentResponse(row);
    expect(response).toEqual({
      id: row.id,
      ticketId: row.ticketId,
      assignmentId: row.assignmentId,
      attachmentType: row.attachmentType,
      originalFileName: row.originalFileName,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      uploadedByUserId: row.uploadedByUserId,
      createdAt: row.createdAt,
    });
  });
});
