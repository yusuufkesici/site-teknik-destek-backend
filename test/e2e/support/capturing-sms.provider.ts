import { Injectable } from '@nestjs/common';
import type { SmsProvider } from '../../../src/infrastructure/sms/sms-provider.interface';

// Yalniz test derlemesinde var olur (Test.createTestingModule(...)
// .overrideProvider(SMS_PROVIDER).useClass(CapturingSmsProvider)) - production
// SmsModule'a hic baglanmaz. Ham OTP kodunu yalniz bu test double bellekte
// tutar; production MockSmsProvider ASLA kod saklamaz/loglamaz (onaylanan
// Faz 2 plani Bolum 10/12, duzeltme #6).
@Injectable()
export class CapturingSmsProvider implements SmsProvider {
  private readonly lastCodeByPhone = new Map<string, string>();
  private readonly sentCountByPhone = new Map<string, number>();
  private readonly ticketNotifications: { phone: string; message: string }[] = [];
  private readonly emergencyAlerts: { phone: string; message: string }[] = [];

  async sendOtp(phoneE164: string, code: string): Promise<void> {
    this.lastCodeByPhone.set(phoneE164, code);
    this.sentCountByPhone.set(phoneE164, (this.sentCountByPhone.get(phoneE164) ?? 0) + 1);
  }

  // Faz 8 Dilim 1'den itibaren NotificationDeliveryRelay tarafindan
  // gercekten cagriliyor (onaylanan docs/phase-8-plan.md) - e2e testlerin
  // uctan uca dogrulama yapabilmesi icin cagrilar burada tutulur.
  async sendTicketNotification(phoneE164: string, message: string): Promise<void> {
    this.ticketNotifications.push({ phone: phoneE164, message });
  }

  async sendEmergencyAlert(phoneE164: string, message: string): Promise<void> {
    this.emergencyAlerts.push({ phone: phoneE164, message });
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }

  getLastCode(phoneE164: string): string | undefined {
    return this.lastCodeByPhone.get(phoneE164);
  }

  getSentCount(phoneE164: string): number {
    return this.sentCountByPhone.get(phoneE164) ?? 0;
  }

  getTicketNotifications(): { phone: string; message: string }[] {
    return [...this.ticketNotifications];
  }

  getEmergencyAlerts(): { phone: string; message: string }[] {
    return [...this.emergencyAlerts];
  }
}
