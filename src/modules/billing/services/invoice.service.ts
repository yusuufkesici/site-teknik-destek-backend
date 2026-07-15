import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DOMAIN_AUDIT_ACTIONS,
  type DomainAuditAction,
} from '../../../common/constants/domain-audit-actions.constant';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import {
  computeBillableWindowEnd,
  toUtcDateOnly,
} from '../../../common/utils/billable-window.util';
import {
  buildPage,
  decodeCursor,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import {
  isCheckConstraintViolation,
  isExclusionConstraintViolation,
  isRaisedConstraintViolation,
  isUniqueConstraintViolation,
} from '../../../common/utils/prisma-error.util';
import { Prisma } from '../../../generated/prisma-client/client';
import type { InvoiceStatus } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/events/outbox.service';
import { ContractLookupService } from '../../contracts/services/contract-lookup.service';
import { FacilityRepository } from '../../facilities/repositories/facility.repository';
import type { ChangeInvoiceStatusDto } from '../dto/change-invoice-status.dto';
import type { CreateInvoiceDto } from '../dto/create-invoice.dto';
import type { ListInvoicesQueryDto } from '../dto/list-invoices-query.dto';
import {
  InvoiceRepository,
  type InvoiceRow,
  type InvoiceStatusUpdateInput,
} from '../repositories/invoice.repository';
import { InvoiceStateMachine } from '../state/invoice-state-machine';

const DEFAULT_PAGE_LIMIT = 20;

interface TransitionAuditNaming {
  action: DomainAuditAction;
  eventType: string;
}

// Plan Bolum 16: her gecis kendi ozel adini alir. OVERDUE Faz 7'de
// ulasilamaz oldugundan burada adlandirilmaz.
const TRANSITION_NAMING: Partial<Record<InvoiceStatus, TransitionAuditNaming>> = {
  ISSUED: { action: DOMAIN_AUDIT_ACTIONS.INVOICE_ISSUED, eventType: 'InvoiceIssued' },
  PAID: { action: DOMAIN_AUDIT_ACTIONS.INVOICE_PAID, eventType: 'InvoicePaid' },
  CANCELLED: { action: DOMAIN_AUDIT_ACTIONS.INVOICE_CANCELLED, eventType: 'InvoiceCancelled' },
};

function parseDateOnly(value: string, field: string): Date {
  const parsed = new Date(value);
  // Round-trip kontrolu: V8, '2099-02-30' gibi tasan gunleri Invalid Date
  // yerine bir sonraki aya YUVARLAYABILIR - yalniz NaN kontrolu yetmez.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DomainError(
      ERROR_CODES.VALIDATION_ERROR,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `${field} gecerli bir takvim tarihi degil.`,
      { field },
    );
  }
  return toUtcDateOnly(parsed);
}

// Onaylanan Faz 7 plani Bolum 12(f)/(g): fatura olusturma ebeveyn contract
// satirini FOR UPDATE ile kilitler (ContractLookupService uzerinden -
// ContractRepository sizdirilmaz); status PATCH yalniz fatura satirini
// kilitler. Version kolonu/status-as-CAS yok, CONCURRENT_MODIFICATION
// bu modulde kullanilmaz.
@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly contractLookup: ContractLookupService,
    private readonly facilityRepo: FacilityRepository,
    private readonly stateMachine: InvoiceStateMachine,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxService,
  ) {}

  async create(
    actor: AuthenticatedUser,
    contractId: string,
    dto: CreateInvoiceDto,
  ): Promise<InvoiceRow> {
    const periodStart = parseDateOnly(dto.billingPeriodStart, 'billingPeriodStart');
    const periodEnd = parseDateOnly(dto.billingPeriodEnd, 'billingPeriodEnd');
    const issueDate = parseDateOnly(dto.issueDate, 'issueDate');
    const dueDate = parseDateOnly(dto.dueDate, 'dueDate');

    if (periodEnd.getTime() <= periodStart.getTime()) {
      throw new DomainError(
        ERROR_CODES.INVOICE_INVALID_PERIOD,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Donem bitisi donem baslangicindan sonra olmalidir.',
        { billingPeriodStart: dto.billingPeriodStart, billingPeriodEnd: dto.billingPeriodEnd },
      );
    }

    if (dueDate.getTime() < issueDate.getTime()) {
      throw new DomainError(
        ERROR_CODES.INVOICE_INVALID_DUE_DATE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Vade tarihi duzenlenme tarihinden once olamaz.',
        { issueDate: dto.issueDate, dueDate: dto.dueDate },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Plan Bolum 12(f): ebeveyn kilidi - es zamanli fesih/endDate
      // degisikligi bu transaction bitene kadar bloklanir.
      const contract = await this.contractLookup.findByIdForUpdate(tx, contractId);
      if (!contract) {
        throw new DomainError(
          ERROR_CODES.CONTRACT_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Sozlesme bulunamadi.',
        );
      }

      // Plan Bolum 4.4 billability matrisi: DRAFT ve SUSPENDED faturalanamaz.
      if (contract.status === 'DRAFT' || contract.status === 'SUSPENDED') {
        throw new DomainError(
          ERROR_CODES.INVOICE_CONTRACT_NOT_BILLABLE,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Bu durumdaki sozlesmeye fatura olusturulamaz.',
          { contractStatus: contract.status },
        );
      }

      // Plan Bolum 4.4: durum-bagimli pencere - TERMINATED icin
      // LEAST(endDate+1, UTC_DATE(terminatedAt)+1), digerlerinde endDate+1.
      const windowEnd = computeBillableWindowEnd(
        contract.endDate,
        contract.status === 'TERMINATED' ? contract.terminatedAt : null,
      );
      const windowStart = toUtcDateOnly(contract.startDate);
      if (
        periodStart.getTime() < windowStart.getTime() ||
        periodEnd.getTime() > windowEnd.getTime()
      ) {
        throw new DomainError(
          ERROR_CODES.INVOICE_PERIOD_OUT_OF_CONTRACT,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Fatura donemi sozlesmenin faturalanabilir penceresi disinda.',
          {
            billingPeriodStart: dto.billingPeriodStart,
            billingPeriodEnd: dto.billingPeriodEnd,
            contractStatus: contract.status,
          },
        );
      }

      // Cakisan non-CANCELLED donem on-kontrolu (contract kilitli iken).
      const overlaps = await this.invoiceRepo.hasOverlappingPeriod(
        tx,
        contractId,
        periodStart,
        periodEnd,
      );
      if (overlaps) {
        throw new DomainError(
          ERROR_CODES.INVOICE_PERIOD_OVERLAP,
          HttpStatus.CONFLICT,
          'Bu sozlesmede ayni donemle cakisan iptal edilmemis bir fatura var.',
          { contractId },
        );
      }

      const invoiceNumber = await this.invoiceRepo.nextNumber(tx);
      let created: InvoiceRow;
      try {
        created = await this.invoiceRepo.create(tx, {
          contractId,
          invoiceNumber,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          issueDate,
          dueDate,
          amount: new Prisma.Decimal(dto.amount),
          // Plan Bolum 4.3: currency KILITLI contract'tan server-side snapshot.
          currency: contract.currency,
          note: dto.note,
        });
      } catch (error) {
        throw this.translateCreateDbError(error, contractId);
      }

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.INVOICE_CREATED,
        actorUserId: actor.id,
        entityType: 'ContractInvoice',
        entityId: created.id,
        siteId: contract.siteId,
        metadata: {
          invoiceNumber: created.invoiceNumber,
          contractId,
          contractStatusAtCreation: contract.status,
          amount: created.amount.toFixed(2),
          currency: created.currency,
        },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'InvoiceCreated',
        aggregateType: 'ContractInvoice',
        aggregateId: created.id,
        payload: {
          invoiceId: created.id,
          invoiceNumber: created.invoiceNumber,
          contractId,
          siteId: contract.siteId,
          billingPeriodStart: dto.billingPeriodStart,
          billingPeriodEnd: dto.billingPeriodEnd,
          amount: created.amount.toFixed(2),
          currency: created.currency,
          status: created.status,
          contractStatusAtCreation: contract.status,
        },
      });

      return created;
    });
  }

  async changeStatus(
    actor: AuthenticatedUser,
    invoiceId: string,
    dto: ChangeInvoiceStatusDto,
  ): Promise<InvoiceRow> {
    // Plan Bolum 4.5: odeme alanlari yalniz hedef PAID iken kabul edilir.
    if (
      dto.status !== 'PAID' &&
      (dto.paymentMethod !== undefined || dto.referenceNumber !== undefined)
    ) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_ERROR,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Odeme alanlari yalniz PAID hedefiyle birlikte gonderilebilir.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const invoice = await this.invoiceRepo.findByIdForUpdate(tx, invoiceId);
      if (!invoice) {
        throw new DomainError(
          ERROR_CODES.INVOICE_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Fatura bulunamadi.',
        );
      }

      this.stateMachine.assertTransition(invoice.status, dto.status);

      const updateInput: InvoiceStatusUpdateInput = { status: dto.status };
      if (dto.status === 'PAID') {
        if (!dto.paymentMethod) {
          throw new DomainError(
            ERROR_CODES.INVOICE_PAYMENT_DETAILS_REQUIRED,
            HttpStatus.UNPROCESSABLE_ENTITY,
            'PAID durumu icin paymentMethod zorunludur.',
          );
        }
        const trimmedReference = dto.referenceNumber?.trim();
        if (dto.paymentMethod === 'BANK_TRANSFER' && !trimmedReference) {
          throw new DomainError(
            ERROR_CODES.INVOICE_PAYMENT_DETAILS_REQUIRED,
            HttpStatus.UNPROCESSABLE_ENTITY,
            'BANK_TRANSFER icin referenceNumber zorunludur.',
          );
        }
        // paidAt asla client'tan alinmaz - server UTC now (plan Bolum 4.5).
        updateInput.paidAt = new Date();
        updateInput.paymentMethod = dto.paymentMethod;
        updateInput.referenceNumber = trimmedReference;
      }

      let updated: InvoiceRow;
      try {
        updated = await this.invoiceRepo.updateStatus(tx, invoiceId, updateInput);
      } catch (error) {
        if (isCheckConstraintViolation(error, 'chk_invoice_payment_consistency')) {
          throw new DomainError(
            ERROR_CODES.INVOICE_PAYMENT_DETAILS_REQUIRED,
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Odeme alanlari PAID durumuyla tutarli degil.',
          );
        }
        throw error;
      }

      // Audit siteId'si contract.siteId'den turetilir (invoice'ta siteId yok).
      const contract = await this.contractLookup.findById(tx, invoice.contractId);
      const naming = TRANSITION_NAMING[dto.status];
      // Faz 7 state machine geregi buraya yalniz ISSUED/PAID/CANCELLED
      // hedefleri ulasabilir; naming her zaman tanimlidir.
      if (!naming) {
        throw new DomainError(
          ERROR_CODES.INTERNAL_ERROR,
          HttpStatus.INTERNAL_SERVER_ERROR,
          'Beklenmeyen fatura durumu gecisi.',
          { toStatus: dto.status },
        );
      }

      await this.audit.log(tx, {
        action: naming.action,
        actorUserId: actor.id,
        entityType: 'ContractInvoice',
        entityId: invoiceId,
        siteId: contract?.siteId,
        metadata: {
          fromStatus: invoice.status,
          toStatus: dto.status,
          ...(dto.status === 'PAID'
            ? {
                paymentMethod: dto.paymentMethod,
                hasReferenceNumber: Boolean(dto.referenceNumber?.trim()),
              }
            : {}),
        },
      });

      await this.outbox.publishInTx(tx, {
        eventType: naming.eventType,
        aggregateType: 'ContractInvoice',
        aggregateId: invoiceId,
        payload: {
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          contractId: invoice.contractId,
          siteId: contract?.siteId ?? null,
          fromStatus: invoice.status,
          toStatus: dto.status,
          ...(dto.status === 'PAID'
            ? {
                paymentMethod: dto.paymentMethod,
                amount: invoice.amount.toFixed(2),
                currency: invoice.currency,
              }
            : {}),
        },
      });

      return updated;
    });
  }

  async listForSite(
    _actor: AuthenticatedUser,
    siteId: string,
    query: ListInvoicesQueryDto,
  ): Promise<PaginatedResult<InvoiceRow>> {
    const site = await this.facilityRepo.findAliveById(this.prisma, siteId);
    if (!site || site.type !== 'SITE') {
      throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
    }

    let cursor = null;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Gecersiz cursor.',
        );
      }
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    const rows = await this.invoiceRepo.list(this.prisma, {
      siteId,
      status: query.status,
      contractId: query.contractId,
      cursor,
      limit,
    });
    return buildPage(rows, limit);
  }

  // Plan Bolum 17: spike ile dogrulanmis gercek hata sekilleri uzerinden
  // trigger/constraint -> domain hata eslemesi. Yanlis constraint asla baska
  // domain hatasina eslenmez (ad bazli eslesme).
  private translateCreateDbError(error: unknown, contractId: string): unknown {
    if (isExclusionConstraintViolation(error, 'excl_invoice_period_overlap')) {
      return new DomainError(
        ERROR_CODES.INVOICE_PERIOD_OVERLAP,
        HttpStatus.CONFLICT,
        'Bu sozlesmede ayni donemle cakisan iptal edilmemis bir fatura var.',
        { contractId },
      );
    }
    // Partial unique (uq_contract_invoices_period_start_open) P2002 uretir;
    // ayni kullanici-anlamina (donem cakismasi) eslenir.
    if (isUniqueConstraintViolation(error)) {
      return new DomainError(
        ERROR_CODES.INVOICE_PERIOD_OVERLAP,
        HttpStatus.CONFLICT,
        'Bu sozlesmede ayni donem baslangicli iptal edilmemis bir fatura var.',
        { contractId },
      );
    }
    if (isRaisedConstraintViolation(error, 'chk_invoice_contract_exists')) {
      return new DomainError(
        ERROR_CODES.CONTRACT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Sozlesme bulunamadi.',
      );
    }
    if (isRaisedConstraintViolation(error, 'chk_invoice_contract_not_billable')) {
      return new DomainError(
        ERROR_CODES.INVOICE_CONTRACT_NOT_BILLABLE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Bu durumdaki sozlesmeye fatura olusturulamaz.',
      );
    }
    if (isRaisedConstraintViolation(error, 'chk_invoice_period_within_contract')) {
      return new DomainError(
        ERROR_CODES.INVOICE_PERIOD_OUT_OF_CONTRACT,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Fatura donemi sozlesmenin faturalanabilir penceresi disinda.',
      );
    }
    if (isRaisedConstraintViolation(error, 'chk_invoice_currency_match')) {
      return new DomainError(
        ERROR_CODES.INVOICE_CURRENCY_MISMATCH,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Fatura para birimi sozlesme para birimiyle ayni olmalidir.',
      );
    }
    if (isCheckConstraintViolation(error, 'chk_invoice_due_after_issue')) {
      return new DomainError(
        ERROR_CODES.INVOICE_INVALID_DUE_DATE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Vade tarihi duzenlenme tarihinden once olamaz.',
      );
    }
    if (isCheckConstraintViolation(error, 'chk_invoice_period')) {
      return new DomainError(
        ERROR_CODES.INVOICE_INVALID_PERIOD,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Donem bitisi donem baslangicindan sonra olmalidir.',
      );
    }
    return error;
  }
}
