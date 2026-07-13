import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module';
import { SmsModule } from '../../infrastructure/sms/sms.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { AuthController } from './auth.controller';
import { OtpChallengeRepository } from './repositories/otp-challenge.repository';
import { RefreshSessionRepository } from './repositories/refresh-session.repository';
import { UserAuthRepository } from './repositories/user-auth.repository';
import { AuthSessionRevocationService } from './services/auth-session-revocation.service';
import { AuthService } from './services/auth.service';
import { OtpService } from './services/otp.service';
import { TokenService } from './services/token.service';

// JwtAuthGuard/RolesGuard burada APP_GUARD olarak register edilir (global);
// secret her cagride acikca gecirildigi icin JwtModule'e module-seviyesi
// secret verilmez (rotasyon destegi, onaylanan Faz 2 plani Bolum 9).
// Faz 3, duzeltme #3: MembershipReadRepository yerine MembershipsModule
// (disaridan gelen bagimlilik); RefreshSessionRepository dis modullere
// EXPORT EDILMEZ - yalniz AuthSessionRevocationService disari acilir.
@Module({
  imports: [JwtModule.register({}), RateLimitModule, SmsModule, AuditModule, MembershipsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    TokenService,
    AuthSessionRevocationService,
    UserAuthRepository,
    OtpChallengeRepository,
    RefreshSessionRepository,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
  exports: [AuthSessionRevocationService],
})
export class AuthModule {}
