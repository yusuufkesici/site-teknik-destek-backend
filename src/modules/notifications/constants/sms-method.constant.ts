// NotificationDelivery.smsMethod kolonunun izin verilen degerleri -
// SmsProvider'in hangi metoduyla gonderilecegini secer (plan Bolum 6.3/6.4).
export const SMS_METHODS = {
  EMERGENCY_ALERT: 'EMERGENCY_ALERT',
  TICKET_NOTIFICATION: 'TICKET_NOTIFICATION',
} as const;

export type SmsMethod = (typeof SMS_METHODS)[keyof typeof SMS_METHODS];
