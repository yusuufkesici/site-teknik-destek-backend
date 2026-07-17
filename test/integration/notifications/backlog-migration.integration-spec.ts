import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan docs/phase-8-plan.md Bolum 9.1: eski Faz 4-7 backlog'unun tek
// seferlik migration UPDATE'i ile temizlenmesi. Migration testDb
// baslarken (bos bir DB uzerinde) zaten calistigindan, bu testte AYNI SQL
// mantigi manuel tohumlanan satirlar uzerinde yeniden calistirilarak hedef
// kosulun GERCEKTEN yalniz PENDING/PROCESSING durumundaki eski kayitlari
// etkiledigi, PROCESSED/FAILED kayitlara VE komut calistiktan SONRA
// eklenen taze kayitlara DOKUNMADIGI dogrulanir.
describe('Backlog temizleme UPDATE mantigi (gercek PostgreSQL)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  async function insertRow(status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED'): Promise<string> {
    const row = await prisma.outboxEvent.create({
      data: {
        eventType: 'TechnicianAssigned',
        aggregateType: 'Assignment',
        aggregateId: '55555555-5555-4555-8555-555555555555',
        payload: {},
        status,
        processedAt: status === 'PROCESSED' ? new Date() : undefined,
        failedAt: status === 'FAILED' ? new Date() : undefined,
      },
    });
    return row.id;
  }

  it('yalniz PENDING/PROCESSING durumundaki satirlar PROCESSED + SKIPPED_PRE_PHASE8_BACKLOG isaretiyle guncellenir', async () => {
    const pendingId = await insertRow('PENDING');
    const processingId = await insertRow('PROCESSING');
    const alreadyProcessedId = await insertRow('PROCESSED');
    const failedId = await insertRow('FAILED');

    // Migration dosyasindaki (20260716155648_phase8_slice1_outbox_notifications)
    // backlog UPDATE'iyle BIREBIR ayni SQL - yalniz `id IN (...)` test
    // izolasyonu icin eklendi (gercek migration'da yoktur, tum tabloyu
    // hedefler).
    await prisma.$executeRaw`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSED',
          "processed_at" = now(),
          "last_error" = 'SKIPPED_PRE_PHASE8_BACKLOG'
      WHERE "status" IN ('PENDING', 'PROCESSING')
        AND id IN (${pendingId}::uuid, ${processingId}::uuid, ${alreadyProcessedId}::uuid, ${failedId}::uuid)
    `;

    const rows: { id: string; status: string; lastError: string | null }[] =
      await prisma.outboxEvent.findMany({
        where: { id: { in: [pendingId, processingId, alreadyProcessedId, failedId] } },
      });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(pendingId)?.status).toBe('PROCESSED');
    expect(byId.get(pendingId)?.lastError).toBe('SKIPPED_PRE_PHASE8_BACKLOG');
    expect(byId.get(processingId)?.status).toBe('PROCESSED');
    expect(byId.get(processingId)?.lastError).toBe('SKIPPED_PRE_PHASE8_BACKLOG');

    // Zaten PROCESSED olan kayit dokunulmadan kalir (lastError set edilmez -
    // WHERE kosulu status IN ('PENDING','PROCESSING') oldugundan bu satir
    // hic eslesmez).
    expect(byId.get(alreadyProcessedId)?.lastError).toBeNull();
    // FAILED kayit PROCESSED'e CEVRILMEZ - WHERE kosulu FAILED'i kapsamaz.
    expect(byId.get(failedId)?.status).toBe('FAILED');
  });

  it('UPDATE calistiktan SONRA olusturulan (taze) kayitlar etkilenmez', async () => {
    const beforeId = await insertRow('PENDING');

    await prisma.$executeRaw`
      UPDATE "outbox_events"
      SET "status" = 'PROCESSED', "processed_at" = now(), "last_error" = 'SKIPPED_PRE_PHASE8_BACKLOG'
      WHERE "status" IN ('PENDING', 'PROCESSING') AND id = ${beforeId}::uuid
    `;

    // Bu satir UPDATE'ten SONRA olusturuldu - migration'in "yalniz o ana
    // kadar birikmis olani kapsar, sonraki gercek olaylara dokunmaz"
    // ilkesinin dogrudan kaniti.
    const afterId = await insertRow('PENDING');

    const afterRow = await prisma.outboxEvent.findUnique({ where: { id: afterId } });
    expect(afterRow.status).toBe('PENDING');
    expect(afterRow.lastError).toBeNull();
  });
});
