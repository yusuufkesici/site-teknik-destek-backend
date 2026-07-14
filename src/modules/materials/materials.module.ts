import { Module } from '@nestjs/common';
import { MaterialRepository } from './repositories/material.repository';
import { MaterialLookupService } from './services/material-lookup.service';

@Module({
  providers: [MaterialRepository, MaterialLookupService],
  exports: [MaterialLookupService],
})
export class MaterialsModule {}
