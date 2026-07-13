// Log/audit metadata icin: ham telefon numarasi asla yazilmaz, yalnizca bu
// maskelenmis hali (CLAUDE.md "secret/kisisel veri loglanmamali").
export function maskPhone(e164: string): string {
  if (e164.length <= 6) {
    return '*'.repeat(e164.length);
  }

  const prefix = e164.slice(0, 3);
  const suffix = e164.slice(-2);
  const maskedLength = e164.length - prefix.length - suffix.length;

  return `${prefix}${'*'.repeat(maskedLength)}${suffix}`;
}
