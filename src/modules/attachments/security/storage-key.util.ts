import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

// Onaylanan Faz 6 plani Bolum 5/8: storage key kullanici girdisinden
// asla uretilmez - crypto.randomUUID() tabanli, sabit "attachments/"
// alt dizini altinda.
export function generateStorageKey(): string {
  return path.posix.join('attachments', randomUUID());
}

// Path traversal guard: resolve edilen mutlak yolun 'baseDir' disina
// cikmadigini dogrular (ör. storageKey icinde "../" olsa dahi). DB'den
// gelen storageKey degeri her zaman bu fonksiyondan gecirilir.
export function resolveWithinBase(baseDir: string, relativeKey: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeKey);

  const isWithinBase =
    resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);

  if (!isWithinBase) {
    throw new Error(`Storage key izin verilen dizin disina cikiyor: ${relativeKey}`);
  }

  return resolvedTarget;
}
