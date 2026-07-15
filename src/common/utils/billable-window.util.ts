// Faz 7 (Contracts & Billing) - onaylanan plan Bolum 4.4/4.5/12: fatura
// doneminin ve sozlesme feshinin ortak "faturalanabilir pencere" ust siniri.
// Saf fonksiyonlar; ayni LEAST formulu InvoiceService on-kontrolu,
// ContractService fesih on-kontrolu ve PostgreSQL trigger'lari
// (fn_invoice_period_within_contract / fn_contract_termination_invoice_conflict)
// tarafindan birebir paylasildigi icin TEK yerde tanimlanir.
//
// Tarih semantigi:
// - Contract araligi kapsayici-kapsayici [startDate, endDate] (@db.Date).
// - Fatura donemi kapsayici-haric [billingPeriodStart, billingPeriodEnd).
// - Bu nedenle pencere ust siniri HARIC (exclusive) bir tarihtir:
//   ACTIVE/EXPIRED  -> endDate + 1 gun
//   TERMINATED      -> LEAST(endDate + 1 gun, UTC_DATE(terminatedAt) + 1 gun)
//   (terminatedAt, endDate'ten SONRA kaydedilmis olsa bile pencere sozlesmenin
//   dogal endDate sinirini asamaz - plan Bolum 4.4 duzeltme #2.)

const DAY_IN_MS = 86_400_000;

// @db.Date kolonlari Prisma'dan UTC geceyarisi Date olarak gelir; bu yardimci
// herhangi bir Date'in UTC takvim gununu UTC-geceyarisi Date'ine indirger.
export function toUtcDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function addUtcDays(dateOnly: Date, days: number): Date {
  return new Date(dateOnly.getTime() + days * DAY_IN_MS);
}

export function utcToday(): Date {
  return toUtcDateOnly(new Date());
}

// Faturalanabilir pencerenin HARIC ust siniri.
// terminatedAt null ise (ACTIVE/EXPIRED/henuz fesihsiz): endDate + 1 gun.
// terminatedAt dolu ise (TERMINATED veya fesih onerisi):
// LEAST(endDate + 1, UTC_DATE(terminatedAt) + 1).
export function computeBillableWindowEnd(endDate: Date, terminatedAt: Date | null): Date {
  const contractEndExclusive = addUtcDays(toUtcDateOnly(endDate), 1);
  if (!terminatedAt) {
    return contractEndExclusive;
  }
  const terminationExclusive = addUtcDays(toUtcDateOnly(terminatedAt), 1);
  return contractEndExclusive.getTime() <= terminationExclusive.getTime()
    ? contractEndExclusive
    : terminationExclusive;
}
