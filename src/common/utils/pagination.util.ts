// Cursor (createdAt+id) encode/decode - onaylanan Faz 3 plani Bolum 17
// risk #7: yalniz GET /sites/:siteId/users'in ihtiyaci kadar minimal.
export interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(`${payload.createdAt}|${payload.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separatorIndex = decoded.indexOf('|');
    if (separatorIndex <= 0) {
      return null;
    }

    const createdAt = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

// 'rows' cagiran tarafindan limit+1 kayitla sorgulanmis olmali (bir sonraki
// sayfanin var olup olmadigini anlamak icin).
export function buildPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { items, nextCursor };
}
