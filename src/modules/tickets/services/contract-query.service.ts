import { Injectable } from '@nestjs/common';
import type { PrismaClientLike } from '../../../common/types/prisma-client-like.type';

export interface ActiveContractRow {
  id: string;
  standardResponseTargetHours: number | null;
  emergencyCoverage: boolean;
}

// Dar, salt-okunur sozgurgu servisi - onaylanan Faz 4 plani Bolum 16
// (task rule 17): tam bir ContractsModule/CRUD acilmadan, yalniz ticket
// olusturma entitlement'i ve SLA hesabi icin gereken alanlari okur.
// TicketsModule icinde kalir (ayri bir ContractsModule Faz 7'ye ait).
@Injectable()
export class ContractQueryService {
  // Duzeltme #3: status='ACTIVE' tek basina yetmez - sozlesmenin tarih
  // araligi da (start_date/end_date, @db.Date) DB'nin CURRENT_DATE'ine
  // gore gecerli olmali. Date-only kolonlar oldugundan uygulama saat
  // diliminden bagimsiz kalmak icin karsilastirma DB tarafinda yapilir.
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
}
