// Faz 3'e ozgu, derlenebilir audit action seti (onaylanan Faz 3 plani
// Bolum 12, duzeltme #8). Ticket/facility/contract disindaki genel amacli
// audit action'lari bu dosyada YOK - yalniz bu fazin ihtiyaci kadar.
export const DOMAIN_AUDIT_ACTIONS = {
  FACILITY_CREATED: 'FACILITY_CREATED',
  RESIDENT_ONBOARDED: 'RESIDENT_ONBOARDED',
  SITE_MEMBERSHIP_DEACTIVATED: 'SITE_MEMBERSHIP_DEACTIVATED',
  RESIDENT_UNIT_ASSIGNMENT_DEACTIVATED: 'RESIDENT_UNIT_ASSIGNMENT_DEACTIVATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_PHONE_CHANGED: 'USER_PHONE_CHANGED',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  // Faz 4 (Ticket cekirdegi) — onaylanan Faz 4 plani Bolum 15.
  TICKET_CREATED: 'TICKET_CREATED',
  TICKET_UPDATED: 'TICKET_UPDATED',
  TICKET_STATUS_CHANGED: 'TICKET_STATUS_CHANGED',
  TICKET_CANCELLED: 'TICKET_CANCELLED',
} as const;

export type DomainAuditAction = (typeof DOMAIN_AUDIT_ACTIONS)[keyof typeof DOMAIN_AUDIT_ACTIONS];
