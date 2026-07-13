import { Module } from '@nestjs/common';
import { AuditWriter } from './audit-writer.service';

@Module({
  providers: [AuditWriter],
  exports: [AuditWriter],
})
export class AuditModule {}
