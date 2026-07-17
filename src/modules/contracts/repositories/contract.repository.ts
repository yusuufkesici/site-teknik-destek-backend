import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { CursorPayload } from '../../../common/utils/pagination.util';
import type { Prisma } from '../../../generated/prisma-client/client';
import type { ContractStatus } from '../../../generated/prisma-client/enums';

export interface ContractRow {
  id: string;
  siteId: string;
  contractNumber: string;
  startDate: Date;
  endDate: Date;
  monthlyFee: Prisma.Decimal;
  currency: string;
  billingDay: number;
  status: ContractStatus;
  serviceScope: string | null;
  standardResponseTargetHours: number | null;
  emergencyCoverage: boolean;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  terminatedAt: Date | null;
  terminationReason: string | null;
  expiryNotifiedAt: Date | null;
}

export interface CreateContractInput {
  siteId: string;
  contractNumber: string;
  startDate: Date;
  endDate: Date;
  monthlyFee: Prisma.Decimal;
  currency?: string;
  billingDay: number;
  serviceScope?: string;
  standardResponseTargetHours?: number;
  emergencyCoverage?: boolean;
  notes?: string;
  createdByUserId: string;
}

export interface UpdateContractInput {
  endDate?: Date;
  monthlyFee?: Prisma.Decimal;
  billingDay?: number;
  currency?: string;
  serviceScope?: string;
  standardResponseTargetHours?: number;
  emergencyCoverage?: boolean;
  notes?: string;
  status?: ContractStatus;
  terminatedAt?: Date;
  terminationReason?: string;
  // Faz 8: yalniz ContractService.update'in expiryNotifiedAt sifirlama
  // dokunusu tarafindan kullanilir (endDate degisimi / ACTIVE'e yeniden
  // giris) - "undefined" alan degismez, "null" acikca sifirlar anlamina
  // gelir (diger opsiyonel alanlarla ayni Prisma partial-update semantigi).
  expiryNotifiedAt?: Date | null;
}

export interface ContractListFilter {
  siteId: string;
  status?: ContractStatus;
  cursor: CursorPayload | null;
  limit: number;
}

export interface ExpiringContractCandidate {
  id: string;
  siteId: string;
  contractNumber: string;
  endDate: Date;
}

// Onaylanan Faz 7 plani Bolum 13: bu repository ASLA export edilmez;
// modul disina yalniz ContractLookupService acilir. Site kapsamli liste
// metodu siteId'siz calismaz (implementation-overrides.md #3).
@Injectable()
export class ContractRepository {
  // Plan Bolum 4.10: sequence gap normaldir; yil, ticket_code_seq emsaliyle
  // tutarli olarak app sunucusunun UTC yilindan uretilir.
  async nextNumber(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<
      { nextval: bigint }[]
    >`SELECT nextval('contract_number_seq') AS nextval`;
    const year = new Date().getUTCFullYear();
    return `CNT-${year}-${rows[0].nextval.toString().padStart(6, '0')}`;
  }

  async create(client: PrismaClientLike, input: CreateContractInput): Promise<ContractRow> {
    return client.contract.create({
      data: {
        siteId: input.siteId,
        contractNumber: input.contractNumber,
        startDate: input.startDate,
        endDate: input.endDate,
        monthlyFee: input.monthlyFee,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        billingDay: input.billingDay,
        serviceScope: input.serviceScope,
        standardResponseTargetHours: input.standardResponseTargetHours,
        emergencyCoverage: input.emergencyCoverage,
        notes: input.notes,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  async findById(client: PrismaClientLike, id: string): Promise<ContractRow | null> {
    return client.contract.findUnique({ where: { id } });
  }

  // Plan Bolum 12: saf pessimistic kilit - PATCH ve fatura olusturma
  // transaction'lari sozlesme satirini her zaman once FOR UPDATE ile kilitler.
  async findByIdForUpdate(client: PrismaClientLike, id: string): Promise<ContractRow | null> {
    const rows = await client.$queryRaw<ContractRow[]>`
      SELECT
        id,
        site_id AS "siteId",
        contract_number AS "contractNumber",
        start_date AS "startDate",
        end_date AS "endDate",
        monthly_fee AS "monthlyFee",
        currency,
        billing_day AS "billingDay",
        status,
        service_scope AS "serviceScope",
        standard_response_target_hours AS "standardResponseTargetHours",
        emergency_coverage AS "emergencyCoverage",
        notes,
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        terminated_at AS "terminatedAt",
        termination_reason AS "terminationReason",
        expiry_notified_at AS "expiryNotifiedAt"
      FROM contracts
      WHERE id = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  // Plan Bolum 4.6: create ve endDate guncellemelerinde ACTIVE/SUSPENDED
  // kayitlarla uygulama on-kontrolu. excl_contracts_active_overlap ile ayni
  // semantik: kapsayici-kapsayici ('[]') daterange kesisimi.
  async hasActiveOverlap(
    client: PrismaClientLike,
    siteId: string,
    startDate: Date,
    endDate: Date,
    excludeContractId?: string,
  ): Promise<boolean> {
    const rows = await client.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM contracts
        WHERE site_id = ${siteId}::uuid
          AND status IN ('ACTIVE', 'SUSPENDED')
          AND id <> ${excludeContractId ?? '00000000-0000-0000-0000-000000000000'}::uuid
          AND daterange(start_date, end_date, '[]')
              && daterange(${startDate}::date, ${endDate}::date, '[]')
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  }

  async update(
    client: PrismaClientLike,
    id: string,
    data: UpdateContractInput,
  ): Promise<ContractRow> {
    return client.contract.update({
      where: { id },
      data: {
        endDate: data.endDate,
        monthlyFee: data.monthlyFee,
        billingDay: data.billingDay,
        currency: data.currency,
        serviceScope: data.serviceScope,
        standardResponseTargetHours: data.standardResponseTargetHours,
        emergencyCoverage: data.emergencyCoverage,
        notes: data.notes,
        status: data.status,
        terminatedAt: data.terminatedAt,
        terminationReason: data.terminationReason,
        expiryNotifiedAt: data.expiryNotifiedAt,
      },
    });
  }

  // Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.2/9): ContractExpiringScanJob'un
  // sistem-only, siteler-arasi aday sorgusu - implementation-overrides.md
  // #3 geregi acikca adlandirilmis, kilitsiz salt-okunur. Asil mutasyon
  // (ContractService.markExpiringNotifiedBySystem) her aday icin AYRI bir
  // findByIdForUpdate row-lock kullanir. Mevcut @@index([status, endDate])
  // kullanilir.
  async findExpiringSoonAcrossSites(
    client: PrismaClientLike,
    params: { today: Date; leadDays: number; limit: number },
  ): Promise<ExpiringContractCandidate[]> {
    return client.$queryRaw<ExpiringContractCandidate[]>`
      SELECT id, site_id AS "siteId", contract_number AS "contractNumber", end_date AS "endDate"
      FROM contracts
      WHERE status = 'ACTIVE'
        AND end_date >= ${params.today}::date
        AND end_date <= ${params.today}::date + (${params.leadDays} || ' days')::interval
        AND expiry_notified_at IS NULL
      ORDER BY end_date ASC
      LIMIT ${params.limit}
    `;
  }

  // Sistem-only, dar yazma yolu - InvoiceRepository.updateStatus emsali.
  // Genel update()'i degil, yalniz bu tek alani hedefleyen ayri bir metot
  // kullanmak niyeti acik tutar (ContractExpiringScanJob DISINDA cagrilmaz).
  async markExpiringNotified(client: PrismaClientLike, id: string): Promise<ContractRow> {
    return client.contract.update({
      where: { id },
      data: { expiryNotifiedAt: new Date() },
    });
  }

  // Plan Bolum 12(e) adim 7: fesih on-kontrolu - pencereyi asan non-CANCELLED
  // fatura sayisi. contract_invoices tablosu Prisma uzerinden okunur; bu bir
  // modul-sinir ihlali degildir (BillingModule'un provider'ina degil, ayni
  // veritabani tablosuna erisimdir ve fesih kurali sozlesme domain'ine aittir).
  async countNonCancelledInvoicesBeyond(
    client: PrismaClientLike,
    contractId: string,
    windowEndExclusive: Date,
  ): Promise<number> {
    return client.contractInvoice.count({
      where: {
        contractId,
        status: { not: 'CANCELLED' },
        billingPeriodEnd: { gt: windowEndExclusive },
      },
    });
  }

  async list(client: PrismaClientLike, filter: ContractListFilter): Promise<ContractRow[]> {
    const cursorWhere = filter.cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(filter.cursor.createdAt) } },
            { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
          ],
        }
      : {};

    return client.contract.findMany({
      where: {
        siteId: filter.siteId,
        ...(filter.status ? { status: filter.status } : {}),
        ...cursorWhere,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }
}
