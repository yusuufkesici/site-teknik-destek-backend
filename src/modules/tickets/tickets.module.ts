import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { TICKET_TRANSITION_PORT } from './ports/ticket-transition.port';
import { TicketRepository } from './repositories/ticket.repository';
import { ContractQueryService } from './services/contract-query.service';
import { TicketService } from './services/ticket.service';
import { TicketTransitionService } from './services/ticket-transition.service';
import { TicketAuthorizationPolicy } from './policies/ticket-authorization.policy';
import { TicketDirectTransitionPolicy } from './state/ticket-direct-transition.policy';
import { TicketStateMachine } from './state/ticket-state-machine';
import { TicketsController } from './tickets.controller';

// Faz 5 Bolum 2: TicketRepository/TicketStateMachine ASLA export edilmez.
// AssignmentsModule bu modulu import eder ve yalniz TICKET_TRANSITION_PORT
// token'ini enjekte eder - dar, transaction-aware bir port.
@Module({
  imports: [MembershipsModule, FacilitiesModule, AuditModule, EventsModule],
  controllers: [TicketsController],
  providers: [
    TicketRepository,
    ContractQueryService,
    TicketAuthorizationPolicy,
    TicketStateMachine,
    TicketDirectTransitionPolicy,
    TicketTransitionService,
    TicketService,
    { provide: TICKET_TRANSITION_PORT, useExisting: TicketTransitionService },
  ],
  exports: [TICKET_TRANSITION_PORT],
})
export class TicketsModule {}
