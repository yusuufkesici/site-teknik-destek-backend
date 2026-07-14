import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { TicketStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 4 plani Bolum 5/8 + Faz 5 Bolum 11: POST /tickets/:id/status
// yalniz assignment akisina AIT OLMAYAN dogrudan gecisleri calistirir:
// OPEN->TRIAGED (Faz 4) ve COMPLETED->CLOSED (Faz 5 karar #3). toStatus DTO
// seviyesinde de yalniz bu iki degeri kabul eder
// (TicketDirectTransitionPolicy ile cift savunma hatti - allowlist'ler
// birbirinden bagimsiz surdurulmez, DTO burada yalniz bu ucun desteklegi
// degerleri disariya kapatir). metadata alani kasitli olarak yok - sinirsiz
// JSON kabul edilmez.
export class ChangeTicketStatusDto {
  @IsIn(['TRIAGED', 'CLOSED'])
  toStatus!: Extract<TicketStatus, 'TRIAGED' | 'CLOSED'>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
