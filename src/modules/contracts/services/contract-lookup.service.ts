import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';
import type { Prisma } from '../../../generated/prisma-client/client';
import { ContractRepository, type ContractRow } from '../repositories/contract.repository';

export interface ActiveContractRow {
  id: string;
  standardResponseTargetHours: number | null;
  emergencyCoverage: boolean;
}

// Onaylanan Faz 7 plani Bolum 13/15: ContractsModule'un DISARIYA ACILAN TEK
// sozlesme erisim yuzeyi. ContractRepository asla export edilmez; TicketsModule
// (findActiveForSite) ve BillingModule (findByIdForUpdate/findById) yalniz bu
// servisi enjekte eder. Bagimlilik yonu tek tarafli: bu servis baska modul
// import etmez.
@Injectable()
export class ContractLookupService {
  constructor(private readonly contractRepo: ContractRepository) {}

  // Faz 4'ten BIREBIR tasinan davranis (eski src/modules/tickets/services/
  // contract-query.service.ts): status='ACTIVE' tek basina yetmez -
  // sozlesmenin tarih araligi da (start_date/end_date, @db.Date) DB'nin
  // CURRENT_DATE'ine gore gecerli olmali. Date-only kolonlar oldugundan
  // uygulama saat diliminden bagimsiz kalmak icin karsilastirma DB tarafinda
  // yapilir. TICKET_SITE_CONTRACT_INACTIVE davranisi degismez.
  async findActiveForSite(
    siteId: string,
    client: PrismaClientLike,
  ): Promise<ActiveContractRow | null> {
    const rows = await client.$queryRaw<ActiveContractRow[]>`
      SELECT
        id,
        standard_response_target_hours AS "standardResponseTargetHours",
        emergency_coverage AS "emergencyCoverage"
      FROM contracts
      WHERE site_id = ${siteId}
        AND status = 'ACTIVE'
        AND start_date <= CURRENT_DATE
        AND end_date >= CURRENT_DATE
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

  // BillingModule'un fatura olusturma transaction'inda ebeveyn sozlesmeyi
  // FOR UPDATE ile kilitleyip okumasi icin (plan Bolum 12f) - repository
  // sizdirilmadan kilit saglanir (TICKET_TRANSITION_PORT emsali).
  async findByIdForUpdate(
    tx: Prisma.TransactionClient,
    contractId: string,
  ): Promise<ContractRow | null> {
    return this.contractRepo.findByIdForUpdate(tx, contractId);
  }

  async findById(client: PrismaClientLike, contractId: string): Promise<ContractRow | null> {
    return this.contractRepo.findById(client, contractId);
  }
}
