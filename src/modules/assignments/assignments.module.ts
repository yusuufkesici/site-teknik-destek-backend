import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { MaterialsModule } from '../materials/materials.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AssignmentsController } from './assignments.controller';
import { AssignmentAuthorizationPolicy } from './policies/assignment-authorization.policy';
import { AssignmentMaterialRepository } from './repositories/assignment-material.repository';
import { AssignmentRepository } from './repositories/assignment.repository';
import { AssignmentService } from './services/assignment.service';
import { TicketAssignmentWorkflowService } from './services/ticket-assignment-workflow.service';

// Faz 5 Bolum 2: tek yonlu bagimlilik - AssignmentsModule TicketsModule ve
// MaterialsModule'u import eder, tersi asla olmaz. TicketRepository/
// MaterialRepository asla dogrudan enjekte edilmez, yalniz TicketsModule'un
// export ettigi TICKET_TRANSITION_PORT ve MaterialsModule'un export ettigi
// MaterialLookupService kullanilir.
@Module({
  imports: [TicketsModule, MaterialsModule, MembershipsModule, AuditModule, EventsModule],
  controllers: [AssignmentsController],
  providers: [
    AssignmentRepository,
    AssignmentMaterialRepository,
    AssignmentAuthorizationPolicy,
    AssignmentService,
    TicketAssignmentWorkflowService,
  ],
})
export class AssignmentsModule {}
