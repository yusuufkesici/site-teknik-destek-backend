import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockSmsProvider } from './mock-sms.provider';
import { SMS_PROVIDER } from './sms-provider.interface';

// SMS_PROVIDER=external secilirse Faz 2 kapsaminda ExternalSmsProvider
// yazilmadigindan bootstrap acik bir hatayla durur (onaylanan Faz 2 plani
// Bolum 10 / Bolum 1 kapsam disi).
@Module({
  providers: [
    MockSmsProvider,
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService, MockSmsProvider],
      useFactory: (config: ConfigService, mockProvider: MockSmsProvider) => {
        const provider = config.getOrThrow<string>('SMS_PROVIDER');

        if (provider === 'mock') {
          return mockProvider;
        }

        throw new Error(
          `SMS_PROVIDER=${provider} desteklenmiyor: ExternalSmsProvider Faz 2 kapsaminda implemente edilmedi.`,
        );
      },
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}
