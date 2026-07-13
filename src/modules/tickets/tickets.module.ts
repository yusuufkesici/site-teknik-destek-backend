import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { TicketRepository } from './repositories/ticket.repository';
import { ContractQueryService } from './services/contract-query.service';
import { TicketService } from './services/ticket.service';
import { TicketAuthorizationPolicy } from './policies/ticket-authorization.policy';
import { Phase4TicketTransitionPolicy } from './state/phase4-ticket-transition-policy';
import { TicketStateMachine } from './state/ticket-state-machine';
import { TicketsController } from './tickets.controller';

@Module({
  imports: [MembershipsModule, FacilitiesModule, AuditModule, EventsModule],
  controllers: [TicketsController],
  providers: [
    TicketRepository,
    ContractQueryService,
    TicketAuthorizationPolicy,
    TicketStateMachine,
    Phase4TicketTransitionPolicy,
    TicketService,
  ],
})
export class TicketsModule {}
