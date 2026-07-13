import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actor: any;

describe('FacilityService - gercek PostgreSQL', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilityService: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { FacilityService } = await import(
      '../../../src/modules/facilities/services/facility.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    facilityService = app.get(FacilityService);

    const opsUser = await prisma.user.create({
      data: { phoneNumber: '+905550000001', firstName: 'Ops', lastName: 'Actor', role: 'OPERATIONS' },
    });
    actor = { id: opsUser.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 };
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  it('ayni parent altinda ayni kod ikinci kez olusturulamaz (409 FACILITY_CODE_CONFLICT)', async () => {
    const site = await facilityService.createSite({ name: 'Site A', code: 'FH-SITE-A' }, actor);
    await facilityService.createBlock(site.id, { name: 'Blok 1', code: 'B1' }, actor);

    await expect(
      facilityService.createBlock(site.id, { name: 'Blok 1 Tekrar', code: 'B1' }, actor),
    ).rejects.toMatchObject({ code: 'FACILITY_CODE_CONFLICT' });
  });

  it('soft-delete edilmis facility kodu ayni parent altinda yeniden kullanilabilir', async () => {
    const site = await facilityService.createSite({ name: 'Site B', code: 'FH-SITE-B' }, actor);
    const block = await facilityService.createBlock(site.id, { name: 'Blok X', code: 'BX' }, actor);

    // Faz 3 kapsaminda soft-delete endpoint'i yok; kisitin (uq_facilities_
    // parent_code_alive, WHERE deleted_at IS NULL) DB seviyesinde dogru
    // calistigini kanitlamak icin dogrudan DB'de soft-delete simule edilir.
    await prisma.facility.update({ where: { id: block.id }, data: { deletedAt: new Date() } });

    const recreated = await facilityService.createBlock(
      site.id,
      { name: 'Blok X Yeni', code: 'BX' },
      actor,
    );
    expect(recreated.id).not.toBe(block.id);
  });

  it('var olmayan parent icin FACILITY_NOT_FOUND firlatir', async () => {
    await expect(
      facilityService.createBlock('11111111-1111-4111-8111-111111111111', { name: 'X', code: 'X' }, actor),
    ).rejects.toMatchObject({ code: 'FACILITY_NOT_FOUND' });
  });

  it('chk_facility_root: SITE olmayan bir facility parent_id/site_id olmadan DB seviyesinde reddedilir', async () => {
    await expect(
      prisma.facility.create({
        data: { type: 'BLOCK', name: 'Gecersiz', code: 'INVALID-ROOT' },
      }),
    ).rejects.toThrow();
  });

  it('getTree tam hiyerarsiyi (site->block->unit) dogru kurar', async () => {
    const site = await facilityService.createSite({ name: 'Site C', code: 'FH-SITE-C' }, actor);
    const block = await facilityService.createBlock(site.id, { name: 'Blok 1', code: 'B1' }, actor);
    const unit = await facilityService.createUnit(block.id, { code: 'D-1' }, actor);
    await facilityService.createCommonArea(site.id, { name: 'Bahce', code: 'GARDEN' }, actor);

    const tree = await facilityService.getTree(site.id);

    expect(tree.id).toBe(site.id);
    expect(tree.children.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([block.id, expect.any(String)]),
    );
    const blockNode = tree.children.find((c: { id: string }) => c.id === block.id);
    expect(blockNode.children.map((c: { id: string }) => c.id)).toContain(unit.id);
  });

  it('bulunmayan site icin getTree SITE_NOT_FOUND firlatir', async () => {
    await expect(
      facilityService.getTree('22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });
});
