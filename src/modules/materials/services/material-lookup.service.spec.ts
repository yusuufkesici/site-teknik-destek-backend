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
  const materialRepo = {
    findAliveById: jest.fn().mockResolvedValue(buildMaterial()),
    listActive: jest.fn().mockResolvedValue([]),
  };
  const prisma = {};
  const service = new MaterialLookupService(materialRepo as never, prisma as never);
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

describe('MaterialLookupService.listActiveCatalog', () => {
  it('gecersiz cursor icin VALIDATION_ERROR (422) firlatir, repository cagrilmaz', async () => {
    const { service, materialRepo } = buildService();
    await expectDomainError(
      service.listActiveCatalog({ cursor: '%%%bozuk%%%' }),
      'VALIDATION_ERROR',
      422,
    );
    expect(materialRepo.listActive).not.toHaveBeenCalled();
  });

  it('varsayilan limit 20 ile repository cagrilir ve bos sayfada nextCursor null olur', async () => {
    const { service, materialRepo } = buildService();
    const page = await service.listActiveCatalog({});

    expect(materialRepo.listActive).toHaveBeenCalledWith(expect.anything(), {
      cursor: null,
      limit: 20,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('limit+1 kayit geldiginde son kayit kirpilir ve nextCursor uretilir', async () => {
    const { service, materialRepo } = buildService();
    const first = buildMaterial({ id: 'a', createdAt: new Date('2026-07-02T00:00:00.000Z') });
    const second = buildMaterial({ id: 'b', createdAt: new Date('2026-07-01T00:00:00.000Z') });
    materialRepo.listActive.mockResolvedValue([first, second]);

    const page = await service.listActiveCatalog({ limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'a' });
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});
