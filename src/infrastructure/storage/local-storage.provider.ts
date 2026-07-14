import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateStorageKey,
  resolveWithinBase,
} from '../../modules/attachments/security/storage-key.util';
import type { FinalizeInput, FinalizeResult, StorageProvider } from './storage-provider.interface';

// Onaylanan Faz 6 plani Bolum 5: bu fazin tek StorageProvider
// implementasyonu. Dosyanin tamamini RAM'e almadan (stream ile checksum,
// fs.rename ile atomic tasima) calisir.
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly config: ConfigService) {}

  private get basePath(): string {
    return this.config.getOrThrow<string>('storage.localPath');
  }

  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    const checksum = await this.computeChecksum(input.tempPath);
    const { size } = await stat(input.tempPath);

    const storageKey = generateStorageKey();
    const targetPath = resolveWithinBase(this.basePath, storageKey);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await rename(input.tempPath, targetPath);

    return { storageKey, checksum, size };
  }

  async openReadStream(storageKey: string): Promise<Readable> {
    const absolutePath = resolveWithinBase(this.basePath, storageKey);
    // fs.createReadStream ENOENT'i sync degil 'error' event'iyle bildirir;
    // once stat ile varligi dogrulanir ki cagiran taraf bunu normal bir
    // Promise reddi olarak yakalayabilsin (Bolum 10).
    await stat(absolutePath);
    return createReadStream(absolutePath);
  }

  async delete(storageKey: string): Promise<void> {
    const absolutePath = resolveWithinBase(this.basePath, storageKey);
    await this.safeUnlink(absolutePath);
  }

  async deleteTemp(tempPath: string): Promise<void> {
    await this.safeUnlink(tempPath);
  }

  private async safeUnlink(absolutePath: string): Promise<void> {
    try {
      await unlink(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async computeChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }
}
