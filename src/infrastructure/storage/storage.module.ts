import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalStorageProvider } from './local-storage.provider';
import { STORAGE_PROVIDER } from './storage-provider.interface';

// Onaylanan Faz 6 plani Bolum 5: SmsModule ile ayni desen - config'teki
// storage.provider degerine gore factory. STORAGE_PROVIDER=s3 secilirse
// bootstrap acik bir hatayla durur (S3StorageProvider bu fazda implemente
// edilmedi, sahte/yarim provider yazilmadi).
@Module({
  providers: [
    LocalStorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService, LocalStorageProvider],
      useFactory: (config: ConfigService, localProvider: LocalStorageProvider) => {
        const provider = config.getOrThrow<string>('storage.provider');

        if (provider === 'local') {
          return localProvider;
        }

        throw new Error(
          `STORAGE_PROVIDER=${provider} desteklenmiyor: S3StorageProvider Faz 6 kapsaminda implemente edilmedi.`,
        );
      },
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
