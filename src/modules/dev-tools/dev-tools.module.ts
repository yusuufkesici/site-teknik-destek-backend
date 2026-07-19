import { Module } from '@nestjs/common';
import { SmsModule } from '../../infrastructure/sms/sms.module';
import { DevSmsInboxController } from './dev-sms-inbox.controller';

// YALNIZ NODE_ENV=development iken AppModule'e dahil edilir (app.module.ts).
// Production/test derlemelerinde route hic mount edilmez; yoklugu
// test/e2e/dev-sms-inbox.e2e-spec.ts ile dogrulanir.
@Module({
  imports: [SmsModule],
  controllers: [DevSmsInboxController],
})
export class DevToolsModule {}
