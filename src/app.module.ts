import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import {
  appConfig,
  authConfig,
  corsConfig,
  databaseConfig,
  loggingConfig,
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
      ],
    }),
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
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
