export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
  sendOtp(phoneE164: string, code: string): Promise<void>;
  sendTicketNotification(phoneE164: string, message: string): Promise<void>;
  sendEmergencyAlert(phoneE164: string, message: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}
