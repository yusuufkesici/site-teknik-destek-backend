import { Prisma } from '../../generated/prisma-client/client';

// Facility/User/Membership servislerinin P2002 (unique constraint ihlali)
// hatasini domain-uygun 409'a cevirmesi icin paylasilan yardimci
// (onaylanan Faz 3 plani Bolum 8/9 - "kod hic DB'ye gitmeden ön-kontrol
// edilmez", P2002 servis katmaninda yakalanir).
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// ---------------------------------------------------------------------------
// Faz 7 (Contracts & Billing) yardimcilari.
//
// Gercek hata sekilleri test/integration/contracts/
// constraint-violation-shapes.integration-spec.ts spike testiyle PostgreSQL 16
// + Prisma 7.8.0 + @prisma/adapter-pg uzerinde DOGRULANMISTIR:
//
// 1) 23P01 (EXCLUDE), 23514 (CHECK) ve P0001 (RAISE EXCEPTION) hatalari
//    Prisma'nin P#### koduna ESLENMEZ; "DriverAdapterError" adinda bir hata
//    olarak firlatilir. Sekli:
//      { name: 'DriverAdapterError', message, clientVersion,
//        cause: { kind: 'postgres', code, originalCode, message,
//                 originalMessage, severity, detail? } }
//    cause icinde YAPISAL bir 'constraint' alani YOKTUR (yalniz P2002
//    yolunda vardir) - PostgreSQL'in RAISE ... USING CONSTRAINT alani
//    adapter tarafindan tasinmaz.
// 2) P2002 (23505) ise PrismaClientKnownRequestError olarak gelir;
//    meta = { modelName, driverAdapterError: { cause: { originalCode:
//    '23505', kind: 'UniqueConstraintViolation', constraint: { fields } } } }.
//    Klasik meta.target alani driver-adapter yolunda BULUNMAZ.
//
// Bu nedenle:
// - 23P01/23514/23505 icin constraint adi, PostgreSQL'in SABIT hata mesaji
//   formatindan ('violates ... constraint "ad"') cikarilir - yapisal alan
//   olmadigi icin bu, son care olarak kabul edilen tek yoldur.
// - P0001 trigger hatalari icin migration'daki RAISE mesajlari
//   'constraint_adi: ...' on ekiyle uretilir (bizim kontrolumuzdeki sabit
//   protokol); ad bu on ekten okunur.
// ---------------------------------------------------------------------------

interface PgDriverCause {
  kind?: string;
  code?: string;
  originalCode?: string;
  message?: string;
  originalMessage?: string;
  constraint?: { fields?: string[]; index?: string } | string;
}

function extractPgCause(error: unknown): PgDriverCause | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as
      { driverAdapterError?: { cause?: PgDriverCause } } | null | undefined;
    return meta?.driverAdapterError?.cause ?? null;
  }

  if (typeof error === 'object' && error !== null) {
    const e = error as { name?: unknown; cause?: unknown };
    if (e.name === 'DriverAdapterError' && typeof e.cause === 'object' && e.cause !== null) {
      const cause = e.cause as PgDriverCause;
      if (cause.kind === 'postgres') {
        return cause;
      }
    }
  }

  return null;
}

function pgSqlState(cause: PgDriverCause): string | undefined {
  return cause.code ?? cause.originalCode;
}

const CONSTRAINT_MESSAGE_PATTERNS: Record<string, RegExp> = {
  '23P01': /violates exclusion constraint "([^"]+)"/,
  '23514': /violates check constraint "([^"]+)"/,
  '23505': /violates unique constraint "([^"]+)"/,
  // P0001: migration'daki RAISE mesaji 'constraint_adi: ...' protokolu.
  P0001: /^([a-z0-9_]+):/,
};

export function getConstraintName(error: unknown): string | undefined {
  const cause = extractPgCause(error);
  if (!cause) return undefined;

  const structured = cause.constraint;
  if (typeof structured === 'string') return structured;
  if (structured && typeof structured === 'object' && typeof structured.index === 'string') {
    return structured.index;
  }

  const code = pgSqlState(cause);
  if (!code) return undefined;
  const pattern = CONSTRAINT_MESSAGE_PATTERNS[code];
  if (!pattern) return undefined;

  const message = cause.message ?? cause.originalMessage ?? '';
  const match = pattern.exec(message);
  return match?.[1];
}

function matchesSqlState(error: unknown, sqlState: string, constraintName?: string): boolean {
  const cause = extractPgCause(error);
  if (!cause || pgSqlState(cause) !== sqlState) return false;
  if (!constraintName) return true;
  return getConstraintName(error) === constraintName;
}

// EXCLUDE USING gist ihlali (SQLSTATE 23P01).
export function isExclusionConstraintViolation(error: unknown, constraintName?: string): boolean {
  return matchesSqlState(error, '23P01', constraintName);
}

// CHECK constraint ihlali (SQLSTATE 23514).
export function isCheckConstraintViolation(error: unknown, constraintName?: string): boolean {
  return matchesSqlState(error, '23514', constraintName);
}

// Trigger/function icinden RAISE EXCEPTION ... USING ERRCODE='P0001',
// CONSTRAINT='ad' ile uretilen adlandirilmis hata.
export function isRaisedConstraintViolation(error: unknown, constraintName?: string): boolean {
  return matchesSqlState(error, 'P0001', constraintName);
}

// P2002 icin ihlal edilen alan listesi/index adi. Driver-adapter yolunda
// klasik meta.target yoktur; cause.constraint.fields (kolon adlari) veya
// cause.constraint.index (index adi) doner.
export function getUniqueConstraintTarget(error: unknown): string[] | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return undefined;
  }
  const cause = extractPgCause(error);
  const structured = cause?.constraint;
  if (structured && typeof structured === 'object' && Array.isArray(structured.fields)) {
    return structured.fields;
  }
  if (structured && typeof structured === 'object' && typeof structured.index === 'string') {
    return [structured.index];
  }
  if (typeof structured === 'string') return [structured];
  return undefined;
}
