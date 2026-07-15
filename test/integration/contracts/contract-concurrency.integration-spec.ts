import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from '../setup/postgres-testcontainer';

// Onaylanan Faz 7 plani Bolum 12/20: saf pessimistic FOR UPDATE semantigi.
// (a) AYNI satira iki paralel aktivasyon: ikinci istek kilitte BEKLER,
//     commit sonrasi guncel satiri okur ve 409 CONTRACT_STATUS_UNCHANGED
//     alir - YAPAY CONCURRENT_MODIFICATION uretilmez (o kod Faz 7 hata
//     yuzeyinde yoktur).
// (b) FARKLI iki satirin cakisan paralel aktivasyonu: kilit serilestirmez,
//     nihai guvence gercek excl_contracts_active_overlap (23P01) ->
//     CONTRACT_OVERLAP.
// (c) Alan duzenlemesi + durum gecisi ayni satirda paralel: kilit
//     serilestirir, kayip guncelleme olmaz.
describe('Contract concurrency (gercek PostgreSQL, FOR UPDATE)', () => {
  let testDb: TestDatabase;
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contractService: any;
  let opsActor: { id: string; role: 'OPERATIONS'; sessionId: string; tokenVersion: number };

  beforeAll(async () => {
    testDb = await startTestDatabase();

    const { AppModule } = await import('../../../src/app.module');
    const { PrismaService } = await import(
      '../../../src/infrastructure/database/prisma/prisma.service'
    );
    const { ContractService } = await import(
      '../../../src/modules/contracts/services/contract.service'
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    contractService = app.get(ContractService);

    const ops = await prisma.user.create({
      data: { phoneNumber: '+905557772001', firstName: 'Ops', lastName: 'Conc', role: 'OPERATIONS' },
    });
    opsActor = { id: ops.id, role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 };
  }, 120000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(testDb);
  });

  let siteSeq = 0;
  async function createSite(): Promise<string> {
    siteSeq += 1;
    const site = await prisma.facility.create({
      data: { type: 'SITE', name: `Conc Site ${siteSeq}`, code: `CONC-${siteSeq}` },
    });
    return site.id;
  }

  function isoDaysFromToday(days: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
      .toISOString()
      .slice(0, 10);
  }

  async function createDraft(siteId: string, startOffset: number, endOffset: number) {
    return contractService.create(opsActor, {
      siteId,
      startDate: isoDaysFromToday(startOffset),
      endDate: isoDaysFromToday(endOffset),
      monthlyFee: '1000.00',
      billingDay: 1,
    });
  }

  it('(a) ayni DRAFT sozlesmeye iki paralel aktivasyon: biri basarili, digeri STATUS_UNCHANGED', async () => {
    const siteId = await createSite();
    const draft = await createDraft(siteId, -10, 100);

    const results = await Promise.allSettled([
      contractService.update(opsActor, draft.id, { status: 'ACTIVE' }),
      contractService.update(opsActor, draft.id, { status: 'ACTIVE' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Ikinci istek kilit sonrasi GUNCEL satiri okudu: hedef zaten mevcut
    // durum -> mesru is-kurali sonucu. Asla CONCURRENT_MODIFICATION degil.
    expect(rejected[0].reason).toMatchObject({ code: 'CONTRACT_STATUS_UNCHANGED' });
    expect(rejected[0].reason.code).not.toBe('CONCURRENT_MODIFICATION');

    const row = await prisma.contract.findUnique({ where: { id: draft.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('(b) ayni sitede cakisan iki farkli DRAFT paralel aktivasyon: biri basarili, digeri CONTRACT_OVERLAP', async () => {
    const siteId = await createSite();
    const draftA = await createDraft(siteId, -10, 100);
    const draftB = await createDraft(siteId, 20, 200); // cakisan pencere, DRAFT-DRAFT serbest.

    const results = await Promise.allSettled([
      contractService.update(opsActor, draftA.id, { status: 'ACTIVE' }),
      contractService.update(opsActor, draftB.id, { status: 'ACTIVE' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // On-kontrol yaris nedeniyle gecebilir; nihai guvence gercek EXCLUDE
    // constraint'tir - iki yol da ayni domain koduna esilenir.
    expect(rejected[0].reason).toMatchObject({ code: 'CONTRACT_OVERLAP' });

    const statuses = (
      await prisma.contract.findMany({ where: { id: { in: [draftA.id, draftB.id] } } })
    )
      .map((c: { status: string }) => c.status)
      .sort();
    expect(statuses).toEqual(['ACTIVE', 'DRAFT']);
  });

  it('(c) ayni satirda paralel alan duzenlemesi + durum gecisi: kilit serilestirir, kayip guncelleme olmaz', async () => {
    const siteId = await createSite();
    const draft = await createDraft(siteId, -10, 100);

    const results = await Promise.allSettled([
      contractService.update(opsActor, draft.id, { notes: 'paralel not' }),
      contractService.update(opsActor, draft.id, { status: 'ACTIVE' }),
    ]);

    // Iki islem farkli alanlara dokunur; kilit serilestirdigi icin ikisi de
    // basarili olur ve iki degisiklik de kalicidir.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const row = await prisma.contract.findUnique({ where: { id: draft.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.notes).toBe('paralel not');
  });
});
