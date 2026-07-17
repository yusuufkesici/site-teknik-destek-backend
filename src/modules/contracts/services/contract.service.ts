import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DOMAIN_AUDIT_ACTIONS,
  type DomainAuditAction,
} from '../../../common/constants/domain-audit-actions.constant';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import {
  addUtcDays,
  computeBillableWindowEnd,
  toUtcDateOnly,
  utcToday,
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
} from '../../../common/utils/prisma-error.util';
import { Prisma } from '../../../generated/prisma-client/client';
import type { ContractStatus } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/events/outbox.service';
import { FacilityRepository } from '../../facilities/repositories/facility.repository';
import type { CreateContractDto } from '../dto/create-contract.dto';
import type { ListContractsQueryDto } from '../dto/list-contracts-query.dto';
import type { UpdateContractDto } from '../dto/update-contract.dto';
import {
  ContractRepository,
  type ContractRow,
  type UpdateContractInput,
} from '../repositories/contract.repository';
import { ContractStateMachine } from '../state/contract-state-machine';

const DEFAULT_PAGE_LIMIT = 20;

// DRAFT'ta serbest, sonrasinda kilitli ticari alanlar (plan Bolum 4.2).
const DRAFT_ONLY_FIELDS = ['monthlyFee', 'billingDay', 'currency'] as const;
// Her durumda duzenlenebilir operasyonel alanlar.
const ALWAYS_EDITABLE_FIELDS = [
  'serviceScope',
  'standardResponseTargetHours',
  'emergencyCoverage',
  'notes',
] as const;

type EditableField =
  (typeof DRAFT_ONLY_FIELDS)[number] | (typeof ALWAYS_EDITABLE_FIELDS)[number] | 'endDate';

interface TransitionAuditNaming {
  action: DomainAuditAction;
  eventType: string;
}

// Plan Bolum 16: her anlamli gecis kendi ozel adini alir (generic+specific
// cifte-yayin YOK).
const TRANSITION_NAMING: Partial<Record<ContractStatus, TransitionAuditNaming>> = {
  ACTIVE: { action: DOMAIN_AUDIT_ACTIONS.CONTRACT_ACTIVATED, eventType: 'ContractActivated' },
  SUSPENDED: { action: DOMAIN_AUDIT_ACTIONS.CONTRACT_SUSPENDED, eventType: 'ContractSuspended' },
  EXPIRED: { action: DOMAIN_AUDIT_ACTIONS.CONTRACT_EXPIRED, eventType: 'ContractExpired' },
  TERMINATED: {
    action: DOMAIN_AUDIT_ACTIONS.CONTRACT_TERMINATED,
    eventType: 'ContractTerminated',
  },
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

// Onaylanan Faz 7 plani Bolum 12: saf pessimistic kilit (FOR UPDATE), version
// kolonu/status-as-CAS YOK; ayni-satir yarislari kilitle serilesir, capraz-
// satir aktivasyon yarisinin nihai guvencesi excl_contracts_active_overlap'tir.
// CONCURRENT_MODIFICATION bu modulde ulasilabilir degildir ve kullanilmaz.
@Injectable()
export class ContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contractRepo: ContractRepository,
    private readonly facilityRepo: FacilityRepository,
    private readonly stateMachine: ContractStateMachine,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxService,
  ) {}

  async create(actor: AuthenticatedUser, dto: CreateContractDto): Promise<ContractRow> {
    const startDate = parseDateOnly(dto.startDate, 'startDate');
    const endDate = parseDateOnly(dto.endDate, 'endDate');

    if (endDate.getTime() <= startDate.getTime()) {
      throw new DomainError(
        ERROR_CODES.CONTRACT_INVALID_DATE_RANGE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Bitis tarihi baslangic tarihinden sonra olmalidir.',
        { startDate: dto.startDate, endDate: dto.endDate },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const site = await this.facilityRepo.findAliveById(tx, dto.siteId);
      if (!site || site.type !== 'SITE') {
        throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
      }

      // Plan Bolum 4.6: DRAFT-DRAFT cakismasi serbesttir; yalniz mevcut
      // ACTIVE/SUSPENDED kayitlarla on-kontrol yapilir (DRAFT olusumu icin
      // DB backstop yoktur - nihai guvence aktivasyondadir).
      const overlaps = await this.contractRepo.hasActiveOverlap(tx, dto.siteId, startDate, endDate);
      if (overlaps) {
        throw new DomainError(
          ERROR_CODES.CONTRACT_OVERLAP,
          HttpStatus.CONFLICT,
          'Bu site icin ayni donemde aktif/askida bir sozlesme zaten var.',
          { siteId: dto.siteId },
        );
      }

      const contractNumber = await this.contractRepo.nextNumber(tx);
      const created = await this.contractRepo.create(tx, {
        siteId: dto.siteId,
        contractNumber,
        startDate,
        endDate,
        monthlyFee: new Prisma.Decimal(dto.monthlyFee),
        currency: dto.currency,
        billingDay: dto.billingDay,
        serviceScope: dto.serviceScope,
        standardResponseTargetHours: dto.standardResponseTargetHours,
        emergencyCoverage: dto.emergencyCoverage,
        notes: dto.notes,
        createdByUserId: actor.id,
      });

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.CONTRACT_CREATED,
        actorUserId: actor.id,
        entityType: 'Contract',
        entityId: created.id,
        siteId: created.siteId,
        metadata: {
          contractNumber: created.contractNumber,
          status: created.status,
          monthlyFee: created.monthlyFee.toFixed(2),
          currency: created.currency,
          emergencyCoverage: created.emergencyCoverage,
        },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'ContractCreated',
        aggregateType: 'Contract',
        aggregateId: created.id,
        payload: {
          contractId: created.id,
          siteId: created.siteId,
          contractNumber: created.contractNumber,
          status: created.status,
          startDate: dto.startDate,
          endDate: dto.endDate,
          monthlyFee: created.monthlyFee.toFixed(2),
          currency: created.currency,
          createdByUserId: actor.id,
        },
      });

      return created;
    });
  }

  // Plan Bolum 12(e): birlesik alan+durum PATCH'inin 11 adimlik kesin sirasi.
  async update(
    actor: AuthenticatedUser,
    contractId: string,
    dto: UpdateContractDto,
  ): Promise<ContractRow> {
    return this.prisma.$transaction(async (tx) => {
      // 1) Satir kilidi.
      const current = await this.contractRepo.findByIdForUpdate(tx, contractId);
      if (!current) {
        throw new DomainError(
          ERROR_CODES.CONTRACT_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Sozlesme bulunamadi.',
        );
      }

      // terminationReason yalniz TERMINATED hedefiyle anlamlidir (plan 4.2).
      // Bos-govde kontrolunden ONCE calisir: yalniz-terminationReason iceren
      // govde "bos" degil, "gecersiz sekilde dolu"dur.
      if (dto.terminationReason !== undefined && dto.status !== 'TERMINATED') {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'terminationReason yalniz TERMINATED hedefiyle birlikte gonderilebilir.',
        );
      }

      // 2) Bos govde kontrolu.
      const providedFields = this.collectProvidedFields(dto);
      if (providedFields.length === 0 && dto.status === undefined) {
        throw new DomainError(
          ERROR_CODES.CONTRACT_UPDATE_EMPTY,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Guncellenecek en az bir alan veya status gonderilmelidir.',
        );
      }

      // 3) MEVCUT duruma gore mutable-field kontrolu.
      this.assertFieldMutability(current, dto, providedFields);

      // 4) Onerilen final state.
      const finalEndDate =
        dto.endDate !== undefined ? parseDateOnly(dto.endDate, 'endDate') : current.endDate;
      const targetStatus = dto.status ?? current.status;

      // 5) Final tarih dogrulamasi.
      if (finalEndDate.getTime() <= current.startDate.getTime()) {
        throw new DomainError(
          ERROR_CODES.CONTRACT_INVALID_DATE_RANGE,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Bitis tarihi baslangic tarihinden sonra olmalidir.',
          { endDate: dto.endDate },
        );
      }

      // 6) Yalniz dto.status acikca saglanmissa state machine + guard'lar
      //    (final degerler uzerinden).
      let terminatedAt: Date | undefined;
      if (dto.status !== undefined) {
        this.stateMachine.assertTransition(current.status, dto.status, {
          finalEndDate,
          today: utcToday(),
        });
        if (dto.status === 'TERMINATED') {
          terminatedAt = new Date();
        }
      }

      // 7) TERMINATED hedefinde non-CANCELLED fatura cakisma on-kontrolu
      //    (LEAST penceresi; contract satiri kilitli oldugundan es zamanli
      //    yeni fatura olusumu bu transaction bitene kadar bloklanir).
      if (dto.status === 'TERMINATED' && terminatedAt) {
        const windowEnd = computeBillableWindowEnd(finalEndDate, terminatedAt);
        const conflicts = await this.contractRepo.countNonCancelledInvoicesBeyond(
          tx,
          contractId,
          windowEnd,
        );
        if (conflicts > 0) {
          throw new DomainError(
            ERROR_CODES.CONTRACT_TERMINATION_INVOICE_CONFLICT,
            HttpStatus.CONFLICT,
            'Fesih penceresini asan iptal edilmemis fatura(lar) var; once ilgili faturalari iptal edin.',
            { contractId, conflictingInvoices: conflicts },
          );
        }
      }

      // 8) Final ACTIVE/SUSPENDED degerleriyle veya endDate degisiminde
      //    overlap on-kontrolu (kendisi haric).
      const endDateChanged =
        dto.endDate !== undefined && finalEndDate.getTime() !== current.endDate.getTime();
      if (targetStatus === 'ACTIVE' || targetStatus === 'SUSPENDED' || endDateChanged) {
        const overlaps = await this.contractRepo.hasActiveOverlap(
          tx,
          current.siteId,
          current.startDate,
          finalEndDate,
          contractId,
        );
        if (overlaps) {
          throw new DomainError(
            ERROR_CODES.CONTRACT_OVERLAP,
            HttpStatus.CONFLICT,
            'Bu site icin ayni donemde aktif/askida baska bir sozlesme var.',
            { siteId: current.siteId },
          );
        }
      }

      // Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.2): expiryNotifiedAt
      // sifirlama kurallari - (a) endDate degisimi, (b) ACTIVE-disi bir
      // durumdan ACTIVE'e giris (assertTransition from===to'yu zaten
      // reddettiginden dto.status==='ACTIVE' burada HER ZAMAN current.status
      // !=='ACTIVE' anlamina gelir - ayri bir "eski durum" kontrolu
      // gerekmez). Suspend sirasinda endDate otomatik uzamadigindan, yeniden
      // aktive edilen bir sozlesme ayni/daha yakin bitis tarihine karsi taze
      // bir uyari sansi almalidir.
      const shouldResetExpiryNotified = endDateChanged || dto.status === 'ACTIVE';

      // 9) Tek update + 10) DB constraint hata eslemesi.
      const updateData: UpdateContractInput = {
        ...(dto.endDate !== undefined ? { endDate: finalEndDate } : {}),
        ...(dto.monthlyFee !== undefined ? { monthlyFee: new Prisma.Decimal(dto.monthlyFee) } : {}),
        ...(dto.billingDay !== undefined ? { billingDay: dto.billingDay } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.serviceScope !== undefined ? { serviceScope: dto.serviceScope } : {}),
        ...(dto.standardResponseTargetHours !== undefined
          ? { standardResponseTargetHours: dto.standardResponseTargetHours }
          : {}),
        ...(dto.emergencyCoverage !== undefined
          ? { emergencyCoverage: dto.emergencyCoverage }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(terminatedAt ? { terminatedAt, terminationReason: dto.terminationReason?.trim() } : {}),
        ...(shouldResetExpiryNotified ? { expiryNotifiedAt: null } : {}),
      };

      let updated: ContractRow;
      try {
        updated = await this.contractRepo.update(tx, contractId, updateData);
      } catch (error) {
        throw this.translateDbError(error, current.siteId);
      }

      // 11) Ayni transaction'da audit + outbox (gecis-ozel tek kayit).
      const naming = dto.status !== undefined ? TRANSITION_NAMING[dto.status] : undefined;
      const action = naming?.action ?? DOMAIN_AUDIT_ACTIONS.CONTRACT_UPDATED;
      const eventType = naming?.eventType ?? 'ContractUpdated';

      await this.audit.log(tx, {
        action,
        actorUserId: actor.id,
        entityType: 'Contract',
        entityId: contractId,
        siteId: current.siteId,
        metadata: {
          ...(dto.status !== undefined ? { fromStatus: current.status, toStatus: dto.status } : {}),
          fieldsChanged: providedFields,
          reasonProvided: Boolean(dto.terminationReason?.trim()),
        },
      });

      await this.outbox.publishInTx(tx, {
        eventType,
        aggregateType: 'Contract',
        aggregateId: contractId,
        payload: {
          contractId,
          siteId: current.siteId,
          ...(dto.status !== undefined ? { fromStatus: current.status, toStatus: dto.status } : {}),
          fieldsChanged: providedFields,
        },
      });

      return updated;
    });
  }

  // Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.2/9, kritik karar #12):
  // ContractExpiringScanJob DISINDA hicbir yerden cagirilmaz. Aday secimi
  // kilitsizdi (ContractRepository.findExpiringSoonAcrossSites) - bu satir
  // kilitlendikten sonra statu/endDate/expiryNotifiedAt kosullari
  // transaction icinde TEKRAR dogrulanir: baska worker zaten islemis
  // olabilir, ya da islem sirasinda sozlesme guncellenmis (status/endDate
  // degismis) olabilir - yanlis event uretilmemesi bunun icindir. null
  // donusu hata DEGILDIR (idempotent-by-construction, plan Bolum 5.3
  // gerekcesiyle ayni - gereksiz advisory lock yerine row-lock + recheck).
  async markExpiringNotifiedBySystem(
    contractId: string,
    siteId: string,
    leadDays: number,
  ): Promise<ContractRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const contract = await this.contractRepo.findByIdForUpdate(tx, contractId);
      if (!contract) return null;

      const today = utcToday();
      const windowEnd = addUtcDays(today, leadDays);
      const withinWindow =
        contract.endDate.getTime() >= today.getTime() &&
        contract.endDate.getTime() <= windowEnd.getTime();

      if (contract.status !== 'ACTIVE' || contract.expiryNotifiedAt !== null || !withinWindow) {
        return null;
      }

      const updated = await this.contractRepo.markExpiringNotified(tx, contractId);
      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.CONTRACT_EXPIRING_NOTIFIED,
        entityType: 'Contract',
        entityId: contractId,
        siteId,
        metadata: { endDate: contract.endDate.toISOString().slice(0, 10) },
      });
      await this.outbox.publishInTx(tx, {
        eventType: 'ContractExpiring',
        aggregateType: 'Contract',
        aggregateId: contractId,
        payload: {
          contractId,
          contractNumber: contract.contractNumber,
          siteId,
          endDate: contract.endDate.toISOString().slice(0, 10),
        },
      });
      return updated;
    });
  }

  async listForSite(
    _actor: AuthenticatedUser,
    siteId: string,
    query: ListContractsQueryDto,
  ): Promise<PaginatedResult<ContractRow>> {
    // SiteScopeGuard yalniz erisimi dogrular, site varligini dogrulamaz
    // (guard'in kendi sozlesmesi) - varlik kontrolu burada yapilir.
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

    const rows = await this.contractRepo.list(this.prisma, {
      siteId,
      status: query.status,
      cursor,
      limit,
    });
    return buildPage(rows, limit);
  }

  private collectProvidedFields(dto: UpdateContractDto): EditableField[] {
    const editable: readonly EditableField[] = [
      'endDate',
      ...DRAFT_ONLY_FIELDS,
      ...ALWAYS_EDITABLE_FIELDS,
    ];
    return editable.filter((field) => dto[field] !== undefined);
  }

  private assertFieldMutability(
    current: ContractRow,
    dto: UpdateContractDto,
    providedFields: EditableField[],
  ): void {
    for (const field of DRAFT_ONLY_FIELDS) {
      if (dto[field] !== undefined && current.status !== 'DRAFT') {
        throw new DomainError(
          ERROR_CODES.CONTRACT_IMMUTABLE_FIELD,
          HttpStatus.UNPROCESSABLE_ENTITY,
          `${field} alani yalniz DRAFT durumunda degistirilebilir.`,
          { field, reason: 'ONLY_DRAFT', currentStatus: current.status },
        );
      }
    }

    if (providedFields.includes('endDate') && dto.endDate !== undefined) {
      if (current.status === 'EXPIRED' || current.status === 'TERMINATED') {
        throw new DomainError(
          ERROR_CODES.CONTRACT_IMMUTABLE_FIELD,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Terminal durumdaki sozlesmenin endDate alani degistirilemez.',
          { field: 'endDate', reason: 'TERMINAL_STATUS', currentStatus: current.status },
        );
      }
      // Plan Bolum 4.2: ACTIVE/SUSPENDED'ta yalniz uzatma (kisaltma yasak).
      if (current.status === 'ACTIVE' || current.status === 'SUSPENDED') {
        const newEndDate = parseDateOnly(dto.endDate, 'endDate');
        if (newEndDate.getTime() < current.endDate.getTime()) {
          throw new DomainError(
            ERROR_CODES.CONTRACT_IMMUTABLE_FIELD,
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Aktif/askida sozlesmede endDate yalniz ileri yonde uzatilabilir.',
            { field: 'endDate', reason: 'SHORTENING_NOT_ALLOWED', currentStatus: current.status },
          );
        }
      }
    }
  }

  // Plan Bolum 12(e) adim 10: on-kontrollerin kacirabilecegi yarislarin DB
  // backstop'lari - spike ile dogrulanmis gercek hata sekilleri uzerinden.
  private translateDbError(error: unknown, siteId: string): unknown {
    if (isExclusionConstraintViolation(error, 'excl_contracts_active_overlap')) {
      return new DomainError(
        ERROR_CODES.CONTRACT_OVERLAP,
        HttpStatus.CONFLICT,
        'Bu site icin ayni donemde aktif/askida baska bir sozlesme var.',
        { siteId },
      );
    }
    if (isRaisedConstraintViolation(error, 'chk_contract_termination_invoice_conflict')) {
      return new DomainError(
        ERROR_CODES.CONTRACT_TERMINATION_INVOICE_CONFLICT,
        HttpStatus.CONFLICT,
        'Fesih penceresini asan iptal edilmemis fatura(lar) var; once ilgili faturalari iptal edin.',
      );
    }
    if (isCheckConstraintViolation(error, 'chk_contract_termination_consistency')) {
      return new DomainError(
        ERROR_CODES.CONTRACT_TERMINATION_DETAILS_REQUIRED,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'TERMINATED durumu terminatedAt ve dolu terminationReason gerektirir.',
      );
    }
    return error;
  }
}
