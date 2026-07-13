import { Module } from '@nestjs/common';
import { SiteScopeGuard } from '../../common/guards/site-scope.guard';
import { MembershipQueryService } from './membership-query.service';
import { ResidentUnitAssignmentRepository } from './repositories/resident-unit-assignment.repository';
import { SiteMembershipRepository } from './repositories/site-membership.repository';

// Bagimsiz modul (yalniz global PrismaModule'e bagli) - onaylanan Faz 3
// plani Bolum 3. AuthModule/UsersModule/FacilitiesModule bunu import eder.
@Module({
  providers: [
    SiteMembershipRepository,
    ResidentUnitAssignmentRepository,
    MembershipQueryService,
    SiteScopeGuard,
  ],
  exports: [
    SiteMembershipRepository,
    ResidentUnitAssignmentRepository,
    MembershipQueryService,
    SiteScopeGuard,
  ],
})
export class MembershipsModule {}
