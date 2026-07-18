import { Injectable } from '@nestjs/common';

// Inbox girdisinin omru: OTP'nin kendi gecerlilik suresinden (ornek
// OTP_EXPIRES_IN_SECONDS=180) uzun secilmis kisa bir sabit - suresi gecmis
// OTP zaten dogrulanamayacagi icin inbox'in daha uzun tutmasi anlamsizdir.
export const DEV_SMS_INBOX_TTL_MS = 5 * 60 * 1000;

// Manuel kabul testi bir avuc kurgusal numara kullanir; sinir yalniz
// bellegin sinirsiz buyumesini engelleyen guvenlik agidir.
export const DEV_SMS_INBOX_MAX_ENTRIES = 50;

export interface DevSmsInboxEntry {
  code: string;
  createdAt: Date;
}

interface StoredOtpEntry {
  code: string;
  createdAt: Date;
  expiresAtMs: number;
}

// Faz 9 karar #2 (onaylanan docs/phase-9-plan.md): manuel kabul testinin OTP
// adimini calistirabilmek icin dev-only, in-memory OTP kutusu. Yalniz cift
// kosulla (NODE_ENV=development VE DEV_SMS_INBOX_ENABLED=true) secilen
// DevInboxSmsProvider tarafindan yazilir; diger ortamlarda hicbir kayit
// olusmaz. Kod YALNIZ process belleginde tutulur: loglanmaz, veritabanina
// veya dosyaya yazilmaz. Map insertion-order korur; ayni numaraya yeni OTP
// once silinip yeniden eklenerek en yeni kayit sona tasinir, boylece sinir
// asiminda Map'in ilk anahtari her zaman en eski kayittir.
@Injectable()
export class DevSmsInboxService {
  private readonly entries = new Map<string, StoredOtpEntry>();

  recordOtp(phoneE164: string, code: string): void {
    this.entries.delete(phoneE164);

    const nowMs = Date.now();
    this.entries.set(phoneE164, {
      code,
      createdAt: new Date(nowMs),
      expiresAtMs: nowMs + DEV_SMS_INBOX_TTL_MS,
    });

    if (this.entries.size > DEV_SMS_INBOX_MAX_ENTRIES) {
      const oldestPhone = this.entries.keys().next().value;
      if (oldestPhone !== undefined) {
        this.entries.delete(oldestPhone);
      }
    }
  }

  getLastOtp(phoneE164: string): DevSmsInboxEntry | undefined {
    const entry = this.entries.get(phoneE164);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAtMs) {
      this.entries.delete(phoneE164);
      return undefined;
    }

    return { code: entry.code, createdAt: entry.createdAt };
  }

  get entryCount(): number {
    return this.entries.size;
  }
}
