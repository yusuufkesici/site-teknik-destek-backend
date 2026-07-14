import { AttachmentType } from '../../generated/prisma-client/enums';

// Onaylanan Faz 6 plani Bolum 1/8: bu fazda yalniz JPEG/PNG/WEBP gorsel
// desteklenir (PDF/belge kapsam disi). Sabit domain constant - env degil
// (Bolum 12 karari).
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

// Teknisyen yalniz kendi assignment'ina bu tiplerle fotograf ekleyebilir
// (onaylanan Faz 6 plani Bolum 7).
export const TECHNICIAN_ALLOWED_ATTACHMENT_TYPES = [
  AttachmentType.BEFORE_WORK,
  AttachmentType.AFTER_WORK,
  AttachmentType.MATERIAL,
] as const;
