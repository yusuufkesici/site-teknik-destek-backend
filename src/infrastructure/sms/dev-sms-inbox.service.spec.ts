import {
  DEV_SMS_INBOX_MAX_ENTRIES,
  DEV_SMS_INBOX_TTL_MS,
  DevSmsInboxService,
} from './dev-sms-inbox.service';

describe('DevSmsInboxService', () => {
  let service: DevSmsInboxService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-07-18T10:00:00.000Z') });
    service = new DevSmsInboxService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('OTP kaydeder ve ayni numara icin son kodu doner', () => {
    service.recordOtp('+905550000004', '111111');
    service.recordOtp('+905550000004', '222222');

    expect(service.getLastOtp('+905550000004')?.code).toBe('222222');
    expect(service.entryCount).toBe(1);
  });

  it('bilinmeyen numara icin undefined doner', () => {
    expect(service.getLastOtp('+905550009999')).toBeUndefined();
  });

  it('TTL dolduktan sonra kayit donmez ve silinir', () => {
    service.recordOtp('+905550000004', '123456');

    jest.advanceTimersByTime(DEV_SMS_INBOX_TTL_MS + 1);

    expect(service.getLastOtp('+905550000004')).toBeUndefined();
    expect(service.entryCount).toBe(0);
  });

  it('TTL dolmadan hemen once kayit hala doner', () => {
    service.recordOtp('+905550000004', '123456');

    jest.advanceTimersByTime(DEV_SMS_INBOX_TTL_MS - 1);

    expect(service.getLastOtp('+905550000004')?.code).toBe('123456');
  });

  it('maksimum kayit sinirini asmaz; en eski kayit cikarilir', () => {
    for (let i = 0; i < DEV_SMS_INBOX_MAX_ENTRIES + 1; i += 1) {
      const phone = `+9055500${String(i).padStart(5, '0')}`;
      service.recordOtp(phone, '123456');
    }

    expect(service.entryCount).toBe(DEV_SMS_INBOX_MAX_ENTRIES);
    // Ilk eklenen (en eski) numara cikarildi, sonuncusu duruyor.
    expect(service.getLastOtp('+905550000000')).toBeUndefined();
    expect(
      service.getLastOtp(`+9055500${String(DEV_SMS_INBOX_MAX_ENTRIES).padStart(5, '0')}`),
    ).toBeDefined();
  });

  it('ayni numaraya yeni OTP eklemek insertion sirasini tazeler (eviction en eskiyi secer)', () => {
    // Siniri doldur: phone0 ... phone(MAX-1)
    for (let i = 0; i < DEV_SMS_INBOX_MAX_ENTRIES; i += 1) {
      service.recordOtp(`+9055500${String(i).padStart(5, '0')}`, '111111');
    }

    // phone0'i tazele: artik en eski phone1 olur.
    service.recordOtp('+905550000000', '222222');
    service.recordOtp('+905559999999', '333333');

    expect(service.entryCount).toBe(DEV_SMS_INBOX_MAX_ENTRIES);
    expect(service.getLastOtp('+905550000001')).toBeUndefined();
    expect(service.getLastOtp('+905550000000')?.code).toBe('222222');
    expect(service.getLastOtp('+905559999999')?.code).toBe('333333');
  });
});
