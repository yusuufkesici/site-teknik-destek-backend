import type { ContractStatus } from '../../../generated/prisma-client/enums';
import type { ContractRow } from '../repositories/contract.repository';

export interface ContractResponse {
  id: string;
  siteId: string;
  contractNumber: string;
  startDate: string;
  endDate: string;
  monthlyFee: string;
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
}

// Onaylanan Faz 7 plani Bolum 18: acik alan listesi (spread YOK), para
// .toFixed(2) string (attachment/assignment-material mapper emsalleri),
// @db.Date alanlari 'YYYY-MM-DD' olarak serilestirilir. Internal SQL/
// constraint/sequence/trigger detayi response'a cikmaz.
export function toContractResponse(row: ContractRow): ContractResponse {
  return {
    id: row.id,
    siteId: row.siteId,
    contractNumber: row.contractNumber,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    monthlyFee: row.monthlyFee.toFixed(2),
    currency: row.currency,
    billingDay: row.billingDay,
    status: row.status,
    serviceScope: row.serviceScope,
    standardResponseTargetHours: row.standardResponseTargetHours,
    emergencyCoverage: row.emergencyCoverage,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    terminatedAt: row.terminatedAt,
    terminationReason: row.terminationReason,
  };
}
