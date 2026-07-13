// prisma/migrations/.../custom_constraints'teki chk_users_phone_e164 CHECK'iyle
// birebir ayni desen (docs/architecture.md Bolum 6).
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export function normalizeE164(raw: string): string | null {
  const normalized = raw.trim().replace(/[\s()-]/g, '');
  return E164_PATTERN.test(normalized) ? normalized : null;
}
