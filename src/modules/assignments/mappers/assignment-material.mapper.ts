import type { AssignmentMaterialWithMaterialRow } from '../repositories/assignment-material.repository';

// Decimal alanlar JSON'a string olarak serilenir - number/Float donusumu
// hicbir katmanda yapilmaz (Faz 5 Bolum 8). toFixed(n) kullanilir (toString()
// degil): decimal.js toString() sondaki sifirlari kirpar (ör. "37.50" ->
// "37.5"), bu da DB kolon hassasiyetiyle (Decimal(12,3)/Decimal(12,2))
// tutarsiz bir gorunum verir.
export function toAssignmentMaterialResponse(row: AssignmentMaterialWithMaterialRow) {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    material: {
      id: row.material.id,
      name: row.material.name,
      code: row.material.code,
      unit: row.material.unit,
    },
    quantity: row.quantity.toFixed(3),
    unitPrice: row.unitPrice.toFixed(2),
    totalPrice: row.totalPrice.toFixed(2),
    suppliedBy: row.suppliedBy,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}
