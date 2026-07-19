import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { DevSmsInboxService } from '../../infrastructure/sms/dev-sms-inbox.service';

// Faz 9 karar #2: mock OTP'nin manuel kabul testinde guvenli elde edilmesi.
// DevToolsModule yalniz cift kosulla (NODE_ENV=development VE
// DEV_SMS_INBOX_ENABLED=true) AppModule'e dahil edilir; ek guvence olarak
// handler ayni kosulu devSmsInbox.enabled uzerinden yeniden dogrular.
// OTP kodu yanit govdesinde doner ama hicbir yerde loglanmaz. @Public
// zorunludur: OTP olmadan token alinamayacagi icin bu uc kimlik dogrulamasi
// gerektiremez.
@Controller('dev/sms')
export class DevSmsInboxController {
  constructor(
    private readonly inbox: DevSmsInboxService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get(':phone/last-otp')
  getLastOtp(@Param('phone') phone: string): {
    phoneNumber: string;
    code: string;
    createdAt: Date;
  } {
    if (!this.config.getOrThrow<boolean>('devSmsInbox.enabled')) {
      throw new NotFoundException();
    }

    const entry = this.inbox.getLastOtp(phone);
    if (!entry) {
      throw new NotFoundException('Bu numara icin kayitli OTP yok.');
    }

    return { phoneNumber: phone, code: entry.code, createdAt: entry.createdAt };
  }
}
