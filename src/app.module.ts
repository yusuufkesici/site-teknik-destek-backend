import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import {
  appConfig,
  authConfig,
  backgroundJobsConfig,
  contractsConfig,
  corsConfig,
  databaseConfig,
  loggingConfig,
  outboxRelayConfig,
  storageConfig,
  ticketsConfig,
} from './config/configuration';
import { validateEnv } from './config/validation.schema';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggerModule } from './infrastructure/logging/logger.module';
import { PrismaModule } from './infrastructure/database/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { FacilitiesModule } from './modules/facilities/facilities.module';
import { UsersModule } from './modules/users/users.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { BillingModule } from './modules/billing/billing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [
        appConfig,
        corsConfig,
        databaseConfig,
        loggingConfig,
        authConfig,
        ticketsConfig,
        storageConfig,
        outboxRelayConfig,
        contractsConfig,
        backgroundJobsConfig,
      ],
    }),
    // Faz 8 Dilim 1 (onaylanan docs/phase-8-plan.md Bolum 3.2/10.1):
    // global - SchedulerRegistry butun modullerde DI ile erisilebilir.
    ScheduleModule.forRoot(),
    LoggerModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    MembershipsModule,
    FacilitiesModule,
    UsersModule,
    TicketsModule,
    MaterialsModule,
    AssignmentsModule,
    AttachmentsModule,
    ContractsModule,
    BillingModule,
    NotificationsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
