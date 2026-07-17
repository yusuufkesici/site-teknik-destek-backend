import { addUtcDays, utcToday } from '../../../common/utils/billable-window.util';
import { Prisma } from '../../../generated/prisma-client/client';
import type { ContractStatus, InvoiceStatus } from '../../../generated/prisma-client/enums';
import { InvoiceStateMachine } from '../state/invoice-state-machine';
import { InvoiceService } from './invoice.service';

// Onaylanan Faz 7 plani Bolum 19: billability matrisi (LEAST her iki dali),
// donem/vade dogrulamalari, currency server-copy, odeme alani kurallari,
// DB hata eslemeleri ve audit/outbox metadata guvenligi. DB hata mock
// sekilleri spike'in gozlemledigi gercek sekillerin kopyasidir.
function driverAdapterError(code: string, message: string): unknown {
  return Object.assign(new Error(message), {
    name: 'DriverAdapterError',
    cause: { kind: 'postgres', code, originalCode: code, message, originalMessage: message },
  });
}

function p2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: '7.8.0',
    meta: {
      modelName: 'ContractInvoice',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "uq_contract_invoices_period_start_open"',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'uq_contract_invoices_period_start_open' },
        },
      },
    },
  });
}

const OPS_ACTOR = { id: 'ops-1', role: 'OPERATIONS', sessionId: 's', tokenVersion: 0 } as const;

function contractRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contract-1',
    siteId: 'site-1',
    contractNumber: 'CNT-2026-000001',
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: new Date('2026-12-31T00:00:00Z'),
    monthlyFee: new Prisma.Decimal('1000.00'),
    currency: 'TRY',
    billingDay: 1,
    status: 'ACTIVE' as ContractStatus,
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

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invoice-1',
    contractId: 'contract-1',
    invoiceNumber: 'INV-2026-000001',
    billingPeriodStart: new Date('2026-01-01T00:00:00Z'),
    billingPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    issueDate: new Date('2026-01-01T00:00:00Z'),
    dueDate: new Date('2026-01-15T00:00:00Z'),
    amount: new Prisma.Decimal('1000.00'),
    currency: 'TRY',
    status: 'DRAFT' as InvoiceStatus,
    paidAt: null,
    paymentMethod: null,
    referenceNumber: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService() {
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: string) => Promise<unknown>) => fn('tx')),
  };
  const invoiceRepo = {
    nextNumber: jest.fn().mockResolvedValue('INV-2026-000001'),
    create: jest
      .fn()
      .mockImplementation((_tx: unknown, input: Record<string, unknown>) =>
        Promise.resolve(invoiceRow({ ...input })),
      ),
    findById: jest.fn(),
    findByIdForUpdate: jest.fn(),
    hasOverlappingPeriod: jest.fn().mockResolvedValue(false),
    updateStatus: jest
      .fn()
      .mockImplementation((_tx: unknown, id: string, input: Record<string, unknown>) =>
        Promise.resolve(invoiceRow({ id, ...input })),
      ),
    list: jest.fn().mockResolvedValue([]),
  };
  const contractLookup = {
    findByIdForUpdate: jest.fn().mockResolvedValue(contractRow()),
    findById: jest.fn().mockResolvedValue(contractRow()),
  };
  const facilityRepo = {
    findAliveById: jest.fn().mockResolvedValue({ id: 'site-1', type: 'SITE', deletedAt: null }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { publishInTx: jest.fn().mockResolvedValue(undefined) };
  const stateMachine = new InvoiceStateMachine();

  const service = new InvoiceService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoiceRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contractLookup as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facilityRepo as any,
    stateMachine,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outbox as any,
  );

  return { service, prisma, invoiceRepo, contractLookup, facilityRepo, audit, outbox };
}

function baseCreateDto(overrides: Record<string, unknown> = {}) {
  return {
    billingPeriodStart: '2026-03-01',
    billingPeriodEnd: '2026-04-01',
    issueDate: '2026-03-01',
    dueDate: '2026-03-15',
    amount: '1500.00',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('InvoiceService.create', () => {
  it('mutlu yol: DRAFT olusturur, numara sequence ile, currency KILITLI contracttan kopyalanir', async () => {
    const { service, invoiceRepo, contractLookup } = buildService();
    contractLookup.findByIdForUpdate.mockResolvedValue(contractRow({ currency: 'USD' }));

    await service.create(OPS_ACTOR, 'contract-1', baseCreateDto());

    expect(contractLookup.findByIdForUpdate).toHaveBeenCalledWith('tx', 'contract-1');
    const createArg = invoiceRepo.create.mock.calls[0][1];
    expect(createArg.invoiceNumber).toBe('INV-2026-000001');
    expect(createArg.currency).toBe('USD'); // client girdisi degil, contract snapshot'i.
    expect(createArg.amount).toBeInstanceOf(Prisma.Decimal);
    expect('status' in createArg).toBe(false); // DB default'u DRAFT.
  });

  it('billingPeriodEnd <= billingPeriodStart ise 422 INVOICE_INVALID_PERIOD (DB cagrisi yok)', async () => {
    const { service, contractLookup } = buildService();
    await expect(
      service.create(OPS_ACTOR, 'contract-1', baseCreateDto({ billingPeriodEnd: '2026-03-01' })),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_PERIOD' });
    expect(contractLookup.findByIdForUpdate).not.toHaveBeenCalled();
  });

  it('dueDate < issueDate ise 422 INVOICE_INVALID_DUE_DATE', async () => {
    const { service } = buildService();
    await expect(
      service.create(OPS_ACTOR, 'contract-1', baseCreateDto({ dueDate: '2026-02-28' })),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_DUE_DATE' });
  });

  it('dueDate === issueDate izinlidir', async () => {
    const { service, invoiceRepo } = buildService();
    await service.create(OPS_ACTOR, 'contract-1', baseCreateDto({ dueDate: '2026-03-01' }));
    expect(invoiceRepo.create).toHaveBeenCalled();
  });

  it('sozlesme yoksa 404 CONTRACT_NOT_FOUND', async () => {
    const { service, contractLookup } = buildService();
    contractLookup.findByIdForUpdate.mockResolvedValue(null);
    await expect(service.create(OPS_ACTOR, 'yok', baseCreateDto())).rejects.toMatchObject({
      code: 'CONTRACT_NOT_FOUND',
    });
  });

  describe('billability matrisi (plan Bolum 4.4)', () => {
    it.each(['DRAFT', 'SUSPENDED'] as const)(
      '%s sozlesmeye fatura olusturulamaz: 422 INVOICE_CONTRACT_NOT_BILLABLE',
      async (status) => {
        const { service, contractLookup, invoiceRepo } = buildService();
        contractLookup.findByIdForUpdate.mockResolvedValue(contractRow({ status }));
        await expect(
          service.create(OPS_ACTOR, 'contract-1', baseCreateDto()),
        ).rejects.toMatchObject({
          code: 'INVOICE_CONTRACT_NOT_BILLABLE',
          meta: expect.objectContaining({ contractStatus: status }),
        });
        expect(invoiceRepo.create).not.toHaveBeenCalled();
      },
    );

    it('ACTIVE: tam-ay sinir faturasi (periodEnd = endDate + 1 gun) IZINLIDIR', async () => {
      const { service, invoiceRepo } = buildService();
      await service.create(
        OPS_ACTOR,
        'contract-1',
        baseCreateDto({
          billingPeriodStart: '2026-12-01',
          billingPeriodEnd: '2027-01-01',
          issueDate: '2026-12-01',
          dueDate: '2026-12-15',
        }),
      );
      expect(invoiceRepo.create).toHaveBeenCalled();
    });

    it('ACTIVE: periodEnd = endDate + 2 gun ise 422 INVOICE_PERIOD_OUT_OF_CONTRACT', async () => {
      const { service } = buildService();
      await expect(
        service.create(
          OPS_ACTOR,
          'contract-1',
          baseCreateDto({
            billingPeriodStart: '2026-12-01',
            billingPeriodEnd: '2027-01-02',
            issueDate: '2026-12-01',
            dueDate: '2026-12-15',
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
    });

    it('periodStart < contract.startDate ise 422 INVOICE_PERIOD_OUT_OF_CONTRACT', async () => {
      const { service } = buildService();
      await expect(
        service.create(
          OPS_ACTOR,
          'contract-1',
          baseCreateDto({ billingPeriodStart: '2025-12-01', billingPeriodEnd: '2026-02-01' }),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
    });

    it('EXPIRED: donem icinde kalan gecmise donuk fatura IZINLIDIR', async () => {
      const { service, contractLookup, invoiceRepo } = buildService();
      contractLookup.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'EXPIRED' }));
      await service.create(OPS_ACTOR, 'contract-1', baseCreateDto());
      expect(invoiceRepo.create).toHaveBeenCalled();
    });

    it('TERMINATED (terminatedAt < endDate): pencere UTC_DATE(terminatedAt)+1 ile sinirlanir', async () => {
      const { service, contractLookup, invoiceRepo } = buildService();
      contractLookup.findByIdForUpdate.mockResolvedValue(
        contractRow({ status: 'TERMINATED', terminatedAt: new Date('2026-06-15T10:00:00Z') }),
      );

      // Pencere ici: [2026-06-01, 2026-06-16) -> izinli.
      await service.create(
        OPS_ACTOR,
        'contract-1',
        baseCreateDto({
          billingPeriodStart: '2026-06-01',
          billingPeriodEnd: '2026-06-16',
          issueDate: '2026-06-01',
          dueDate: '2026-06-20',
        }),
      );
      expect(invoiceRepo.create).toHaveBeenCalled();

      // Pencere disi: bitis 2026-06-17 > 2026-06-16 -> reddedilir.
      await expect(
        service.create(
          OPS_ACTOR,
          'contract-1',
          baseCreateDto({
            billingPeriodStart: '2026-06-01',
            billingPeriodEnd: '2026-06-17',
            issueDate: '2026-06-01',
            dueDate: '2026-06-20',
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
    });

    it('TERMINATED (terminatedAt > endDate): LEAST endDate dalini secer, pencere endDate+1 kalir', async () => {
      const { service, contractLookup, invoiceRepo } = buildService();
      contractLookup.findByIdForUpdate.mockResolvedValue(
        contractRow({ status: 'TERMINATED', terminatedAt: new Date('2027-03-10T08:00:00Z') }),
      );

      // endDate+1 = 2027-01-01 sinirinda tam-ay faturasi izinli.
      await service.create(
        OPS_ACTOR,
        'contract-1',
        baseCreateDto({
          billingPeriodStart: '2026-12-01',
          billingPeriodEnd: '2027-01-01',
          issueDate: '2026-12-01',
          dueDate: '2026-12-15',
        }),
      );
      expect(invoiceRepo.create).toHaveBeenCalled();

      // terminatedAt gecikmis olsa bile dogal endDate siniri ASILAMAZ.
      await expect(
        service.create(
          OPS_ACTOR,
          'contract-1',
          baseCreateDto({
            billingPeriodStart: '2026-12-01',
            billingPeriodEnd: '2027-01-02',
            issueDate: '2026-12-01',
            dueDate: '2026-12-15',
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_PERIOD_OUT_OF_CONTRACT' });
    });
  });

  it('cakisan non-CANCELLED donem on-kontrolde yakalanir: 409 INVOICE_PERIOD_OVERLAP', async () => {
    const { service, invoiceRepo } = buildService();
    invoiceRepo.hasOverlappingPeriod.mockResolvedValue(true);
    await expect(service.create(OPS_ACTOR, 'contract-1', baseCreateDto())).rejects.toMatchObject({
      code: 'INVOICE_PERIOD_OVERLAP',
    });
    expect(invoiceRepo.create).not.toHaveBeenCalled();
  });

  it('iptal+yeniden olusturma icin serviste yapay engel yok (CANCELLED on-kontrol sorgusunun disindadir)', async () => {
    const { service, invoiceRepo } = buildService();
    // CANCELLED fatura ayni donemde dursa da hasOverlappingPeriod sorgusu
    // (status <> CANCELLED) false doner -> olusturma normal ilerler.
    invoiceRepo.hasOverlappingPeriod.mockResolvedValue(false);
    await service.create(OPS_ACTOR, 'contract-1', baseCreateDto());
    expect(invoiceRepo.create).toHaveBeenCalled();
  });

  describe('DB hata eslemeleri (spike sekilleriyle)', () => {
    async function expectCreateMapped(thrown: unknown, expectedCode: string) {
      const { service, invoiceRepo } = buildService();
      invoiceRepo.create.mockRejectedValue(thrown);
      await expect(service.create(OPS_ACTOR, 'contract-1', baseCreateDto())).rejects.toMatchObject({
        code: expectedCode,
      });
    }

    it('23P01 excl_invoice_period_overlap -> INVOICE_PERIOD_OVERLAP', async () => {
      await expectCreateMapped(
        driverAdapterError(
          '23P01',
          'conflicting key value violates exclusion constraint "excl_invoice_period_overlap"',
        ),
        'INVOICE_PERIOD_OVERLAP',
      );
    });

    it('partial unique P2002 -> INVOICE_PERIOD_OVERLAP', async () => {
      await expectCreateMapped(p2002Error(), 'INVOICE_PERIOD_OVERLAP');
    });

    it('P0001 chk_invoice_contract_exists -> CONTRACT_NOT_FOUND', async () => {
      await expectCreateMapped(
        driverAdapterError('P0001', 'chk_invoice_contract_exists: contract x not found'),
        'CONTRACT_NOT_FOUND',
      );
    });

    it('P0001 chk_invoice_contract_not_billable -> INVOICE_CONTRACT_NOT_BILLABLE', async () => {
      await expectCreateMapped(
        driverAdapterError(
          'P0001',
          'chk_invoice_contract_not_billable: contract x is not billable in status DRAFT',
        ),
        'INVOICE_CONTRACT_NOT_BILLABLE',
      );
    });

    it('P0001 chk_invoice_period_within_contract -> INVOICE_PERIOD_OUT_OF_CONTRACT', async () => {
      await expectCreateMapped(
        driverAdapterError(
          'P0001',
          'chk_invoice_period_within_contract: invoice period outside window',
        ),
        'INVOICE_PERIOD_OUT_OF_CONTRACT',
      );
    });

    it('P0001 chk_invoice_currency_match -> INVOICE_CURRENCY_MISMATCH', async () => {
      await expectCreateMapped(
        driverAdapterError(
          'P0001',
          'chk_invoice_currency_match: invoice currency USD does not match',
        ),
        'INVOICE_CURRENCY_MISMATCH',
      );
    });

    it('23514 chk_invoice_due_after_issue -> INVOICE_INVALID_DUE_DATE', async () => {
      await expectCreateMapped(
        driverAdapterError(
          '23514',
          'new row for relation "contract_invoices" violates check constraint "chk_invoice_due_after_issue"',
        ),
        'INVOICE_INVALID_DUE_DATE',
      );
    });

    it('taninmayan hata oldugu gibi yeniden firlatilir', async () => {
      const { service, invoiceRepo } = buildService();
      const boom = new Error('baglanti koptu');
      invoiceRepo.create.mockRejectedValue(boom);
      await expect(service.create(OPS_ACTOR, 'contract-1', baseCreateDto())).rejects.toBe(boom);
    });
  });

  it('audit INVOICE_CREATED contractStatusAtCreation icerir; outbox InvoiceCreated; note metni sizmaz', async () => {
    const { service, contractLookup, audit, outbox } = buildService();
    contractLookup.findByIdForUpdate.mockResolvedValue(contractRow({ status: 'EXPIRED' }));

    await service.create(OPS_ACTOR, 'contract-1', baseCreateDto({ note: 'GIZLI FATURA NOTU' }));

    const auditEntry = audit.log.mock.calls[0][1];
    expect(auditEntry.action).toBe('INVOICE_CREATED');
    expect(auditEntry.entityType).toBe('ContractInvoice');
    expect(auditEntry.siteId).toBe('site-1');
    expect(auditEntry.metadata.contractStatusAtCreation).toBe('EXPIRED');
    expect(JSON.stringify(auditEntry.metadata)).not.toContain('GIZLI');

    const outboxEntry = outbox.publishInTx.mock.calls[0][1];
    expect(outboxEntry.eventType).toBe('InvoiceCreated');
    expect(JSON.stringify(outboxEntry.payload)).not.toContain('GIZLI');
  });
});

describe('InvoiceService.changeStatus', () => {
  it('odeme alanlari PAID disi hedefle gonderilirse 422 VALIDATION_ERROR (transaction acilmadan)', async () => {
    const { service, prisma } = buildService();
    await expect(
      service.changeStatus(OPS_ACTOR, 'invoice-1', {
        status: 'ISSUED',
        paymentMethod: 'CASH',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.changeStatus(OPS_ACTOR, 'invoice-1', {
        status: 'CANCELLED',
        referenceNumber: 'REF-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fatura yoksa 404 INVOICE_NOT_FOUND', async () => {
    const { service, invoiceRepo } = buildService();
    invoiceRepo.findByIdForUpdate.mockResolvedValue(null);
    await expect(
      service.changeStatus(OPS_ACTOR, 'yok', { status: 'ISSUED' }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('state machine kilitli guncel satir uzerinden calisir: ISSUED->OVERDUE reddi (manuel OVERDUE yasak)', async () => {
    const { service, invoiceRepo } = buildService();
    invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
    await expect(
      service.changeStatus(OPS_ACTOR, 'invoice-1', { status: 'OVERDUE' }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_STATUS_TRANSITION' });
  });

  it('ayni durum hedefi 409 INVOICE_STATUS_UNCHANGED', async () => {
    const { service, invoiceRepo } = buildService();
    invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
    await expect(
      service.changeStatus(OPS_ACTOR, 'invoice-1', { status: 'ISSUED' }),
    ).rejects.toMatchObject({ code: 'INVOICE_STATUS_UNCHANGED' });
  });

  describe('PAID odeme kurallari (plan Bolum 4.5)', () => {
    it('paymentMethod eksikse 422 INVOICE_PAYMENT_DETAILS_REQUIRED', async () => {
      const { service, invoiceRepo } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
      await expect(
        service.changeStatus(OPS_ACTOR, 'invoice-1', { status: 'PAID' }),
      ).rejects.toMatchObject({ code: 'INVOICE_PAYMENT_DETAILS_REQUIRED' });
    });

    it('BANK_TRANSFER + eksik/whitespace referenceNumber 422 INVOICE_PAYMENT_DETAILS_REQUIRED', async () => {
      const { service, invoiceRepo } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
      await expect(
        service.changeStatus(OPS_ACTOR, 'invoice-1', {
          status: 'PAID',
          paymentMethod: 'BANK_TRANSFER',
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_PAYMENT_DETAILS_REQUIRED' });
      await expect(
        service.changeStatus(OPS_ACTOR, 'invoice-1', {
          status: 'PAID',
          paymentMethod: 'BANK_TRANSFER',
          referenceNumber: '   ',
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_PAYMENT_DETAILS_REQUIRED' });
    });

    it('BANK_TRANSFER + referans: paidAt server-set, referans trim edilir', async () => {
      const { service, invoiceRepo } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
      const before = Date.now();

      await service.changeStatus(OPS_ACTOR, 'invoice-1', {
        status: 'PAID',
        paymentMethod: 'BANK_TRANSFER',
        referenceNumber: '  TR-REF-42  ',
      });

      const updateArg = invoiceRepo.updateStatus.mock.calls[0][2];
      expect(updateArg.status).toBe('PAID');
      expect(updateArg.paymentMethod).toBe('BANK_TRANSFER');
      expect(updateArg.referenceNumber).toBe('TR-REF-42');
      expect(updateArg.paidAt).toBeInstanceOf(Date);
      expect((updateArg.paidAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('CASH icin referenceNumber olmadan PAID izinlidir', async () => {
      const { service, invoiceRepo } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
      await service.changeStatus(OPS_ACTOR, 'invoice-1', {
        status: 'PAID',
        paymentMethod: 'CASH',
      });
      const updateArg = invoiceRepo.updateStatus.mock.calls[0][2];
      expect(updateArg.referenceNumber).toBeUndefined();
    });

    it('23514 chk_invoice_payment_consistency backstop -> INVOICE_PAYMENT_DETAILS_REQUIRED', async () => {
      const { service, invoiceRepo } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));
      invoiceRepo.updateStatus.mockRejectedValue(
        driverAdapterError(
          '23514',
          'new row for relation "contract_invoices" violates check constraint "chk_invoice_payment_consistency"',
        ),
      );
      await expect(
        service.changeStatus(OPS_ACTOR, 'invoice-1', {
          status: 'PAID',
          paymentMethod: 'CASH',
        }),
      ).rejects.toMatchObject({ code: 'INVOICE_PAYMENT_DETAILS_REQUIRED' });
    });
  });

  describe('gecis-ozel audit/outbox adlari', () => {
    it('DRAFT->ISSUED: INVOICE_ISSUED + InvoiceIssued', async () => {
      const { service, invoiceRepo, audit, outbox } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'DRAFT' }));
      await service.changeStatus(OPS_ACTOR, 'invoice-1', { status: 'ISSUED' });
      expect(audit.log.mock.calls[0][1].action).toBe('INVOICE_ISSUED');
      expect(outbox.publishInTx.mock.calls[0][1].eventType).toBe('InvoiceIssued');
    });

    it('DRAFT->CANCELLED: INVOICE_CANCELLED + InvoiceCancelled', async () => {
      const { service, invoiceRepo, audit, outbox } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'DRAFT' }));
      await service.changeStatus(OPS_ACTOR, 'invoice-1', { status: 'CANCELLED' });
      expect(audit.log.mock.calls[0][1].action).toBe('INVOICE_CANCELLED');
      expect(outbox.publishInTx.mock.calls[0][1].eventType).toBe('InvoiceCancelled');
    });

    it('ISSUED->PAID: INVOICE_PAID; metadata referans DEGERI icermez, hasReferenceNumber boolean icerir', async () => {
      const { service, invoiceRepo, audit, outbox } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'ISSUED' }));

      await service.changeStatus(OPS_ACTOR, 'invoice-1', {
        status: 'PAID',
        paymentMethod: 'BANK_TRANSFER',
        referenceNumber: 'COKGIZLIREFERANS-99',
      });

      const auditEntry = audit.log.mock.calls[0][1];
      expect(auditEntry.action).toBe('INVOICE_PAID');
      expect(auditEntry.metadata.paymentMethod).toBe('BANK_TRANSFER');
      expect(auditEntry.metadata.hasReferenceNumber).toBe(true);
      expect(JSON.stringify(auditEntry.metadata)).not.toContain('COKGIZLIREFERANS');

      const outboxEntry = outbox.publishInTx.mock.calls[0][1];
      expect(outboxEntry.eventType).toBe('InvoicePaid');
      expect(outboxEntry.payload.amount).toBe('1000.00');
      expect(JSON.stringify(outboxEntry.payload)).not.toContain('COKGIZLIREFERANS');
    });

    it('audit siteId contract.siteId uzerinden turetilir (invoice satirinda siteId yok)', async () => {
      const { service, invoiceRepo, contractLookup, audit } = buildService();
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status: 'DRAFT' }));
      await service.changeStatus(OPS_ACTOR, 'invoice-1', { status: 'ISSUED' });
      expect(contractLookup.findById).toHaveBeenCalledWith('tx', 'contract-1');
      expect(audit.log.mock.calls[0][1].siteId).toBe('site-1');
    });
  });
});

describe('InvoiceService.markOverdueBySystem', () => {
  it('ISSUED + dueDate gecmis: OVERDUE yapar, audit+outbox ayni transaction icinde yazilir', async () => {
    const { service, invoiceRepo, prisma, audit, outbox } = buildService();
    const pastDue = addUtcDays(utcToday(), -1);
    invoiceRepo.findByIdForUpdate.mockResolvedValue(
      invoiceRow({ status: 'ISSUED', dueDate: pastDue }),
    );

    const result = await service.markOverdueBySystem('invoice-1', 'site-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(invoiceRepo.updateStatus).toHaveBeenCalledWith('tx', 'invoice-1', { status: 'OVERDUE' });
    expect(result?.status).toBe('OVERDUE');
    expect(audit.log.mock.calls[0][1]).toMatchObject({
      action: 'INVOICE_OVERDUE',
      entityType: 'ContractInvoice',
      entityId: 'invoice-1',
      siteId: 'site-1',
    });
    expect(outbox.publishInTx.mock.calls[0][1]).toMatchObject({
      eventType: 'InvoiceOverdue',
      aggregateType: 'ContractInvoice',
      aggregateId: 'invoice-1',
      payload: expect.objectContaining({
        invoiceId: 'invoice-1',
        contractId: 'contract-1',
        siteId: 'site-1',
      }),
    });
  });

  it('dueDate bugun veya gelecekte ise henuz vadesi gecmemistir: null doner, hicbir yazma yapilmaz', async () => {
    const { service, invoiceRepo, audit, outbox } = buildService();
    invoiceRepo.findByIdForUpdate.mockResolvedValue(
      invoiceRow({ status: 'ISSUED', dueDate: utcToday() }),
    );

    const result = await service.markOverdueBySystem('invoice-1', 'site-1');

    expect(result).toBeNull();
    expect(invoiceRepo.updateStatus).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(outbox.publishInTx).not.toHaveBeenCalled();
  });

  it.each<InvoiceStatus>(['PAID', 'CANCELLED', 'OVERDUE', 'DRAFT'])(
    '%s durumundaki fatura dokunulmadan atlanir (baska worker/actor onceden cozmus olabilir)',
    async (status) => {
      const { service, invoiceRepo } = buildService();
      const pastDue = addUtcDays(utcToday(), -5);
      invoiceRepo.findByIdForUpdate.mockResolvedValue(invoiceRow({ status, dueDate: pastDue }));

      const result = await service.markOverdueBySystem('invoice-1', 'site-1');

      expect(result).toBeNull();
      expect(invoiceRepo.updateStatus).not.toHaveBeenCalled();
    },
  );

  it('fatura bulunamazsa (silinmis/yok) null doner, hata firlatilmaz', async () => {
    const { service, invoiceRepo } = buildService();
    invoiceRepo.findByIdForUpdate.mockResolvedValue(null);
    const result = await service.markOverdueBySystem('yok', 'site-1');
    expect(result).toBeNull();
  });

  it('siteId parametre olarak gelir; InvoiceRow siteId alanina hic erisilmez', async () => {
    const { service, invoiceRepo, audit } = buildService();
    const pastDue = addUtcDays(utcToday(), -1);
    invoiceRepo.findByIdForUpdate.mockResolvedValue(
      invoiceRow({ status: 'ISSUED', dueDate: pastDue }),
    );
    await service.markOverdueBySystem('invoice-1', 'site-42');
    expect(audit.log.mock.calls[0][1].siteId).toBe('site-42');
  });

  it('transaction hata firlatirsa hicbir yan etki kalici olmaz (rollback)', async () => {
    const { service, invoiceRepo, prisma } = buildService();
    const pastDue = addUtcDays(utcToday(), -1);
    invoiceRepo.findByIdForUpdate.mockResolvedValue(
      invoiceRow({ status: 'ISSUED', dueDate: pastDue }),
    );
    invoiceRepo.updateStatus.mockRejectedValue(new Error('DB baglanti hatasi'));
    prisma.$transaction.mockImplementationOnce(async (fn: (tx: string) => Promise<unknown>) =>
      fn('tx'),
    );
    await expect(service.markOverdueBySystem('invoice-1', 'site-1')).rejects.toThrow(
      'DB baglanti hatasi',
    );
  });
});

describe('InvoiceService.listForSite', () => {
  it('site yoksa 404 SITE_NOT_FOUND', async () => {
    const { service, facilityRepo } = buildService();
    facilityRepo.findAliveById.mockResolvedValue(null);
    await expect(service.listForSite(OPS_ACTOR, 'yok', {})).rejects.toMatchObject({
      code: 'SITE_NOT_FOUND',
    });
  });

  it('gecersiz cursor 422 VALIDATION_ERROR', async () => {
    const { service } = buildService();
    await expect(service.listForSite(OPS_ACTOR, 'site-1', { cursor: '!!!' })).rejects.toMatchObject(
      { code: 'VALIDATION_ERROR' },
    );
  });

  it('status ve contractId filtreleri site kapsami ile repository filtresine tasinir', async () => {
    const { service, invoiceRepo } = buildService();
    await service.listForSite(OPS_ACTOR, 'site-1', {
      status: 'ISSUED',
      contractId: 'contract-9',
      limit: 10,
    });
    expect(invoiceRepo.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        siteId: 'site-1',
        status: 'ISSUED',
        contractId: 'contract-9',
        limit: 10,
      }),
    );
  });
});
