import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../../common/utils/mask.util';
import type { SmsProvider } from './sms-provider.interface';

// Production-only implementasyon: OTP kodunu HICBIR ortamda saklamaz veya
// loglamaz, NODE_ENV bazli dal icermez (onaylanan Faz 2 plani Bolum 10,
// duzeltme #6). Testler icin ayri bir CapturingSmsProvider test double'i
// kullanilir (test/e2e/support), bu dosya production kodunu etkilemez.
@Injectable()
export class MockSmsProvider implements SmsProvider {
  private readonly logger = new Logger(MockSmsProvider.name);

  async sendOtp(phone: string): Promise<void> {
    this.logger.debug(`[MOCK SMS] OTP gonderildi -> ${maskPhone(phone)}`);
  }

  async sendTicketNotification(phone: string): Promise<void> {
    this.logger.debug(`[MOCK SMS] Bildirim gonderildi -> ${maskPhone(phone)}`);
  }

  async sendEmergencyAlert(phone: string): Promise<void> {
    this.logger.warn(`[MOCK SMS/EMERGENCY] -> ${maskPhone(phone)}`);
  }

  async healthCheck(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }
}
