import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { ContractsModule } from '../contracts/contracts.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { TICKET_TRANSITION_PORT } from './ports/ticket-transition.port';
import { TicketRepository } from './repositories/ticket.repository';
import { TicketService } from './services/ticket.service';
import { TicketTransitionService } from './services/ticket-transition.service';
import { TicketAuthorizationPolicy } from './policies/ticket-authorization.policy';
import { TicketReadAccessService } from './services/ticket-read-access.service';
import { TicketDirectTransitionPolicy } from './state/ticket-direct-transition.policy';
import { TicketStateMachine } from './state/ticket-state-machine';
import { TicketsController } from './tickets.controller';

// Faz 5 Bolum 2: TicketRepository/TicketStateMachine ASLA export edilmez.
// AssignmentsModule bu modulu import eder ve yalniz TICKET_TRANSITION_PORT
// token'ini enjekte eder - dar, transaction-aware bir port. Faz 6 Bolum 3:
// AttachmentsModule icin ayni desende ikinci bir dar export -
// TicketReadAccessService (concrete servis export, MaterialLookupService
// ile ayni yaklasim).
// Faz 7: eski ContractQueryService kaldirildi; aktif sozlesme sorgusu artik
// ContractsModule'un tek public yuzeyi olan ContractLookupService uzerinden
// yapilir (bagimlilik yonu TicketsModule -> ContractsModule, tek tarafli).
@Module({
  imports: [MembershipsModule, FacilitiesModule, ContractsModule, AuditModule, EventsModule],
  controllers: [TicketsController],
  providers: [
    TicketRepository,
    TicketAuthorizationPolicy,
    TicketStateMachine,
    TicketDirectTransitionPolicy,
    TicketTransitionService,
    TicketService,
    TicketReadAccessService,
    { provide: TICKET_TRANSITION_PORT, useExisting: TicketTransitionService },
  ],
  exports: [TICKET_TRANSITION_PORT, TicketReadAccessService],
})
export class TicketsModule {}
