import { Injectable } from '@nestjs/common';
import { DevSmsInboxService } from './dev-sms-inbox.service';
import { MockSmsProvider } from './mock-sms.provider';
import type { SmsProvider } from './sms-provider.interface';

// MockSmsProvider'in "NODE_ENV dali icermez, OTP saklamaz" sozlesmesini
// (Faz 2 duzeltme #6) bozmadan, OTP kodunu yalniz bellekte tutan dev
// sarmalayicisi. SmsModule factory'si bunu YALNIZ NODE_ENV=development
// iken secer; loglama davranisi MockSmsProvider'a delege edilir.
@Injectable()
export class DevInboxSmsProvider implements SmsProvider {
  private readonly delegate: SmsProvider;

  constructor(
    mock: MockSmsProvider,
    private readonly inbox: DevSmsInboxService,
  ) {
    this.delegate = mock;
  }

  async sendOtp(phoneE164: string, code: string): Promise<void> {
    this.inbox.recordOtp(phoneE164, code);
    await this.delegate.sendOtp(phoneE164, code);
  }

  async sendTicketNotification(phoneE164: string, message: string): Promise<void> {
    await this.delegate.sendTicketNotification(phoneE164, message);
  }

  async sendEmergencyAlert(phoneE164: string, message: string): Promise<void> {
    await this.delegate.sendEmergencyAlert(phoneE164, message);
  }

  healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return this.delegate.healthCheck();
  }
}
