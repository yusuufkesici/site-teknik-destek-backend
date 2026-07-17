import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { CursorPayload } from '../../../common/utils/pagination.util';
import type { Prisma } from '../../../generated/prisma-client/client';
import type { InvoiceStatus, PaymentMethod } from '../../../generated/prisma-client/enums';

export interface InvoiceRow {
  id: string;
  contractId: string;
  invoiceNumber: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  issueDate: Date;
  dueDate: Date;
  amount: Prisma.Decimal;
  currency: string;
  status: InvoiceStatus;
  paidAt: Date | null;
  paymentMethod: PaymentMethod | null;
  referenceNumber: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInvoiceInput {
  contractId: string;
  invoiceNumber: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  issueDate: Date;
  dueDate: Date;
  amount: Prisma.Decimal;
  // Plan Bolum 4.3: currency client'tan ALINMAZ - kilitli contract satirinin
  // o anki currency degerinin server-side snapshot'idir.
  currency: string;
  note?: string;
}

export interface InvoiceStatusUpdateInput {
  status: InvoiceStatus;
  paidAt?: Date;
  paymentMethod?: PaymentMethod;
  referenceNumber?: string;
}

export interface InvoiceListFilter {
  siteId: string;
  status?: InvoiceStatus;
  contractId?: string;
  cursor: CursorPayload | null;
  limit: number;
}

export interface OverdueInvoiceCandidate {
  id: string;
  contractId: string;
  siteId: string;
  invoiceNumber: string;
  dueDate: Date;
}

// Onaylanan Faz 7 plani Bolum 13: bu repository ASLA export edilmez.
// ContractInvoice'un kendi siteId'si YOKTUR - site kapsami her sorguda
// contract.siteId uzerinden turetilir (implementation-overrides.md #3).
@Injectable()
export class InvoiceRepository {
  async nextNumber(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<
      { nextval: bigint }[]
    >`SELECT nextval('invoice_number_seq') AS nextval`;
    const year = new Date().getUTCFullYear();
    return `INV-${year}-${rows[0].nextval.toString().padStart(6, '0')}`;
  }

  async create(client: PrismaClientLike, input: CreateInvoiceInput): Promise<InvoiceRow> {
    return client.contractInvoice.create({
      data: {
        contractId: input.contractId,
        invoiceNumber: input.invoiceNumber,
        billingPeriodStart: input.billingPeriodStart,
        billingPeriodEnd: input.billingPeriodEnd,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        amount: input.amount,
        currency: input.currency,
        note: input.note,
      },
    });
  }

  async findById(client: PrismaClientLike, id: string): Promise<InvoiceRow | null> {
    return client.contractInvoice.findUnique({ where: { id } });
  }

  // Plan Bolum 12(g): status PATCH yalniz fatura satirini kilitler (parent
  // contract'in yeniden kilitlenmesine gerek yoktur - durum gecisi contract
  // durumuna bagimli degildir).
  async findByIdForUpdate(client: PrismaClientLike, id: string): Promise<InvoiceRow | null> {
    const rows = await client.$queryRaw<InvoiceRow[]>`
      SELECT
        id,
        contract_id AS "contractId",
        invoice_number AS "invoiceNumber",
        billing_period_start AS "billingPeriodStart",
        billing_period_end AS "billingPeriodEnd",
        issue_date AS "issueDate",
        due_date AS "dueDate",
        amount,
        currency,
        status,
        paid_at AS "paidAt",
        payment_method AS "paymentMethod",
        reference_number AS "referenceNumber",
        note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM contract_invoices
      WHERE id = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  // Plan Bolum 4.4/12(f): ayni sozlesmede cakisan non-CANCELLED donem
  // on-kontrolu ('[)' yari-acik kesisim, excl_invoice_period_overlap ile
  // ayni semantik).
  async hasOverlappingPeriod(
    client: PrismaClientLike,
    contractId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<boolean> {
    const rows = await client.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM contract_invoices
        WHERE contract_id = ${contractId}::uuid
          AND status <> 'CANCELLED'
          AND daterange(billing_period_start, billing_period_end, '[)')
              && daterange(${periodStart}::date, ${periodEnd}::date, '[)')
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  }

  async updateStatus(
    client: PrismaClientLike,
    id: string,
    input: InvoiceStatusUpdateInput,
  ): Promise<InvoiceRow> {
    return client.contractInvoice.update({
      where: { id },
      data: {
        status: input.status,
        paidAt: input.paidAt,
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber,
      },
    });
  }

  // Faz 8 (onaylanan docs/phase-8-plan.md Bolum 7.1): sistem/cron-only,
  // siteler-arasi aday sorgusu - InvoiceOverdueScanJob DISINDA hicbir
  // yerden cagirilmaz (implementation-overrides.md #3: siteler arasi
  // sorgular yalniz acikca adlandirilmis ayri metotlarda olur). Kilitsiz
  // salt-okunur SELECT - asil mutasyon markOverdueBySystem() icinde
  // findByIdForUpdate ile ayrica kilitlenir, bu yuzden burada FOR UPDATE
  // YOKTUR. Mevcut @@index([status, dueDate]) kullanilir, yeni index
  // gerekmez. siteId invoice'ta YOKTUR - contract join'inden turer.
  async findOverdueCandidatesAcrossSites(
    client: PrismaClientLike,
    params: { today: Date; limit: number },
  ): Promise<OverdueInvoiceCandidate[]> {
    return client.$queryRaw<OverdueInvoiceCandidate[]>`
      SELECT ci.id, ci.contract_id AS "contractId", c.site_id AS "siteId",
             ci.invoice_number AS "invoiceNumber", ci.due_date AS "dueDate"
      FROM contract_invoices ci
      JOIN contracts c ON c.id = ci.contract_id
      WHERE ci.status = 'ISSUED' AND ci.due_date < ${params.today}::date
      ORDER BY ci.due_date ASC
      LIMIT ${params.limit}
    `;
  }

  // Site kapsami contract iliskisi uzerinden uygulanir; siteId'siz calisan
  // parametresiz bir liste metodu yoktur.
  async list(client: PrismaClientLike, filter: InvoiceListFilter): Promise<InvoiceRow[]> {
    const cursorWhere = filter.cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(filter.cursor.createdAt) } },
            { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
          ],
        }
      : {};

    return client.contractInvoice.findMany({
      where: {
        contract: { siteId: filter.siteId },
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.contractId ? { contractId: filter.contractId } : {}),
        ...cursorWhere,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }
}
