import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller';
import { MaterialRepository } from './repositories/material.repository';
import { MaterialLookupService } from './services/material-lookup.service';

@Module({
  controllers: [MaterialsController],
  providers: [MaterialRepository, MaterialLookupService],
  exports: [MaterialLookupService],
})
export class MaterialsModule {}
