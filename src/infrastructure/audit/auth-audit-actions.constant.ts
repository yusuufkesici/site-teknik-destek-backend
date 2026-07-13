// Yalniz auth guvenlik olaylari icin minimum action seti (onaylanan Faz 2
// plani Bolum 11, karar #10). Ticket/facility/contract audit action'lari
// bu fazda tanimlanmaz.
export const AUTH_AUDIT_ACTIONS = {
  OTP_REQUESTED: 'OTP_REQUESTED',
  OTP_REQUEST_REJECTED: 'OTP_REQUEST_REJECTED',
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',
  OTP_VERIFY_FAILED: 'OTP_VERIFY_FAILED',
  OTP_MAX_ATTEMPTS_REACHED: 'OTP_MAX_ATTEMPTS_REACHED',
  AUTH_LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
  REFRESH_TOKEN_ROTATED: 'REFRESH_TOKEN_ROTATED',
  REFRESH_TOKEN_REUSE_DETECTED: 'REFRESH_TOKEN_REUSE_DETECTED',
  REFRESH_TOKEN_REVOKED: 'REFRESH_TOKEN_REVOKED',
} as const;

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[keyof typeof AUTH_AUDIT_ACTIONS];

// AuditLog.entityId NOT NULL; somut bir entity olmadan yazilan olaylarda
// (ör. kayitsiz numara icin OTP_REQUEST_REJECTED) bu deger kullanilir.
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
