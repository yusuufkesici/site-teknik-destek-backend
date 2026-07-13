import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { TicketStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 4 plani Bolum 5/8: bu fazda POST /tickets/:id/status yalniz
// OPEN->TRIAGED calistirir. toStatus DTO seviyesinde de yalniz 'TRIAGED'
// kabul eder (Phase4TicketTransitionPolicy ile cift savunma hatti).
// metadata alani kasitli olarak yok - Faz 4 icin gerekli degil, sinirsiz
// JSON kabul edilmez.
export class ChangeTicketStatusDto {
  @IsIn(['TRIAGED'])
  toStatus!: Extract<TicketStatus, 'TRIAGED'>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
