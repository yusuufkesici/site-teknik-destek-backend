import { open } from 'node:fs/promises';
import type { AllowedAttachmentMimeType } from '../../../common/constants/attachment.constant';

const HEADER_BYTES_NEEDED = 12; // WEBP imzasi icin en uzun (RIFF....WEBP)

// Onaylanan Faz 6 plani Bolum 8: uzantiya/beyan edilen mimetype'a
// guvenilmez - ilk baytlar (magic number) okunup dogrulanir. Dosyanin
// tamami RAM'e alinmaz, yalniz basligi okunur.
async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES_NEEDED);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES_NEEDED, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function matchesSignature(header: Buffer): AllowedAttachmentMimeType | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

// Dosyanin gercek icerigine bakarak desteklenen 3 formattan birini
// dondurur, hicbiriyle eslesmezse null.
export async function detectImageMimeType(
  filePath: string,
): Promise<AllowedAttachmentMimeType | null> {
  const header = await readHeader(filePath);
  return matchesSignature(header);
}
