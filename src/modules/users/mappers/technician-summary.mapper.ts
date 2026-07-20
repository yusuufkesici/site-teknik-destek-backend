import type { TechnicianSummaryRow } from '../repositories/user.repository';

export interface TechnicianSummaryResponse {
  id: string;
  firstName: string;
  lastName: string;
}

// Acik alan listesi (spread YOK). phoneNumber/tokenVersion/isActive/
// deletedAt gibi alanlar satirda zaten secilmez; mapper yine de alanlari
// tek tek kopyalayarak gelecekteki satir genislemelerine karsi response
// sozlesmesini sabitler (veri minimizasyonu - plan Bolum 11).
export function toTechnicianSummaryResponse(row: TechnicianSummaryRow): TechnicianSummaryResponse {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
  };
}
