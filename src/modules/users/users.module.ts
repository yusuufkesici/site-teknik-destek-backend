import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { UserRepository } from './repositories/user.repository';
import { UserAccessPolicy } from './services/user-access.policy';
import { UsersService } from './services/users.service';
import { UsersController } from './users.controller';

// Duzeltme #3: RefreshSessionRepository'ye dogrudan baglanmaz - AuthModule
// yalniz AuthSessionRevocationService'i export eder (onaylanan Faz 3 plani
// Bolum 3/11).
@Module({
  imports: [MembershipsModule, FacilitiesModule, AuthModule, AuditModule],
  controllers: [UsersController],
  providers: [UserRepository, UserAccessPolicy, UsersService],
})
export class UsersModule {}
