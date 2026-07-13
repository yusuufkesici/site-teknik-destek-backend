import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import type { TicketRow } from '../repositories/ticket.repository';

// Onaylanan Faz 4 plani Bolum 3 karar #5 / Bolum 15: operationNote yazma
// kisiti ("yalniz OP") response'a da uygulanir - OPERATIONS-disi rollere
// donen JSON'dan alan tamamen cikarilir.
export function toTicketResponse(
  row: TicketRow,
  actor: AuthenticatedUser,
): Omit<TicketRow, 'operationNote'> | TicketRow {
  if (actor.role === 'OPERATIONS') return row;
  const { operationNote: _operationNote, ...rest } = row;
  return rest;
}
