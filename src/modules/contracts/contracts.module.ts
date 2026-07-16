import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { ContractsController } from './contracts.controller';
import { ContractExpiringScanJob } from './jobs/contract-expiring-scan.job';
import { ContractRepository } from './repositories/contract.repository';
import { ContractLookupService } from './services/contract-lookup.service';
import { ContractService } from './services/contract.service';
import { ContractStateMachine } from './state/contract-state-machine';

// Onaylanan Faz 7 plani Bolum 13: ContractRepository ASLA export edilmez.
// Disariya acilan TEK sozlesme erisim yuzeyi ContractLookupService'tir
// (TicketsModule: findActiveForSite; BillingModule: findByIdForUpdate).
// Bagimlilik yonu tek tarafli - bu modul BillingModule/TicketsModule
// import ETMEZ, forwardRef yoktur. Faz 8: ContractExpiringScanJob de
// burada yasar (onaylanan docs/phase-8-plan.md Bolum 3.2) -
// ContractRepository'yi disariya sizdirmadan dogrudan enjekte eder,
// exports degismez.
@Module({
  imports: [MembershipsModule, FacilitiesModule, AuditModule, EventsModule],
  controllers: [ContractsController],
  providers: [
    ContractRepository,
    ContractStateMachine,
    ContractService,
    ContractLookupService,
    ContractExpiringScanJob,
  ],
  exports: [ContractLookupService],
})
export class ContractsModule {}
