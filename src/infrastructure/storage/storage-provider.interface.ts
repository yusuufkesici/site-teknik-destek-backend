import type { Readable } from 'node:stream';

// Onaylanan Faz 6 plani Bolum 5: dar StorageProvider arayuzu. Repository
// ile storage provider birbirine karistirilmaz - bu arayuz yalniz dosya
// icerigi icin, metadata Prisma repository'sinde saklanir.
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface FinalizeInput {
  tempPath: string;
  mimeType: string;
}

export interface FinalizeResult {
  storageKey: string;
  checksum: string;
  size: number;
}

export interface StorageProvider {
  // tempPath'i kalici konuma tasir (ayni filesystem icinde atomic rename),
  // SHA-256 checksum ve gercek boyutu doner.
  finalize(input: FinalizeInput): Promise<FinalizeResult>;
  openReadStream(storageKey: string): Promise<Readable>;
  // Finalize edilmis (kalici) dosyayi siler. Idempotent - dosya yoksa hata
  // firlatmaz.
  delete(storageKey: string): Promise<void>;
  // Henuz finalize edilmemis gecici (tmp/) dosyayi siler. Idempotent.
  deleteTemp(tempPath: string): Promise<void>;
}
