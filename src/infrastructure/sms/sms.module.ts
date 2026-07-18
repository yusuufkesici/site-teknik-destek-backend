import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DevInboxSmsProvider } from './dev-inbox-sms.provider';
import { DevSmsInboxService } from './dev-sms-inbox.service';
import { MockSmsProvider } from './mock-sms.provider';
import { SMS_PROVIDER } from './sms-provider.interface';

// SMS_PROVIDER=external secilirse Faz 2 kapsaminda ExternalSmsProvider
// yazilmadigindan bootstrap acik bir hatayla durur (onaylanan Faz 2 plani
// Bolum 10 / Bolum 1 kapsam disi).
//
// Faz 9 karar #2: mock secildiginde YALNIZ cift kosul saglaninca
// (NODE_ENV=development VE DEV_SMS_INBOX_ENABLED=true -> devSmsInbox.enabled)
// OTP'yi bellekte tutan DevInboxSmsProvider kullanilir (manuel kabul testi
// icin); diger butun durumlarda davranis degismez, MockSmsProvider secilir.
@Module({
  providers: [
    MockSmsProvider,
    DevSmsInboxService,
    DevInboxSmsProvider,
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService, MockSmsProvider, DevInboxSmsProvider],
      useFactory: (
        config: ConfigService,
        mockProvider: MockSmsProvider,
        devInboxProvider: DevInboxSmsProvider,
      ) => {
        const provider = config.getOrThrow<string>('SMS_PROVIDER');

        if (provider === 'mock') {
          const devInboxEnabled = config.getOrThrow<boolean>('devSmsInbox.enabled');
          return devInboxEnabled ? devInboxProvider : mockProvider;
        }

        throw new Error(
          `SMS_PROVIDER=${provider} desteklenmiyor: ExternalSmsProvider Faz 2 kapsaminda implemente edilmedi.`,
        );
      },
    },
  ],
  exports: [SMS_PROVIDER, DevSmsInboxService],
})
export class SmsModule {}
