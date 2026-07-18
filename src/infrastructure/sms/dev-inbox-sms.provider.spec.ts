import { Logger } from '@nestjs/common';
import { DevInboxSmsProvider } from './dev-inbox-sms.provider';
import { DevSmsInboxService } from './dev-sms-inbox.service';
import { MockSmsProvider } from './mock-sms.provider';

describe('DevInboxSmsProvider', () => {
  let mock: MockSmsProvider;
  let inbox: DevSmsInboxService;
  let provider: DevInboxSmsProvider;

  beforeEach(() => {
    mock = new MockSmsProvider();
    inbox = new DevSmsInboxService();
    provider = new DevInboxSmsProvider(mock, inbox);
  });

  it("sendOtp kodu inbox'a kaydeder ve mock provider'a delege eder", async () => {
    const sendOtpSpy = jest.spyOn(mock, 'sendOtp');

    await provider.sendOtp('+905550000004', '123456');

    expect(inbox.getLastOtp('+905550000004')?.code).toBe('123456');
    expect(sendOtpSpy).toHaveBeenCalledTimes(1);
  });

  it('ayni numaraya ikinci OTP oncekini gecersiz kilar (son kod doner)', async () => {
    await provider.sendOtp('+905550000004', '111111');
    await provider.sendOtp('+905550000004', '222222');

    expect(inbox.getLastOtp('+905550000004')?.code).toBe('222222');
  });

  it('kayitli olmayan numara icin inbox undefined doner', () => {
    expect(inbox.getLastOtp('+905550009999')).toBeUndefined();
  });

  it("bildirim ve acil durum cagrilari inbox'a OTP yazmadan delege edilir", async () => {
    const notificationSpy = jest.spyOn(mock, 'sendTicketNotification');
    const emergencySpy = jest.spyOn(mock, 'sendEmergencyAlert');

    await provider.sendTicketNotification('+905550000004', 'bildirim');
    await provider.sendEmergencyAlert('+905550000004', 'acil');

    expect(notificationSpy).toHaveBeenCalledWith('+905550000004', 'bildirim');
    expect(emergencySpy).toHaveBeenCalledWith('+905550000004', 'acil');
    expect(inbox.getLastOtp('+905550000004')).toBeUndefined();
  });

  it('healthCheck mock provider sonucunu doner', async () => {
    await expect(provider.healthCheck()).resolves.toEqual({ healthy: true });
  });

  it('OTP kodu hicbir log seviyesine gonderilmez (maskelenmis telefon loglanabilir)', async () => {
    const code = '987654';
    const spies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => undefined),
    ];

    try {
      await provider.sendOtp('+905550000004', code);

      const loggedText = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => String(arg))
        .join(' ');
      expect(loggedText).not.toContain(code);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
