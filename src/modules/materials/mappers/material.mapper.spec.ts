import type { MaterialRow } from '../repositories/material.repository';
import { toMaterialResponse } from './material.mapper';

function buildRow(overrides: Partial<MaterialRow> = {}): MaterialRow {
  return {
    id: 'material-1',
    name: '16A Sigorta',
    code: 'SGT-16A',
    unit: 'adet',
    description: 'C tipi otomat',
    isActive: true,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-02T10:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('toMaterialResponse', () => {
  it('yalniz katalog alanlarini doner', () => {
    const response = toMaterialResponse(buildRow());

    expect(response).toEqual({
      id: 'material-1',
      name: '16A Sigorta',
      code: 'SGT-16A',
      unit: 'adet',
      description: 'C tipi otomat',
      createdAt: new Date('2026-07-01T10:00:00.000Z'),
    });
  });

  it('ic alanlari (isActive/updatedAt/deletedAt) response icermez', () => {
    const response = toMaterialResponse(buildRow());

    expect(response).not.toHaveProperty('isActive');
    expect(response).not.toHaveProperty('updatedAt');
    expect(response).not.toHaveProperty('deletedAt');
  });
});
