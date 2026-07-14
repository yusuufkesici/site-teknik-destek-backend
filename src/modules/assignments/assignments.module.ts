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
import { AssignmentLookupService } from './services/assignment-lookup.service';
import { AssignmentService } from './services/assignment.service';
import { TicketAssignmentWorkflowService } from './services/ticket-assignment-workflow.service';

// Faz 5 Bolum 2: tek yonlu bagimlilik - AssignmentsModule TicketsModule ve
// MaterialsModule'u import eder, tersi asla olmaz. TicketRepository/
// MaterialRepository asla dogrudan enjekte edilmez, yalniz TicketsModule'un
// export ettigi TICKET_TRANSITION_PORT ve MaterialsModule'un export ettigi
// MaterialLookupService kullanilir. Faz 6 Bolum 3: AttachmentsModule icin
// ayni desende AssignmentLookupService export edilir - AssignmentRepository
// yine dogrudan export edilmez.
@Module({
  imports: [TicketsModule, MaterialsModule, MembershipsModule, AuditModule, EventsModule],
  controllers: [AssignmentsController],
  providers: [
    AssignmentRepository,
    AssignmentMaterialRepository,
    AssignmentAuthorizationPolicy,
    AssignmentService,
    TicketAssignmentWorkflowService,
    AssignmentLookupService,
  ],
  exports: [AssignmentLookupService],
})
export class AssignmentsModule {}
