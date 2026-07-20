import type { ResidentUnitAssignmentWithUnitRow } from '../../memberships/repositories/resident-unit-assignment.repository';

export interface MyUnitResponse {
  id: string;
  unitId: string;
  isPrimary: boolean;
  startsAt: Date;
  unit: {
    id: string;
    name: string;
    code: string;
    siteId: string;
  };
}

// Acik alan listesi (spread YOK). isActive/endsAt/userId ve facility'nin
// diger alanlari response'a cikmaz. chk_facility_root DB kisiti UNIT
// satirlarinda siteId'nin hep dolu oldugunu garanti eder; yine de tipe
// guvenmek yerine acikca dogrulanir ve olusamayacak null satir sessizce
// elenir (ticket-authorization.policy.ts'in ayni kisit icin kullandigi
// "assertion yerine acik kontrol" deseni).
export function toMyUnitResponse(row: ResidentUnitAssignmentWithUnitRow): MyUnitResponse | null {
  if (row.unit.siteId === null) {
    return null;
  }

  return {
    id: row.id,
    unitId: row.unitId,
    isPrimary: row.isPrimary,
    startsAt: row.startsAt,
    unit: {
      id: row.unit.id,
      name: row.unit.name,
      code: row.unit.code,
      siteId: row.unit.siteId,
    },
  };
}
