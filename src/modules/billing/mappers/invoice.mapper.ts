import type { InvoiceStatus, PaymentMethod } from '../../../generated/prisma-client/enums';
import type { InvoiceRow } from '../repositories/invoice.repository';

export interface InvoiceResponse {
  id: string;
  contractId: string;
  invoiceNumber: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  issueDate: string;
  dueDate: string;
  amount: string;
  currency: string;
  status: InvoiceStatus;
  paidAt: Date | null;
  paymentMethod: PaymentMethod | null;
  referenceNumber: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Onaylanan Faz 7 plani Bolum 18: acik alan listesi (spread YOK), amount
// .toFixed(2) string, @db.Date alanlari 'YYYY-MM-DD'. currency, contract'tan
// kopyalanmis snapshot olarak response'a cikar (client girdisi asla degildir).
export function toInvoiceResponse(row: InvoiceRow): InvoiceResponse {
  return {
    id: row.id,
    contractId: row.contractId,
    invoiceNumber: row.invoiceNumber,
    billingPeriodStart: row.billingPeriodStart.toISOString().slice(0, 10),
    billingPeriodEnd: row.billingPeriodEnd.toISOString().slice(0, 10),
    issueDate: row.issueDate.toISOString().slice(0, 10),
    dueDate: row.dueDate.toISOString().slice(0, 10),
    amount: row.amount.toFixed(2),
    currency: row.currency,
    status: row.status,
    paidAt: row.paidAt,
    paymentMethod: row.paymentMethod,
    referenceNumber: row.referenceNumber,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
