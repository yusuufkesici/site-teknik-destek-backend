import { MaterialLookupService } from './material-lookup.service';

function buildMaterial(overrides: Record<string, unknown> = {}) {
  return {
    id: 'material-1',
    name: 'Vida',
    code: 'MAT-001',
    unit: 'adet',
    description: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function buildService() {
  const materialRepo = { findAliveById: jest.fn().mockResolvedValue(buildMaterial()) };
  const service = new MaterialLookupService(materialRepo as never);
  return { service, materialRepo };
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: { getStatus(): number }) => {
    expect(error.getStatus()).toBe(status);
  });
}

describe('MaterialLookupService.assertActiveMaterial', () => {
  it('bulunamazsa MATERIAL_NOT_FOUND (404) firlatir', async () => {
    const { service, materialRepo } = buildService();
    materialRepo.findAliveById.mockResolvedValue(null);
    await expectDomainError(
      service.assertActiveMaterial('tx' as never, 'material-1'),
      'MATERIAL_NOT_FOUND',
      404,
    );
  });

  it('isActive=false ise MATERIAL_INACTIVE (409) firlatir', async () => {
    const { service, materialRepo } = buildService();
    materialRepo.findAliveById.mockResolvedValue(buildMaterial({ isActive: false }));
    await expectDomainError(
      service.assertActiveMaterial('tx' as never, 'material-1'),
      'MATERIAL_INACTIVE',
      409,
    );
  });

  it('aktifse materyali dondurur', async () => {
    const { service } = buildService();
    const result = await service.assertActiveMaterial('tx' as never, 'material-1');
    expect(result.id).toBe('material-1');
  });
});
