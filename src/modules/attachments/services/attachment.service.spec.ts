import { DomainError } from '../../../common/errors/domain-error';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { detectImageMimeType } from '../security/file-signature.util';
import { AttachmentService } from './attachment.service';

jest.mock('../security/file-signature.util');

const mockDetectImageMimeType = detectImageMimeType as jest.MockedFunction<
  typeof detectImageMimeType
>;

function actor(role: string, id = 'actor-1') {
  return { id, role, sessionId: 's', tokenVersion: 0 } as never;
}

function buildTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    code: 'TKT-2026-000001',
    createdByUserId: 'resident-1',
    siteId: 'site-1',
    facilityId: 'facility-1',
    title: 't',
    description: 'd',
    category: 'PLUMBING',
    urgency: 'STANDARD',
    status: 'IN_PROGRESS',
    source: 'RESIDENT',
    slaTargetAt: null,
    isRecurring: false,
    operationNote: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildAttachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attachment-1',
    ticketId: 'ticket-1',
    assignmentId: null,
    uploadedByUserId: 'actor-1',
    attachmentType: 'ISSUE',
    storageProvider: 'local',
    storageKey: 'attachments/final-key',
    originalFileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 100,
    checksum: 'x'.repeat(64),
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'photo.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: 100,
    destination: '/tmp',
    filename: 'temp-uuid',
    path: '/tmp/temp-uuid',
    buffer: Buffer.alloc(0),
    stream: undefined as never,
    ...overrides,
  } as Express.Multer.File;
}

function buildService() {
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn('tx')) };
  const attachmentRepo = {
    create: jest.fn().mockResolvedValue(buildAttachmentRow()),
    findAliveById: jest.fn().mockResolvedValue(buildAttachmentRow()),
    listByTicket: jest.fn().mockResolvedValue([]),
  };
  const ticketAccess = {
    assertReadableAndGet: jest.fn().mockResolvedValue(buildTicket()),
  };
  const assignmentLookup = {
    findForAttachmentCheck: jest.fn().mockResolvedValue(null),
  };
  const policy = {
    assertCanUpload: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    finalize: jest
      .fn()
      .mockResolvedValue({ storageKey: 'attachments/final-key', checksum: 'x', size: 100 }),
    openReadStream: jest.fn().mockResolvedValue('stream' as never),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteTemp: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { publishInTx: jest.fn().mockResolvedValue(undefined) };

  const service = new AttachmentService(
    prisma as never,
    attachmentRepo as never,
    ticketAccess as never,
    assignmentLookup as never,
    policy as never,
    storage as never,
    audit as never,
    outbox as never,
  );

  return {
    service,
    prisma,
    attachmentRepo,
    ticketAccess,
    assignmentLookup,
    policy,
    storage,
    audit,
    outbox,
  };
}

describe('AttachmentService.upload', () => {
  beforeEach(() => {
    mockDetectImageMimeType.mockResolvedValue('image/jpeg');
  });

  it('bos dosyada temp temizlenir ve ATTACHMENT_FILE_REQUIRED (422) firlatilir', async () => {
    const { service, storage } = buildService();
    const file = buildFile({ size: 0 });

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_FILE_REQUIRED });
    expect(storage.deleteTemp).toHaveBeenCalledWith(file.path);
  });

  it('dosya hic yoksa (undefined) temp temizlemeye calismadan ATTACHMENT_FILE_REQUIRED alir', async () => {
    const { service, storage } = buildService();

    await expect(
      service.upload(
        actor('RESIDENT'),
        'ticket-1',
        { attachmentType: 'ISSUE' as never },
        undefined,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_FILE_REQUIRED });
    expect(storage.deleteTemp).not.toHaveBeenCalled();
  });

  it('mime sniff basarisiz olursa (null) temp temizlenir ve ATTACHMENT_UNSUPPORTED_TYPE (415) firlatilir', async () => {
    mockDetectImageMimeType.mockResolvedValue(null);
    const { service, storage } = buildService();
    const file = buildFile();

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_UNSUPPORTED_TYPE });
    expect(storage.deleteTemp).toHaveBeenCalledWith(file.path);
  });

  it('sniff sonucu beyan edilen mimetype ile uyusmazsa temp temizlenir ve 415 firlatilir', async () => {
    mockDetectImageMimeType.mockResolvedValue('image/png');
    const { service, storage } = buildService();
    const file = buildFile({ mimetype: 'image/jpeg' });

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_UNSUPPORTED_TYPE });
    expect(storage.deleteTemp).toHaveBeenCalledWith(file.path);
  });

  it('yetkilendirme hatasinda temp temizlenir ve orijinal hata degismeden firlatilir', async () => {
    const { service, storage, policy } = buildService();
    const authError = new DomainError(
      ERROR_CODES.ATTACHMENT_UPLOAD_NOT_ALLOWED,
      403,
      'Bu rol assignment iliskili dosya yukleyemez.',
    );
    policy.assertCanUpload.mockRejectedValue(authError);
    const file = buildFile();

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toBe(authError);
    expect(storage.deleteTemp).toHaveBeenCalledWith(file.path);
    expect(storage.finalize).not.toHaveBeenCalled();
  });

  it('finalize basarisiz olursa temp temizlenir ve ATTACHMENT_STORAGE_FAILED (500) firlatilir', async () => {
    const { service, storage } = buildService();
    storage.finalize.mockRejectedValue(new Error('disk full'));
    const file = buildFile();

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_STORAGE_FAILED });
    expect(storage.deleteTemp).toHaveBeenCalledWith(file.path);
  });

  it('DB transaction basarisiz olursa final storage dosyasi silinir, orijinal hata degismeden firlatilir', async () => {
    const { service, storage, attachmentRepo } = buildService();
    const dbError = new Error('unique constraint violation');
    attachmentRepo.create.mockRejectedValue(dbError);
    const file = buildFile();

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toBe(dbError);
    expect(storage.delete).toHaveBeenCalledWith('attachments/final-key');
    expect(storage.deleteTemp).not.toHaveBeenCalled();
  });

  it('cleanup hatasi (deleteTemp reddi) asil domain hatasini ezmez', async () => {
    const { service, storage } = buildService();
    storage.deleteTemp.mockRejectedValue(new Error('unlink failed'));
    const file = buildFile({ size: 0 });

    await expect(
      service.upload(actor('RESIDENT'), 'ticket-1', { attachmentType: 'ISSUE' as never }, file),
    ).rejects.toMatchObject({ code: ERROR_CODES.ATTACHMENT_FILE_REQUIRED });
  });

  it('basarili upload attachmentRepo.create + audit + outbox cagirir, storage.delete cagirmaz', async () => {
    const { service, storage, attachmentRepo, audit, outbox } = buildService();
    const file = buildFile();

    const result = await service.upload(
      actor('RESIDENT'),
      'ticket-1',
      { attachmentType: 'ISSUE' as never },
      file,
    );

    expect(result.id).toBe('attachment-1');
    expect(attachmentRepo.create).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({
        ticketId: 'ticket-1',
        storageKey: 'attachments/final-key',
        mimeType: 'image/jpeg',
      }),
    );
    expect(audit.log).toHaveBeenCalled();
    expect(outbox.publishInTx).toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('RESIDENT/SITE_MANAGER assignmentId gonderirse AssignmentLookupService hic cagrilmaz', async () => {
    const { service, assignmentLookup, policy } = buildService();
    policy.assertCanUpload.mockImplementation(
      async (_actor, _ticket, _rawAssignmentId, _type, _lookup) => undefined,
    );
    const file = buildFile();

    await service.upload(
      actor('RESIDENT'),
      'ticket-1',
      { attachmentType: 'ISSUE' as never, assignmentId: 'assignment-1' },
      file,
    );

    expect(assignmentLookup.findForAttachmentCheck).not.toHaveBeenCalled();
  });
});

describe('AttachmentService.openDownloadStream', () => {
  it('attachment bulunamazsa ATTACHMENT_NOT_FOUND (404) alir', async () => {
    const { service, attachmentRepo } = buildService();
    attachmentRepo.findAliveById.mockResolvedValue(null);

    await expect(
      service.openDownloadStream(actor('RESIDENT'), 'attachment-1'),
    ).rejects.toMatchObject({
      code: ERROR_CODES.ATTACHMENT_NOT_FOUND,
    });
  });

  it('ticket okunamazsa (TICKET_NOT_FOUND) ATTACHMENT_NOT_FOUND a cevrilir', async () => {
    const { service, ticketAccess } = buildService();
    ticketAccess.assertReadableAndGet.mockRejectedValue(
      new DomainError(ERROR_CODES.TICKET_NOT_FOUND, 404, 'Ticket bulunamadi.'),
    );

    await expect(
      service.openDownloadStream(actor('RESIDENT'), 'attachment-1'),
    ).rejects.toMatchObject({
      code: ERROR_CODES.ATTACHMENT_NOT_FOUND,
    });
  });

  it('beklenmeyen hata TICKET_NOT_FOUND disinda ise degistirilmeden firlatilir', async () => {
    const { service, ticketAccess } = buildService();
    const unexpected = new Error('infra hatasi');
    ticketAccess.assertReadableAndGet.mockRejectedValue(unexpected);

    await expect(service.openDownloadStream(actor('RESIDENT'), 'attachment-1')).rejects.toBe(
      unexpected,
    );
  });

  it('storage dosyasi bulunamazsa ATTACHMENT_STORAGE_FAILED (500) alir', async () => {
    const { service, storage } = buildService();
    storage.openReadStream.mockRejectedValue(new Error('ENOENT'));

    await expect(
      service.openDownloadStream(actor('RESIDENT'), 'attachment-1'),
    ).rejects.toMatchObject({
      code: ERROR_CODES.ATTACHMENT_STORAGE_FAILED,
    });
  });

  it('basarili durumda attachment + stream doner', async () => {
    const { service } = buildService();
    const result = await service.openDownloadStream(actor('RESIDENT'), 'attachment-1');
    expect(result.attachment.id).toBe('attachment-1');
    expect(result.stream).toBe('stream');
  });
});
