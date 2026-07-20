import type { MaterialRow } from '../repositories/material.repository';

export interface MaterialResponse {
  id: string;
  name: string;
  code: string;
  unit: string;
  description: string | null;
  createdAt: Date;
}

// Acik alan listesi (spread YOK - attachment.mapper emsali). isActive
// (liste zaten yalniz aktifleri doner), updatedAt ve deletedAt response'a
// cikmaz. createdAt cursor siralamasinin dayandigi alan oldugu icin dahildir.
export function toMaterialResponse(row: MaterialRow): MaterialResponse {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    unit: row.unit,
    description: row.description,
    createdAt: row.createdAt,
  };
}
