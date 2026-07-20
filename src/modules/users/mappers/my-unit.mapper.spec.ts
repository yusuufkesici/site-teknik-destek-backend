import type { ResidentUnitAssignmentWithUnitRow } from '../../memberships/repositories/resident-unit-assignment.repository';
import { toMyUnitResponse } from './my-unit.mapper';

function buildRow(
  overrides: Partial<ResidentUnitAssignmentWithUnitRow> = {},
): ResidentUnitAssignmentWithUnitRow {
  return {
    id: 'rua-1',
    unitId: 'unit-1',
    isPrimary: true,
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    unit: { id: 'unit-1', name: 'Daire 1', code: 'D-1', siteId: 'site-1' },
    ...overrides,
  };
}

describe('toMyUnitResponse', () => {
  it('assignment ve unit ozetini acik alan listesiyle doner', () => {
    const response = toMyUnitResponse(buildRow());

    expect(response).toEqual({
      id: 'rua-1',
      unitId: 'unit-1',
      isPrimary: true,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      unit: { id: 'unit-1', name: 'Daire 1', code: 'D-1', siteId: 'site-1' },
    });
  });

  it('ic alanlar (isActive/endsAt/userId) response sozlesmesinde yoktur', () => {
    const response = toMyUnitResponse(buildRow());

    expect(response).not.toHaveProperty('isActive');
    expect(response).not.toHaveProperty('endsAt');
    expect(response).not.toHaveProperty('userId');
  });

  it('chk_facility_root geregi olusamayacak null siteId satirini null olarak isaretler', () => {
    const response = toMyUnitResponse(
      buildRow({ unit: { id: 'unit-1', name: 'Daire 1', code: 'D-1', siteId: null } }),
    );

    expect(response).toBeNull();
  });
});
