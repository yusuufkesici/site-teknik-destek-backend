import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { UserRepository } from './repositories/user.repository';
import { UserAccessPolicy } from './services/user-access.policy';
import { UserContactLookupService } from './services/user-contact-lookup.service';
import { UsersService } from './services/users.service';
import { UsersController } from './users.controller';

// Duzeltme #3: RefreshSessionRepository'ye dogrudan baglanmaz - AuthModule
// yalniz AuthSessionRevocationService'i export eder (onaylanan Faz 3 plani
// Bolum 3/11).
// Faz 8 Dilim 1: UserContactLookupService, UsersModule'un disariya actigi
// ILK export'tur (onaylanan docs/phase-8-plan.md Bolum 3.2) - UserRepository
// yine export edilmez, disariya yalniz dar bildirim-alicisi yuzeyi acilir.
@Module({
  imports: [MembershipsModule, FacilitiesModule, AuthModule, AuditModule],
  controllers: [UsersController],
  providers: [UserRepository, UserAccessPolicy, UsersService, UserContactLookupService],
  exports: [UserContactLookupService],
})
export class UsersModule {}
