import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { FacilitiesController } from './facilities.controller';
import { FacilityRepository } from './repositories/facility.repository';
import { FacilityValidatorService } from './services/facility-validator.service';
import { FacilityService } from './services/facility.service';

@Module({
  imports: [MembershipsModule, AuditModule],
  controllers: [FacilitiesController],
  providers: [FacilityRepository, FacilityValidatorService, FacilityService],
  exports: [FacilityRepository, FacilityService],
})
export class FacilitiesModule {}
