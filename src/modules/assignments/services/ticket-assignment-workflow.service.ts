import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import { DOMAIN_AUDIT_ACTIONS } from '../../../common/constants/domain-audit-actions.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { Prisma } from '../../../generated/prisma-client/client';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/events/outbox.service';
import { MaterialLookupService } from '../../materials/services/material-lookup.service';
import {
  TICKET_TRANSITION_PORT,
  type TicketTransitionPort,
} from '../../tickets/ports/ticket-transition.port';
import type { AddMaterialDto } from '../dto/add-material.dto';
import type { CancelAssignmentDto } from '../dto/cancel-assignment.dto';
import type { CreateAssignmentDto } from '../dto/create-assignment.dto';
import type { RejectAssignmentDto } from '../dto/reject-assignment.dto';
import type { UpdateAssignmentStatusDto } from '../dto/update-assignment-status.dto';
import type { AssignmentMaterialWithMaterialRow } from '../repositories/assignment-material.repository';
import { AssignmentMaterialRepository } from '../repositories/assignment-material.repository';
import type { AssignmentRow } from '../repositories/assignment.repository';
import { AssignmentRepository } from '../repositories/assignment.repository';
import { getAssignmentStatusEventRule } from '../state/assignment-status-event.map';

const ASSIGNABLE_TICKET_STATUSES = ['TRIAGED', 'REJECTED', 'ASSIGNED'] as const;

// Faz 5 Bolum 2/6: tek atomik orkestrator. Ticket + Assignment'i birlikte
// degistiren TUM yazma yollari burada toplanir. Kilit sirasi HER ZAMAN:
// ticket (TICKET_TRANSITION_PORT.lockAndGet) -> current/hedef assignment
// (AssignmentRepository.findByIdForUpdate/findCurrentForUpdate) -> diger
// kayitlar (teknisyen/material lookup).
@Injectable()
export class TicketAssignmentWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TICKET_TRANSITION_PORT) private readonly ticketTransition: TicketTransitionPort,
    private readonly assignmentRepo: AssignmentRepository,
    private readonly assignmentMaterialRepo: AssignmentMaterialRepository,
    private readonly materialLookup: MaterialLookupService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxService,
  ) {}

  async assignTechnician(
    actor: AuthenticatedUser,
    ticketId: string,
    dto: CreateAssignmentDto,
  ): Promise<AssignmentRow> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.ticketTransition.lockAndGet(tx, ticketId);
      if (!ASSIGNABLE_TICKET_STATUSES.includes(ticket.status as never)) {
        throw new DomainError(
          ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION,
          HttpStatus.CONFLICT,
          'Ticket bu durumdan teknisyene atanamaz.',
          { status: ticket.status },
        );
      }

      const current = await this.assignmentRepo.findCurrentForUpdate(tx, ticketId);

      const technician = await this.assignmentRepo.findActiveTechnician(tx, dto.technicianId);
      if (!technician) {
        throw new DomainError(
          ERROR_CODES.ASSIGNMENT_TECHNICIAN_INVALID,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Teknisyen bulunamadi veya aktif degil.',
        );
      }

      const reassigned = current !== null;
      if (current) {
        // Ticket ASSIGNED ise onceki (PENDING/ACCEPTED/ACTIVE) atama
        // REASSIGNED yapilir. Ticket REJECTED ise onceki atama zaten
        // REJECTED - status DEGISTIRILMEZ, yalniz isCurrent kapatilir.
        await this.assignmentRepo.supersede(
          tx,
          current.id,
          ticket.status === 'ASSIGNED' ? 'REASSIGNED' : null,
        );
      }

      const created = await this.assignmentRepo.create(tx, {
        ticketId,
        technicianId: dto.technicianId,
        assignedByUserId: actor.id,
      });

      if (ticket.status !== 'ASSIGNED') {
        await this.ticketTransition.applyStatusTransition(tx, {
          actor,
          ticket,
          toStatus: 'ASSIGNED',
          auditAction: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_CREATED,
        });
      }

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_CREATED,
        actorUserId: actor.id,
        entityType: 'Assignment',
        entityId: created.id,
        siteId: ticket.siteId,
        metadata: { ticketId, technicianId: dto.technicianId, reassigned },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'TechnicianAssigned',
        aggregateType: 'Assignment',
        aggregateId: created.id,
        payload: { ticketId, assignmentId: created.id, technicianId: dto.technicianId, reassigned },
      });

      return created;
    });
  }

  async accept(actor: AuthenticatedUser, assignmentId: string): Promise<AssignmentRow> {
    return this.prisma.$transaction(async (tx) => {
      const ticketId = await this.assignmentRepo.findTicketIdById(tx, assignmentId);
      if (!ticketId) throw this.assignmentNotFound();
      const ticket = await this.ticketTransition.lockAndGet(tx, ticketId);
      const assignment = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (!assignment) throw this.assignmentNotFound();
      if (assignment.technicianId !== actor.id) throw this.assignmentNotFound();
      if (assignment.assignmentStatus !== 'PENDING') throw this.assignmentStatusConflict();

      await this.ticketTransition.applyStatusTransition(tx, {
        actor,
        ticket,
        toStatus: 'ACCEPTED',
        auditAction: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_ACCEPTED,
      });
      const updated = await this.assignmentRepo.markAccepted(tx, assignmentId);

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_ACCEPTED,
        actorUserId: actor.id,
        entityType: 'Assignment',
        entityId: assignmentId,
        siteId: ticket.siteId,
        metadata: { ticketId },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'AssignmentAccepted',
        aggregateType: 'Assignment',
        aggregateId: assignmentId,
        payload: { ticketId, assignmentId, technicianId: actor.id },
      });

      return updated;
    });
  }

  async reject(
    actor: AuthenticatedUser,
    assignmentId: string,
    dto: RejectAssignmentDto,
  ): Promise<AssignmentRow> {
    return this.prisma.$transaction(async (tx) => {
      const ticketId = await this.assignmentRepo.findTicketIdById(tx, assignmentId);
      if (!ticketId) throw this.assignmentNotFound();
      const ticket = await this.ticketTransition.lockAndGet(tx, ticketId);
      const assignment = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (!assignment) throw this.assignmentNotFound();
      if (assignment.technicianId !== actor.id) throw this.assignmentNotFound();
      if (assignment.assignmentStatus !== 'PENDING') throw this.assignmentStatusConflict();

      await this.ticketTransition.applyStatusTransition(tx, {
        actor,
        ticket,
        toStatus: 'REJECTED',
        reason: dto.reason,
        auditAction: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_REJECTED,
      });
      const updated = await this.assignmentRepo.markRejected(tx, assignmentId, dto.reason);

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_REJECTED,
        actorUserId: actor.id,
        entityType: 'Assignment',
        entityId: assignmentId,
        siteId: ticket.siteId,
        metadata: { ticketId, reasonProvided: true },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'AssignmentRejected',
        aggregateType: 'Assignment',
        aggregateId: assignmentId,
        payload: { ticketId, assignmentId, technicianId: actor.id },
      });

      return updated;
    });
  }

  async applyStatusEvent(
    actor: AuthenticatedUser,
    assignmentId: string,
    dto: UpdateAssignmentStatusDto,
  ): Promise<AssignmentRow> {
    if (dto.note !== undefined && dto.event !== 'COMPLETE') {
      throw new DomainError(
        ERROR_CODES.VALIDATION_ERROR,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'note yalniz COMPLETE eventinde kullanilabilir.',
      );
    }
    const rule = getAssignmentStatusEventRule(dto.event);

    return this.prisma.$transaction(async (tx) => {
      const ticketId = await this.assignmentRepo.findTicketIdById(tx, assignmentId);
      if (!ticketId) throw this.assignmentNotFound();
      const ticket = await this.ticketTransition.lockAndGet(tx, ticketId);
      const assignment = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (!assignment) throw this.assignmentNotFound();

      if (actor.role === 'TECHNICIAN' && assignment.technicianId !== actor.id) {
        throw this.assignmentNotFound();
      }
      if (assignment.assignmentStatus !== rule.fromAssignmentStatus) {
        throw this.assignmentStatusConflict();
      }

      await this.ticketTransition.applyStatusTransition(tx, {
        actor,
        ticket,
        toStatus: rule.toTicketStatus,
        auditAction: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_STATUS_CHANGED,
      });

      const updated = await this.assignmentRepo.applyStatusEvent(tx, assignmentId, {
        assignmentStatus: rule.toAssignmentStatus,
        timestampField: rule.timestampField,
        resolutionNote: dto.event === 'COMPLETE' ? dto.note : undefined,
        isCurrent: dto.event === 'COMPLETE' ? false : undefined,
      });

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_STATUS_CHANGED,
        actorUserId: actor.id,
        entityType: 'Assignment',
        entityId: assignmentId,
        siteId: ticket.siteId,
        metadata: { ticketId, event: dto.event },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'AssignmentStatusChanged',
        aggregateType: 'Assignment',
        aggregateId: assignmentId,
        payload: {
          ticketId,
          assignmentId,
          event: dto.event,
          technicianId: assignment.technicianId,
        },
      });

      return updated;
    });
  }

  async cancelAssignedTicket(
    actor: AuthenticatedUser,
    assignmentId: string,
    dto: CancelAssignmentDto,
  ): Promise<AssignmentRow> {
    return this.prisma.$transaction(async (tx) => {
      const ticketId = await this.assignmentRepo.findTicketIdById(tx, assignmentId);
      if (!ticketId) throw this.assignmentNotFound();
      const ticket = await this.ticketTransition.lockAndGet(tx, ticketId);
      if (ticket.status !== 'ASSIGNED') {
        throw new DomainError(
          ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION,
          HttpStatus.CONFLICT,
          'Ticket bu durumda iptal edilemez.',
          { status: ticket.status },
        );
      }

      const assignment = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (
        !assignment ||
        !(['PENDING', 'ACCEPTED', 'ACTIVE'] as const).includes(assignment.assignmentStatus as never)
      ) {
        throw this.assignmentStatusConflict();
      }

      const updated = await this.assignmentRepo.markCancelled(tx, assignmentId);
      await this.ticketTransition.applyStatusTransition(tx, {
        actor,
        ticket,
        toStatus: 'CANCELLED',
        reason: dto.reason,
        auditAction: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
      });

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
        actorUserId: actor.id,
        entityType: 'Assignment',
        entityId: assignmentId,
        siteId: ticket.siteId,
        metadata: { ticketId, reasonProvided: true },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'AssignmentCancelled',
        aggregateType: 'Assignment',
        aggregateId: assignmentId,
        payload: { ticketId, assignmentId, technicianId: assignment.technicianId },
      });

      return updated;
    });
  }

  async addMaterial(
    actor: AuthenticatedUser,
    assignmentId: string,
    dto: AddMaterialDto,
  ): Promise<AssignmentMaterialWithMaterialRow> {
    return this.prisma.$transaction(async (tx) => {
      const ticketId = await this.assignmentRepo.findTicketIdById(tx, assignmentId);
      if (!ticketId) throw this.assignmentNotFound();
      const ticket = await this.ticketTransition.lockAndGet(tx, ticketId);
      const assignment = await this.assignmentRepo.findByIdForUpdate(tx, assignmentId);
      if (!assignment) throw this.assignmentNotFound();

      if (actor.role === 'TECHNICIAN' && assignment.technicianId !== actor.id) {
        throw this.assignmentNotFound();
      }
      if (assignment.assignmentStatus !== 'ACTIVE') {
        throw new DomainError(
          ERROR_CODES.ASSIGNMENT_MATERIAL_NOT_ALLOWED,
          HttpStatus.CONFLICT,
          'Bu assignment durumunda malzeme eklenemez.',
        );
      }

      await this.materialLookup.assertActiveMaterial(tx, dto.materialId);

      const quantity = new Prisma.Decimal(dto.quantity);
      if (quantity.lessThanOrEqualTo(0)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'quantity sifirdan buyuk olmalidir.',
        );
      }
      const unitPrice = new Prisma.Decimal(dto.unitPrice);
      const totalPrice = quantity.mul(unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

      const created = await this.assignmentMaterialRepo.create(tx, {
        assignmentId,
        materialId: dto.materialId,
        quantity,
        unitPrice,
        totalPrice,
        suppliedBy: dto.suppliedBy,
        note: dto.note,
        createdByUserId: actor.id,
      });

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.MATERIAL_ADDED,
        actorUserId: actor.id,
        entityType: 'AssignmentMaterial',
        entityId: created.id,
        siteId: ticket.siteId,
        metadata: { ticketId, assignmentId, materialId: dto.materialId },
      });

      await this.outbox.publishInTx(tx, {
        eventType: 'AssignmentMaterialAdded',
        aggregateType: 'AssignmentMaterial',
        aggregateId: created.id,
        payload: {
          ticketId,
          assignmentId,
          materialId: dto.materialId,
          // toFixed(n) kullanilir - decimal.js toString() sondaki sifirlari
          // kirpar (ör. "37.50" -> "37.5"), DB kolon hassasiyeti korunmaz.
          quantity: quantity.toFixed(3),
          unitPrice: unitPrice.toFixed(2),
          totalPrice: totalPrice.toFixed(2),
        },
      });

      return created;
    });
  }

  private assignmentNotFound(): never {
    throw new DomainError(
      ERROR_CODES.ASSIGNMENT_NOT_FOUND,
      HttpStatus.NOT_FOUND,
      'Assignment bulunamadi.',
    );
  }

  private assignmentStatusConflict(): never {
    throw new DomainError(
      ERROR_CODES.ASSIGNMENT_STATUS_CONFLICT,
      HttpStatus.CONFLICT,
      'Assignment bu islem icin uygun durumda degil.',
    );
  }
}
