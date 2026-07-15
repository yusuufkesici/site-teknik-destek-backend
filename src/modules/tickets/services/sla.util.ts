import type { TicketUrgency } from '../../../generated/prisma-client/enums';
// Faz 7: ActiveContractRow, ContractsModule'un tek public erisim yuzeyi olan
// ContractLookupService'e tasindi (davranis birebir ayni).
import type { ActiveContractRow } from '../../contracts/services/contract-lookup.service';

const HOUR_IN_MS = 3_600_000;

// Saf fonksiyon (DB'ye bagimli degil, unit-test edilebilir) - onaylanan
// Faz 4 plani Bolum 16, duzeltme #4:
// - urgency=EMERGENCY ve contract.emergencyCoverage=true -> emergencySlaHours
// - urgency=EMERGENCY ve contract.emergencyCoverage=false -> standardResponseTargetHours (varsa) veya null
// - diger urgency degerleri -> standardResponseTargetHours (varsa) veya null
export function computeSlaTargetAt(
  createdAt: Date,
  urgency: TicketUrgency,
  contract: ActiveContractRow | null,
  emergencySlaHours: number,
): Date | null {
  if (!contract) return null;

  if (urgency === 'EMERGENCY' && contract.emergencyCoverage) {
    return new Date(createdAt.getTime() + emergencySlaHours * HOUR_IN_MS);
  }

  if (contract.standardResponseTargetHours != null) {
    return new Date(createdAt.getTime() + contract.standardResponseTargetHours * HOUR_IN_MS);
  }

  return null;
}
