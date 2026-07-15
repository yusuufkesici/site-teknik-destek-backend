import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { ContractsModule } from '../contracts/contracts.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { InvoicesController } from './invoices.controller';
import { InvoiceRepository } from './repositories/invoice.repository';
import { InvoiceService } from './services/invoice.service';
import { InvoiceStateMachine } from './state/invoice-state-machine';

// Onaylanan Faz 7 plani Bolum 13: bagimlilik yonu TEK tarafli
// BillingModule -> ContractsModule (yalniz ContractLookupService enjekte
// edilir; ContractRepository'ye hicbir yoldan erisilmez). forwardRef yok,
// dongusel bagimlilik yok. InvoiceRepository export edilmez; bu modulun
// disariya hicbir export'u yoktur.
@Module({
  imports: [ContractsModule, MembershipsModule, FacilitiesModule, AuditModule, EventsModule],
  controllers: [InvoicesController],
  providers: [InvoiceRepository, InvoiceStateMachine, InvoiceService],
  exports: [],
})
export class BillingModule {}
