import type { FacilityRow } from '../repositories/facility.repository';
import { FacilityService } from './facility.service';
import { FacilityValidatorService } from './facility-validator.service';

class UniqueConstraintError extends Error {
  code = 'P2002';
}

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

const actor = { id: 'actor-1', role: 'OPERATIONS', sessionId: 's1', tokenVersion: 0 } as const;

jest.mock('../../../common/utils/prisma-error.util', () => ({
  isUniqueConstraintViolation: (error: unknown) => error instanceof UniqueConstraintError,
}));

function buildService(overrides: { createImpl?: () => unknown } = {}) {
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn('tx')) };
  const facilityRepo = {
    create: overrides.createImpl
      ? jest.fn(overrides.createImpl)
      : jest.fn().mockResolvedValue(buildFacility({ id: 'created-1' })),
    findAliveById: jest.fn(),
    lockForShare: jest.fn(),
    findTreeForSite: jest.fn().mockResolvedValue([]),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const validator = new FacilityValidatorService();

  const service = new FacilityService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facilityRepo as any,
    validator,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
  );

  return { service, prisma, facilityRepo, audit };
}

describe('FacilityService', () => {
  describe('createSite', () => {
    it('site olusturur ve FACILITY_CREATED audit yazar', async () => {
      const { service, audit } = buildService();

      const result = await service.createSite({ name: 'Site A', code: 'SITE-A' }, actor);

      expect(result.id).toBe('created-1');
      expect(audit.log).toHaveBeenCalledWith(
        'tx',
        expect.objectContaining({ action: 'FACILITY_CREATED', entityId: 'created-1' }),
      );
    });

    it('kod cakismasinda FACILITY_CODE_CONFLICT firlatir', async () => {
      const { service } = buildService({
        createImpl: () => {
          throw new UniqueConstraintError('duplicate');
        },
      });

      await expect(
        service.createSite({ name: 'Site A', code: 'SITE-A' }, actor),
      ).rejects.toMatchObject({ code: 'FACILITY_CODE_CONFLICT' });
    });
  });

  describe('createBlock', () => {
    it('parenti FOR SHARE kilitler ve dogru siteId ile olusturur', async () => {
      const { service, facilityRepo } = buildService();
      facilityRepo.lockForShare.mockResolvedValue(buildFacility({ id: 'site-1', type: 'SITE' }));

      await service.createBlock('site-1', { name: 'Blok A', code: 'A' }, actor);

      expect(facilityRepo.lockForShare).toHaveBeenCalledWith('tx', 'site-1');
      expect(facilityRepo.create).toHaveBeenCalledWith(
        'tx',
        expect.objectContaining({ type: 'BLOCK', parentId: 'site-1', siteId: 'site-1' }),
      );
    });

    it('parent SITE degilse FACILITY_INVALID_PARENT firlatir', async () => {
      const { service, facilityRepo } = buildService();
      facilityRepo.lockForShare.mockResolvedValue(
        buildFacility({ id: 'unit-1', type: 'UNIT', siteId: 'site-1' }),
      );

      await expect(
        service.createBlock('unit-1', { name: 'X', code: 'X' }, actor),
      ).rejects.toMatchObject({ code: 'FACILITY_INVALID_PARENT' });
    });
  });

  describe('createUnit', () => {
    it('name verilmezse code degerini kullanir', async () => {
      const { service, facilityRepo } = buildService();
      facilityRepo.lockForShare.mockResolvedValue(
        buildFacility({ id: 'block-1', type: 'BLOCK', siteId: 'site-1' }),
      );

      await service.createUnit('block-1', { code: 'D-101' }, actor);

      expect(facilityRepo.create).toHaveBeenCalledWith(
        'tx',
        expect.objectContaining({ type: 'UNIT', name: 'D-101', code: 'D-101' }),
      );
    });
  });

  describe('getTree', () => {
    it('site yoksa SITE_NOT_FOUND firlatir', async () => {
      const { service, facilityRepo } = buildService();
      facilityRepo.findAliveById.mockResolvedValue(null);

      await expect(service.getTree('missing-site')).rejects.toMatchObject({
        code: 'SITE_NOT_FOUND',
      });
    });

    it('agaci dogru iliskilendirir', async () => {
      const { service, facilityRepo } = buildService();
      const site = buildFacility({ id: 'site-1', type: 'SITE' });
      const block = buildFacility({
        id: 'block-1',
        type: 'BLOCK',
        parentId: 'site-1',
        siteId: 'site-1',
      });
      const unit = buildFacility({
        id: 'unit-1',
        type: 'UNIT',
        parentId: 'block-1',
        siteId: 'site-1',
      });
      facilityRepo.findAliveById.mockResolvedValue(site);
      facilityRepo.findTreeForSite.mockResolvedValue([site, block, unit]);

      const tree = await service.getTree('site-1');

      expect(tree.id).toBe('site-1');
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].id).toBe('block-1');
      expect(tree.children[0].children[0].id).toBe('unit-1');
    });
  });
});
