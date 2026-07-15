import { Prisma } from '../../../generated/prisma-client/client';
import type { ContractStatus } from '../../../generated/prisma-client/enums';
import { ContractStateMachine } from '../state/contract-state-machine';
import { ContractService } from './contract.service';

// Onaylanan Faz 7 plani Bolum 19: birlesik PATCH'in 11 adimlik sirasi,
// alan mutability, kati EXPIRED siniri, fesih-fatura cakismasi, DB hata
// eslemeleri ve audit/outbox metadata guvenligi. Mock'lar duz nesnelerdir
// (TestingModule yok, facility.service.spec emsali). DB hata mock sekilleri
// spike'in gozlemledigi gercek sekillerin kopyasidir.
function driverAdapterError(code: string, message: string): unknown {
  return Object.assign(new Error(message), {
    name: 'DriverAdapterError',
    cause: { kind: 'postgres', code, originalCode: code, message, originalMessage: message },
  });
}

const OPS_ACTOR = { id: 'ops-1', role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;

const FUTURE_START = '2099-01-01';
const FUTURE_END = '2099-12-31';

function contractRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contract-1',
    siteId: 'site-1',
    contractNumber: 'CNT-2099-000001',
    startDate: new Date(`${FUTURE_START}T00:00:00Z`),
    endDate: new Date(`${FUTURE_END}T00:00:00Z`),
    monthlyFee: new Prisma.Decimal('1000.00'),
    currency: 'TRY',
    billingDay: 1,
    status: 'DRAFT' as ContractStatus,
    serviceScope: null,
    standardResponseTargetHours: 48,
    emergencyCoverage: false,
    notes: null,
    createdByUserId: 'ops-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    terminatedAt: null,
    terminationReason: null,
    ...overrides,
  };
}

function buildService() {
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: string) => Promise<unknown>) => fn('tx')),
  };
  const contractRepo = {
    nextNumber: jest.fn().mockResolvedValue('CNT-2099-000001'),
    create: jest
      .fn()
      .mockImplementation((_tx: unknown, input: Record<string, unknown>) =>
        Promise.resolve(contractRow({ ...input })),
      ),
    findById: jest.fn(),
    findByIdForUpdate: jest.fn(),
    hasActiveOverlap: jest.fn().mockResolvedValue(false),
    update: jest
      .fn()
      .mockImplementation((_tx: unknown, id: string, data: Record<string, unknown>) =>
        Promise.resolve(contractRow({ id, ...data })),
      ),
    countNonCancelledInvoicesBeyond: jest.fn().mockResolvedValue(0),
    list: jest.fn().mockResolvedValue([]),
  };
  const facilityRepo = {
    findAliveById: jest.fn().mockResolvedValue({ id: 'site-1', type: 'SITE', deletedAt: null }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { publishInTx: jest.fn().mockResolvedValue(undefined) };
  const stateMachine = new ContractStateMachine();
  const assertTransitionSpy = jest.spyOn(stateMachine, 'assertTransition');

  const service = new ContractService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contractRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facilityRepo as any,
    stateMachine,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outbox as any,
  );

  return { service, prisma, contractRepo, facilityRepo, audit, outbox, assertTransitionSpy };
}

function baseCreateDto(overrides: Record<string, unknown> = {}) {
  return {
    siteId: 'site-1',
    startDate: FUTURE_START,
    endDate: FUTURE_END,
    monthlyFee: '1000.00',
    billingDay: 1,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('ContractService.create', () => {
  it('mutlu yol: DRAFT olusturur, numara sequence ile uretilir, audit+outbox ayni tx icinde', async () => {
    const { service, contractRepo, audit, outbox } = buildService();

    const created = await service.create(OPS_ACTOR, baseCreateDto());

    expect(contractRepo.nextNumber).toHaveBeenCalledWith('tx');
    const createArg = contractRepo.create.mock.calls[0][1];
    expect(createArg.contractNumber).toBe('CNT-2099-000001');
    expect(createArg.monthlyFee).toBeInstanceOf(Prisma.Decimal);
    expect(createArg.createdByUserId).toBe('ops-1');
    // status create input'unda YOK - DB default'u DRAFT.
    expect('status' in createArg).toBe(false);
    expect(created.status).toBe('DRAFT');

    expect(audit.log).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ action: 'CONTRACT_CREATED', entityType: 'Contract' }),
    );
    expect(outbox.publishInTx).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ eventType: 'ContractCreated', aggregateType: 'Contract' }),
    );
  });

  it('site yoksa veya facility SITE degilse 404 SITE_NOT_FOUND', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);
    await expect(service.create(OPS_ACTOR, baseCreateDto())).rejects.toMatchObject({
      code: 'SITE_NOT_FOUND',
    });

    facilityRepo.findAliveById.mockResolvedValue({ id: 'x', type: 'BLOCK' });
    await expect(service.create(OPS_ACTOR, baseCreateDto())).rejects.toMatchObject({
      code: 'SITE_NOT_FOUND',
    });
  });

  it('endDate <= startDate ise 422 CONTRACT_INVALID_DATE_RANGE (DB cagrisi yok)', async () => {
    const { service, contractRepo } = buildService();
    await expect(
      service.create(OPS_ACTOR, baseCreateDto({ endDate: FUTURE_START })),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_DATE_RANGE' });
    await expect(
      service.create(OPS_ACTOR, baseCreateDto({ startDate: FUTURE_END, endDate: FUTURE_START })),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_DATE_RANGE' });
    expect(contractRepo.create).not.toHaveBeenCalled();
  });

  it('gecersiz takvim tarihi 422 VALIDATION_ERROR', async () => {
    const { service } = buildService();
    await expect(
      service.create(OPS_ACTOR, baseCreateDto({ startDate: '2099-02-30' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('ACTIVE/SUSPENDED cakismasi on-kontrolde yakalanir: 409 CONTRACT_OVERLAP (DRAFT-DRAFT serbest)', async () => {
    const { service, contractRepo } = buildService();
    contractRepo.hasActiveOverlap.mockResolvedValue(true);
    await expect(service.create(OPS_ACTOR, baseCreateDto())).rejects.toMatchObject({
      code: 'CONTRACT_OVERLAP',
    });
    expect(contractRepo.create).not.toHaveBeenCalled();
  });

  it('audit/outbox metadata serbest metin icermez (notes/serviceScope yok)', async () => {
    const { service, audit, outbox } = buildService();
    await service.create(
      OPS_ACTOR,
      baseCreateDto({ notes: 'GIZLI NOT', serviceScope: 'GIZLI KAPSAM' }),
    );

    const auditMeta = JSON.stringify(audit.log.mock.calls[0][1].metadata);
    const outboxPayload = JSON.stringify(outbox.publishInTx.mock.calls[0][1].payload);
    expect(auditMeta).not.toContain('GIZLI');
    expect(outboxPayload).not.toContain('GIZLI');
  });
});

describe('ContractService.update - birlesik PATCH sirasi', () => {
  it('sozlesme yoksa 404 CONTRACT_NOT_FOUND (adim 1)', async () => {
    const { service, contractRepo } = buildService();
    contractRepo.findByIdForUpdate.mockResolvedValue(null);
    await expect(service.update(OPS_ACTOR, 'yok', { notes: 'x' })).rejects.toMatchObject({
      code: 'CONTRACT_NOT_FOUND',
    });
  });

  it('bos govde 422 CONTRACT_UPDATE_EMPTY (adim 2)', async () => {
    const { service, contractRepo } = buildService();
    contractRepo.findByIdForUpdate.mockResolvedValue(contractRow());
    await expect(service.update(OPS_ACTOR, 'contract-1', {})).rejects.toMatchObject({
      code: 'CONTRACT_UPDATE_EMPTY',
    });
  });

  it('terminationReason, TERMINATED disi hedefle gonderilirse 422 VALIDATION_ERROR', async () => {
    const { service, contractRepo } = buildService();
    contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
    await expect(
      service.update(OPS_ACTOR, 'contract-1', { status: 'SUSPENDED', terminationReason: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.update(OPS_ACTOR, 'contract-1', { terminationReason: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  describe('adim 3: mevcut duruma gore mutable-field kontrolu', () => {
    it.each(['monthlyFee', 'billingDay', 'currency'] as const)(
      '%s alani DRAFT disinda 422 CONTRACT_IMMUTABLE_FIELD',
      async (field) => {
        const { service, contractRepo } = buildService();
        contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
        const dto =
          field === 'monthlyFee'
            ? { monthlyFee: '2000.00' }
            : field === 'billingDay'
              ? { billingDay: 5 }
              : { currency: 'USD' };
        await expect(service.update(OPS_ACTOR, 'contract-1', dto)).rejects.toMatchObject({
          code: 'CONTRACT_IMMUTABLE_FIELD',
          meta: expect.objectContaining({ field, reason: 'ONLY_DRAFT' }),
        });
      },
    );

    it('monthlyFee DRAFT durumunda serbestce degistirilebilir', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
      await service.update(OPS_ACTOR, 'contract-1', { monthlyFee: '2500.50' });
      const updateArg = contractRepo.update.mock.calls[0][2];
      expect(updateArg.monthlyFee).toBeInstanceOf(Prisma.Decimal);
      expect(updateArg.monthlyFee.toFixed(2)).toBe('2500.50');
    });

    it('endDate EXPIRED/TERMINATED durumda 422 CONTRACT_IMMUTABLE_FIELD (TERMINAL_STATUS)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(
        contractRow({
          status: 'TERMINATED',
          terminatedAt: new Date(),
          terminationReason: 'eski',
        }),
      );
      await expect(
        service.update(OPS_ACTOR, 'contract-1', { endDate: '2099-11-30' }),
      ).rejects.toMatchObject({
        code: 'CONTRACT_IMMUTABLE_FIELD',
        meta: expect.objectContaining({ field: 'endDate', reason: 'TERMINAL_STATUS' }),
      });
    });

    it('endDate ACTIVE durumda kisaltilamaz (SHORTENING_NOT_ALLOWED), uzatilabilir', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      await expect(
        service.update(OPS_ACTOR, 'contract-1', { endDate: '2099-06-30' }),
      ).rejects.toMatchObject({
        code: 'CONTRACT_IMMUTABLE_FIELD',
        meta: expect.objectContaining({ field: 'endDate', reason: 'SHORTENING_NOT_ALLOWED' }),
      });

      await service.update(OPS_ACTOR, 'contract-1', { endDate: '2100-06-30' });
      // Uzatmada overlap on-kontrolu FINAL tarihlerle ve kendisi haric calisir.
      expect(contractRepo.hasActiveOverlap).toHaveBeenCalledWith(
        'tx',
        'site-1',
        new Date(`${FUTURE_START}T00:00:00Z`),
        new Date('2100-06-30T00:00:00Z'),
        'contract-1',
      );
    });

    it('endDate DRAFT durumda geri yonde de degistirilebilir (ACTIVE/SUSPENDED on-kontrolluyle)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
      await service.update(OPS_ACTOR, 'contract-1', { endDate: '2099-06-30' });
      expect(contractRepo.hasActiveOverlap).toHaveBeenCalled();
      expect(contractRepo.update).toHaveBeenCalled();
    });
  });

  it('adim 5: final endDate <= startDate ise 422 CONTRACT_INVALID_DATE_RANGE', async () => {
    const { service, contractRepo } = buildService();
    contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
    await expect(
      service.update(OPS_ACTOR, 'contract-1', { endDate: FUTURE_START }),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_DATE_RANGE' });
  });

  describe('adim 6: state machine yalniz dto.status saglanmissa calisir', () => {
    it('saf alan duzenlemesinde state machine HIC cagrilmaz', async () => {
      const { service, contractRepo, assertTransitionSpy } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      await service.update(OPS_ACTOR, 'contract-1', { notes: 'yeni not' });
      expect(assertTransitionSpy).not.toHaveBeenCalled();
    });

    it('ayni status hedefi 409 CONTRACT_STATUS_UNCHANGED', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      await expect(
        service.update(OPS_ACTOR, 'contract-1', { status: 'ACTIVE' }),
      ).rejects.toMatchObject({ code: 'CONTRACT_STATUS_UNCHANGED' });
    });

    it('guard FINAL endDate uzerinden calisir: gecmis endDate + ayni istekte ileri endDate ile aktivasyon IZINLI', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(
        contractRow({
          status: 'DRAFT',
          startDate: new Date('2020-01-01T00:00:00Z'),
          endDate: new Date('2020-12-31T00:00:00Z'),
        }),
      );
      // Mevcut endDate gecmiste ama dto ile uzatiliyor -> final deger gecerli.
      await service.update(OPS_ACTOR, 'contract-1', { endDate: '2099-12-31', status: 'ACTIVE' });
      expect(contractRepo.update).toHaveBeenCalled();
    });

    it('guard FINAL endDate uzerinden calisir: gecmis final endDate ile aktivasyon REDDEDILIR', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(
        contractRow({
          status: 'DRAFT',
          startDate: new Date('2020-01-01T00:00:00Z'),
          endDate: new Date('2020-12-31T00:00:00Z'),
        }),
      );
      await expect(
        service.update(OPS_ACTOR, 'contract-1', { status: 'ACTIVE' }),
      ).rejects.toMatchObject({
        code: 'CONTRACT_INVALID_STATUS_TRANSITION',
        meta: expect.objectContaining({ reason: 'END_DATE_ALREADY_PASSED' }),
      });
    });

    it('KATI EXPIRED siniri: endDate bugunse RED, gecmisse izinli', async () => {
      const { service, contractRepo } = buildService();
      const todayStr = new Date().toISOString().slice(0, 10);
      contractRepo.findByIdForUpdate.mockResolvedValue(
        contractRow({
          status: 'ACTIVE',
          startDate: new Date('2020-01-01T00:00:00Z'),
          endDate: new Date(`${todayStr}T00:00:00Z`),
        }),
      );
      await expect(
        service.update(OPS_ACTOR, 'contract-1', { status: 'EXPIRED' }),
      ).rejects.toMatchObject({
        code: 'CONTRACT_INVALID_STATUS_TRANSITION',
        meta: expect.objectContaining({ reason: 'END_DATE_NOT_YET_REACHED' }),
      });

      contractRepo.findByIdForUpdate.mockResolvedValue(
        contractRow({
          status: 'ACTIVE',
          startDate: new Date('2020-01-01T00:00:00Z'),
          endDate: new Date('2020-12-31T00:00:00Z'),
        }),
      );
      await service.update(OPS_ACTOR, 'contract-1', { status: 'EXPIRED' });
      expect(contractRepo.update).toHaveBeenCalled();
    });
  });

  describe('adim 7: TERMINATED hedefinde fatura cakisma on-kontrolu', () => {
    it('pencereyi asan non-CANCELLED fatura varsa 409 CONTRACT_TERMINATION_INVOICE_CONFLICT (PAID dahil)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      contractRepo.countNonCancelledInvoicesBeyond.mockResolvedValue(2);
      await expect(
        service.update(OPS_ACTOR, 'contract-1', {
          status: 'TERMINATED',
          terminationReason: 'ihlal',
        }),
      ).rejects.toMatchObject({
        code: 'CONTRACT_TERMINATION_INVOICE_CONFLICT',
        meta: expect.objectContaining({ conflictingInvoices: 2 }),
      });
      expect(contractRepo.update).not.toHaveBeenCalled();
    });

    it('pencere ust siniri LEAST formuluyle hesaplanir (bugun < endDate -> bugun+1)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      await service.update(OPS_ACTOR, 'contract-1', {
        status: 'TERMINATED',
        terminationReason: 'ihlal',
      });
      const windowArg = contractRepo.countNonCancelledInvoicesBeyond.mock.calls[0][2] as Date;
      const expected = new Date();
      const expectedDate = new Date(
        Date.UTC(expected.getUTCFullYear(), expected.getUTCMonth(), expected.getUTCDate() + 1),
      );
      expect(windowArg.toISOString()).toBe(expectedDate.toISOString());
    });

    it('DRAFT->TERMINATED fatura kontrolu yapmadan gecebilir (DRAFT contracta fatura olamaz) ama terminatedAt yine server-set', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
      const before = Date.now();
      await service.update(OPS_ACTOR, 'contract-1', {
        status: 'TERMINATED',
        terminationReason: '  iptal karari  ',
      });
      const updateArg = contractRepo.update.mock.calls[0][2];
      expect(updateArg.status).toBe('TERMINATED');
      expect(updateArg.terminatedAt).toBeInstanceOf(Date);
      expect((updateArg.terminatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      // trim edilmis olarak yazilir.
      expect(updateArg.terminationReason).toBe('iptal karari');
    });
  });

  describe('adim 10: DB constraint hata eslemesi (spike sekilleriyle)', () => {
    it('23P01 excl_contracts_active_overlap -> 409 CONTRACT_OVERLAP (capraz-satir yarisi backstop)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
      contractRepo.update.mockRejectedValue(
        driverAdapterError(
          '23P01',
          'conflicting key value violates exclusion constraint "excl_contracts_active_overlap"',
        ),
      );
      await expect(
        service.update(OPS_ACTOR, 'contract-1', { status: 'ACTIVE' }),
      ).rejects.toMatchObject({ code: 'CONTRACT_OVERLAP' });
    });

    it('P0001 chk_contract_termination_invoice_conflict -> 409 (trigger backstop)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      contractRepo.update.mockRejectedValue(
        driverAdapterError(
          'P0001',
          'chk_contract_termination_invoice_conflict: contract x termination conflicts with 1 existing invoice(s) beyond window y',
        ),
      );
      await expect(
        service.update(OPS_ACTOR, 'contract-1', {
          status: 'TERMINATED',
          terminationReason: 'ihlal',
        }),
      ).rejects.toMatchObject({ code: 'CONTRACT_TERMINATION_INVOICE_CONFLICT' });
    });

    it('23514 chk_contract_termination_consistency -> 422 CONTRACT_TERMINATION_DETAILS_REQUIRED', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      contractRepo.update.mockRejectedValue(
        driverAdapterError(
          '23514',
          'new row for relation "contracts" violates check constraint "chk_contract_termination_consistency"',
        ),
      );
      await expect(
        service.update(OPS_ACTOR, 'contract-1', {
          status: 'TERMINATED',
          terminationReason: 'ihlal',
        }),
      ).rejects.toMatchObject({ code: 'CONTRACT_TERMINATION_DETAILS_REQUIRED' });
    });

    it('taninmayan hata oldugu gibi yeniden firlatilir (yanlis eslesme yok)', async () => {
      const { service, contractRepo } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
      const boom = new Error('baglanti koptu');
      contractRepo.update.mockRejectedValue(boom);
      await expect(service.update(OPS_ACTOR, 'contract-1', { notes: 'x' })).rejects.toBe(boom);
    });
  });

  describe('adim 11: gecis-ozel TEK audit/outbox kaydi', () => {
    it('birlesik alan+durum istegi tek audit (gecis action) + fieldsChanged uretir', async () => {
      const { service, contractRepo, audit, outbox } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'DRAFT' }));
      await service.update(OPS_ACTOR, 'contract-1', { endDate: '2100-01-15', status: 'ACTIVE' });

      expect(audit.log).toHaveBeenCalledTimes(1);
      const entry = audit.log.mock.calls[0][1];
      expect(entry.action).toBe('CONTRACT_ACTIVATED');
      expect(entry.metadata.fieldsChanged).toEqual(['endDate']);
      expect(entry.metadata.fromStatus).toBe('DRAFT');
      expect(entry.metadata.toStatus).toBe('ACTIVE');

      expect(outbox.publishInTx).toHaveBeenCalledTimes(1);
      expect(outbox.publishInTx.mock.calls[0][1].eventType).toBe('ContractActivated');
    });

    it.each([
      ['SUSPENDED', 'ACTIVE', 'CONTRACT_SUSPENDED', 'ContractSuspended'],
      ['ACTIVE', 'SUSPENDED', 'CONTRACT_ACTIVATED', 'ContractActivated'],
    ] as const)(
      'hedef %s gecisi dogru adlari kullanir',
      async (target, currentStatus, expectedAction, expectedEvent) => {
        const { service, contractRepo, audit, outbox } = buildService();
        contractRepo.findByIdForUpdate.mockResolvedValue(
          contractRow({ status: currentStatus as ContractStatus }),
        );
        await service.update(OPS_ACTOR, 'contract-1', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: target as any,
        });
        expect(audit.log.mock.calls[0][1].action).toBe(expectedAction);
        expect(outbox.publishInTx.mock.calls[0][1].eventType).toBe(expectedEvent);
      },
    );

    it('saf alan duzenlemesi CONTRACT_UPDATED + ContractUpdated uretir', async () => {
      const { service, contractRepo, audit, outbox } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      await service.update(OPS_ACTOR, 'contract-1', { notes: 'operasyonel not' });
      expect(audit.log.mock.calls[0][1].action).toBe('CONTRACT_UPDATED');
      expect(outbox.publishInTx.mock.calls[0][1].eventType).toBe('ContractUpdated');
    });

    it('TERMINATED metadata guvenligi: terminationReason DEGERI yazilmaz, yalniz reasonProvided', async () => {
      const { service, contractRepo, audit, outbox } = buildService();
      contractRepo.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'ACTIVE' }));
      await service.update(OPS_ACTOR, 'contract-1', {
        status: 'TERMINATED',
        terminationReason: 'COK GIZLI FESIH GEREKCESI',
      });

      const auditEntry = audit.log.mock.calls[0][1];
      expect(auditEntry.action).toBe('CONTRACT_TERMINATED');
      expect(auditEntry.metadata.reasonProvided).toBe(true);
      expect(JSON.stringify(auditEntry.metadata)).not.toContain('GIZLI');
      expect(JSON.stringify(outbox.publishInTx.mock.calls[0][1].payload)).not.toContain('GIZLI');
    });
  });
});

describe('ContractService.listForSite', () => {
  it('site yoksa 404 SITE_NOT_FOUND', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);
    await expect(service.listForSite(OPS_ACTOR, 'yok', {})).rejects.toMatchObject({
      code: 'SITE_NOT_FOUND',
    });
  });

  it('gecersiz cursor 422 VALIDATION_ERROR', async () => {
    const { service } = buildService();
    await expect(
      service.listForSite(OPS_ACTOR, 'site-1', { cursor: '!!!gecersiz' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('limit+1 satirdan sayfa kurar, status filtresini repository filtresine tasir', async () => {
    const { service, contractRepo } = buildService();
    const rows = Array.from({ length: 3 }, (_, i) =>
      contractRow({ id: `c-${i}`, createdAt: new Date(Date.now() - i * 1000) }),
    );
    contractRepo.list.mockResolvedValue(rows);

    const page = await service.listForSite(OPS_ACTOR, 'site-1', { limit: 2, status: 'ACTIVE' });

    expect(contractRepo.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: 'site-1', status: 'ACTIVE', limit: 2 }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});
