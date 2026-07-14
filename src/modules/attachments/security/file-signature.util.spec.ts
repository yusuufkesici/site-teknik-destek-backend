import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { detectImageMimeType } from './file-signature.util';

// Kucuk, gercek magic number'lara sahip sahte fixture'lar - gercek zararli
// veya buyuk dosya kullanilmaz (onaylanan Faz 6 plani Bolum 13).
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);
const TEXT_HEADER = Buffer.from('bu bir metin dosyasidir, gorsel degil', 'ascii');

describe('detectImageMimeType', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'attachment-sig-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, content: Buffer): string {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it('JPEG magic number icin image/jpeg doner', async () => {
    const filePath = writeFixture('a.bin', JPEG_HEADER);
    await expect(detectImageMimeType(filePath)).resolves.toBe('image/jpeg');
  });

  it('PNG magic number icin image/png doner', async () => {
    const filePath = writeFixture('b.bin', PNG_HEADER);
    await expect(detectImageMimeType(filePath)).resolves.toBe('image/png');
  });

  it('WEBP magic number icin image/webp doner', async () => {
    const filePath = writeFixture('c.bin', WEBP_HEADER);
    await expect(detectImageMimeType(filePath)).resolves.toBe('image/webp');
  });

  it('desteklenmeyen icerik icin null doner', async () => {
    const filePath = writeFixture('d.bin', TEXT_HEADER);
    await expect(detectImageMimeType(filePath)).resolves.toBeNull();
  });

  it('cok kisa/bos dosya icin null doner', async () => {
    const filePath = writeFixture('e.bin', Buffer.alloc(0));
    await expect(detectImageMimeType(filePath)).resolves.toBeNull();
  });
});
