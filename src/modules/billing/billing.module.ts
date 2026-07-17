import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { ContractsModule } from '../contracts/contracts.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { InvoicesController } from './invoices.controller';
import { InvoiceOverdueScanJob } from './jobs/invoice-overdue-scan.job';
import { InvoiceRepository } from './repositories/invoice.repository';
import { InvoiceService } from './services/invoice.service';
import { InvoiceStateMachine } from './state/invoice-state-machine';

// Onaylanan Faz 7 plani Bolum 13: bagimlilik yonu TEK tarafli
// BillingModule -> ContractsModule (yalniz ContractLookupService enjekte
// edilir; ContractRepository'ye hicbir yoldan erisilmez). forwardRef yok,
// dongusel bagimlilik yok. InvoiceRepository export edilmez; bu modulun
// disariya hicbir export'u yoktur. Faz 8: InvoiceOverdueScanJob de burada
// yasar (onaylanan docs/phase-8-plan.md Bolum 3.2) - InvoiceRepository'yi
// disariya sizdirmadan dogrudan enjekte eder, exports degismez.
@Module({
  imports: [ContractsModule, MembershipsModule, FacilitiesModule, AuditModule, EventsModule],
  controllers: [InvoicesController],
  providers: [InvoiceRepository, InvoiceStateMachine, InvoiceService, InvoiceOverdueScanJob],
  exports: [],
})
export class BillingModule {}
