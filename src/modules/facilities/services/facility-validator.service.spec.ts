import { DomainError } from '../../../common/errors/domain-error';
import type { FacilityRow } from '../repositories/facility.repository';
import { FacilityValidatorService } from './facility-validator.service';

function buildFacility(overrides: Partial<FacilityRow>): FacilityRow {
  return {
    id: 'facility-1',
    type: 'SITE',
    name: 'Test',
    code: 'CODE',
    parentId: null,
    siteId: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('FacilityValidatorService.assertValidParentAndDeriveSiteId', () => {
  const validator = new FacilityValidatorService();

  it('parent yoksa FACILITY_NOT_FOUND firlatir', () => {
    expect(() => validator.assertValidParentAndDeriveSiteId('BLOCK', null)).toThrow(DomainError);
    try {
      validator.assertValidParentAndDeriveSiteId('BLOCK', null);
    } catch (error) {
      expect((error as DomainError).code).toBe('FACILITY_NOT_FOUND');
    }
  });

  it('BLOCK icin SITE parent gecerlidir ve siteId parent.id olur', () => {
    const site = buildFacility({ id: 'site-1', type: 'SITE' });
    expect(validator.assertValidParentAndDeriveSiteId('BLOCK', site)).toBe('site-1');
  });

  it('BLOCK icin SITE olmayan parent FACILITY_INVALID_PARENT firlatir', () => {
    const unit = buildFacility({ id: 'unit-1', type: 'UNIT', siteId: 'site-1' });
    try {
      validator.assertValidParentAndDeriveSiteId('BLOCK', unit);
      fail('hata beklenıyordu');
    } catch (error) {
      expect((error as DomainError).code).toBe('FACILITY_INVALID_PARENT');
    }
  });

  it('UNIT icin BLOCK parent gecerlidir ve siteId parent.siteId olur', () => {
    const block = buildFacility({ id: 'block-1', type: 'BLOCK', siteId: 'site-1' });
    expect(validator.assertValidParentAndDeriveSiteId('UNIT', block)).toBe('site-1');
  });

  it('UNIT icin SITE parent FACILITY_INVALID_PARENT firlatir', () => {
    const site = buildFacility({ id: 'site-1', type: 'SITE' });
    try {
      validator.assertValidParentAndDeriveSiteId('UNIT', site);
      fail('hata beklenıyordu');
    } catch (error) {
      expect((error as DomainError).code).toBe('FACILITY_INVALID_PARENT');
    }
  });

  it('COMMON_AREA icin SITE veya BLOCK parent gecerlidir', () => {
    const site = buildFacility({ id: 'site-1', type: 'SITE' });
    const block = buildFacility({ id: 'block-1', type: 'BLOCK', siteId: 'site-2' });

    expect(validator.assertValidParentAndDeriveSiteId('COMMON_AREA', site)).toBe('site-1');
    expect(validator.assertValidParentAndDeriveSiteId('COMMON_AREA', block)).toBe('site-2');
  });

  it('COMMON_AREA icin UNIT parent FACILITY_INVALID_PARENT firlatir', () => {
    const unit = buildFacility({ id: 'unit-1', type: 'UNIT', siteId: 'site-1' });
    try {
      validator.assertValidParentAndDeriveSiteId('COMMON_AREA', unit);
      fail('hata beklenıyordu');
    } catch (error) {
      expect((error as DomainError).code).toBe('FACILITY_INVALID_PARENT');
    }
  });
});
