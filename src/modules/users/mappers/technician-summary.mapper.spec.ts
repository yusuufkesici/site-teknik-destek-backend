import { toTechnicianSummaryResponse } from './technician-summary.mapper';

describe('toTechnicianSummaryResponse', () => {
  it('yalniz id/firstName/lastName doner', () => {
    const response = toTechnicianSummaryResponse({
      id: 'tech-1',
      firstName: 'Tekni',
      lastName: 'Syen',
    });

    expect(response).toEqual({ id: 'tech-1', firstName: 'Tekni', lastName: 'Syen' });
  });

  it('satira sizabilecek ic alanlar response sozlesmesine tasinmaz', () => {
    // Satir tipi genislese bile mapper alanlari tek tek kopyalar - telefon
    // veya tokenVersion gibi alanlar asla cikamaz (veri minimizasyonu).
    const rowWithLeakedFields = {
      id: 'tech-1',
      firstName: 'Tekni',
      lastName: 'Syen',
      phoneNumber: '+905551112233',
      tokenVersion: 3,
      deletedAt: null,
    };

    const response = toTechnicianSummaryResponse(rowWithLeakedFields);

    expect(response).not.toHaveProperty('phoneNumber');
    expect(response).not.toHaveProperty('tokenVersion');
    expect(response).not.toHaveProperty('deletedAt');
  });
});
