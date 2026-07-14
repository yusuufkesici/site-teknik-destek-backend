import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERROR_CODES } from '../../../common/constants/error-codes.constant';
import {
  DOMAIN_AUDIT_ACTIONS,
  type DomainAuditAction,
} from '../../../common/constants/domain-audit-actions.constant';
import { DomainError } from '../../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import {
  buildPage,
  decodeCursor,
  type PaginatedResult,
} from '../../../common/utils/pagination.util';
import type { TicketSource, TicketStatus, UserRole } from '../../../generated/prisma-client/enums';
import { AuditWriter } from '../../../infrastructure/audit/audit-writer.service';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/events/outbox.service';
import { FacilityRepository } from '../../facilities/repositories/facility.repository';
import { MembershipQueryService } from '../../memberships/membership-query.service';
import type { CancelTicketDto } from '../dto/cancel-ticket.dto';
import type { ChangeTicketStatusDto } from '../dto/change-ticket-status.dto';
import type { CreateTicketDto } from '../dto/create-ticket.dto';
import type { ListTicketsQueryDto } from '../dto/list-tickets-query.dto';
import type { UpdateTicketDto } from '../dto/update-ticket.dto';
import { TicketAuthorizationPolicy } from '../policies/ticket-authorization.policy';
import type { TicketListFilter, TicketRow } from '../repositories/ticket.repository';
import { TicketRepository } from '../repositories/ticket.repository';
import { TicketDirectTransitionPolicy } from '../state/ticket-direct-transition.policy';
import { TicketStateMachine } from '../state/ticket-state-machine';
import { ContractQueryService } from './contract-query.service';
import { computeSlaTargetAt } from './sla.util';
import { TicketTransitionService } from './ticket-transition.service';

const DEFAULT_PAGE_LIMIT = 20;

function sourceFromRole(role: UserRole): TicketSource {
  if (role === 'RESIDENT') return 'RESIDENT';
  if (role === 'SITE_MANAGER') return 'SITE_MANAGER';
  return 'OPERATIONS';
}

// Onaylanan Faz 4 plani Bolum 10-12: her yazma islemi tek transaction'da
// history/audit/outbox'iyla birlikte yazilir; yetki/entitlement kontrolleri
// transaction disinda yapilir.
@Injectable()
export class TicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketRepo: TicketRepository,
    private readonly facilityRepo: FacilityRepository,
    private readonly policy: TicketAuthorizationPolicy,
    private readonly stateMachine: TicketStateMachine,
    private readonly directPolicy: TicketDirectTransitionPolicy,
    private readonly ticketTransition: TicketTransitionService,
    private readonly contractQuery: ContractQueryService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
    private readonly membershipQuery: MembershipQueryService,
  ) {}

  async create(actor: AuthenticatedUser, dto: CreateTicketDto): Promise<TicketRow> {
    const facility = await this.facilityRepo.findAliveById(this.prisma, dto.facilityId);
    if (!facility || facility.type === 'SITE' || !facility.siteId) {
      throw new DomainError(
        ERROR_CODES.FACILITY_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Facility bulunamadi.',
      );
    }
    const siteId = facility.siteId;

    await this.policy.assertCanCreate(actor, facility, this.prisma);

    // Duzeltme #3: tarih araligi + status=ACTIVE birlikte (DB CURRENT_DATE).
    const contract = await this.contractQuery.findActiveForSite(siteId, this.prisma);
    if (!contract) {
      throw new DomainError(
        ERROR_CODES.TICKET_SITE_CONTRACT_INACTIVE,
        HttpStatus.CONFLICT,
        'Bu site icin aktif sozlesme yok.',
      );
    }

    const createdAt = new Date();
    const urgency = dto.urgency ?? 'STANDARD';
    const emergencySlaHours = this.config.getOrThrow<number>('tickets.emergencySlaHours');
    const slaTargetAt = computeSlaTargetAt(createdAt, urgency, contract, emergencySlaHours);
    const source = sourceFromRole(actor.role);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.ticketRepo.nextCode(tx);
      const created = await this.ticketRepo.create(tx, {
        code,
        createdByUserId: actor.id,
        siteId,
        facilityId: facility.id,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        urgency,
        source,
        slaTargetAt,
        createdAt,
      });

      await this.ticketRepo.addHistory(tx, {
        ticketId: created.id,
        previousStatus: null,
        newStatus: 'OPEN',
        changedByUserId: actor.id,
      });

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.TICKET_CREATED,
        actorUserId: actor.id,
        entityType: 'Ticket',
        entityId: created.id,
        siteId,
        metadata: { category: dto.category, urgency },
      });

      await this.outbox.publishInTx(tx, {
        eventType: urgency === 'EMERGENCY' ? 'EmergencyTicketCreated' : 'TicketCreated',
        aggregateType: 'Ticket',
        aggregateId: created.id,
        payload: {
          ticketId: created.id,
          ticketCode: created.code,
          siteId,
          facilityId: facility.id,
          category: created.category,
          urgency,
          createdByUserId: actor.id,
        },
      });

      return created;
    });
  }

  async findById(actor: AuthenticatedUser, ticketId: string): Promise<TicketRow> {
    const ticket = await this.ticketRepo.findAliveById(this.prisma, ticketId);
    if (!ticket) {
      throw new DomainError(
        ERROR_CODES.TICKET_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket bulunamadi.',
      );
    }
    await this.policy.assertCanRead(actor, ticket, this.prisma);
    return ticket;
  }

  // Duzeltme #9: siteId verilirse site'in gercekten var oldugu her rol
  // icin acikca dogrulanir; bilinmeyen siteId sessizce bos liste donmez.
  async list(
    actor: AuthenticatedUser,
    query: ListTicketsQueryDto,
  ): Promise<PaginatedResult<TicketRow>> {
    let cursor = null;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Gecersiz cursor.',
        );
      }
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

    let filter: TicketListFilter;
    if (actor.role === 'RESIDENT') {
      filter = { scope: 'RESIDENT', residentId: actor.id, cursor, limit };
    } else if (actor.role === 'SITE_MANAGER') {
      if (!query.siteId) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_ERROR,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'siteId zorunludur.',
        );
      }
      await this.assertSiteExists(query.siteId);
      const isManager = await this.membershipQuery.hasActiveManagerMembership(
        actor.id,
        query.siteId,
      );
      if (!isManager) {
        throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
      }
      filter = {
        scope: 'SITE_MANAGER',
        siteId: query.siteId,
        status: query.status,
        urgency: query.urgency,
        cursor,
        limit,
      };
    } else if (actor.role === 'OPERATIONS') {
      if (query.siteId) {
        await this.assertSiteExists(query.siteId);
      }
      filter = {
        scope: 'OPERATIONS',
        siteId: query.siteId,
        status: query.status,
        urgency: query.urgency,
        cursor,
        limit,
      };
    } else {
      // TECHNICIAN: Faz 4'te liste ucu desteklenmiyor (Bolum 3 karar #7).
      throw new DomainError(
        ERROR_CODES.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Bu role liste erisimi yok.',
      );
    }

    const rows = await this.ticketRepo.list(this.prisma, filter);
    return buildPage(rows, limit);
  }

  async listHistory(actor: AuthenticatedUser, ticketId: string) {
    const ticket = await this.ticketRepo.findAliveById(this.prisma, ticketId);
    if (!ticket) {
      throw new DomainError(
        ERROR_CODES.TICKET_NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'Ticket bulunamadi.',
      );
    }
    await this.policy.assertCanRead(actor, ticket, this.prisma);
    return this.ticketRepo.listHistory(this.prisma, ticketId);
  }

  async update(
    actor: AuthenticatedUser,
    ticketId: string,
    dto: UpdateTicketDto,
  ): Promise<TicketRow> {
    // Duzeltme #6: version disinda hicbir alan yoksa erken reddet, DB'ye hic gidilmez.
    const changedFields = (
      ['title', 'description', 'category', 'urgency', 'operationNote'] as const
    ).filter((field) => dto[field] !== undefined);
    if (changedFields.length === 0) {
      throw new DomainError(
        ERROR_CODES.TICKET_UPDATE_EMPTY,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Guncellenecek en az bir alan gonderilmelidir.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.ticketRepo.findByIdForUpdate(tx, ticketId);
      if (!ticket) {
        throw new DomainError(
          ERROR_CODES.TICKET_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Ticket bulunamadi.',
        );
      }

      await this.policy.assertCanRead(actor, ticket, tx);
      this.policy.assertCanUpdateFields(actor, ticket, dto);

      if (ticket.version !== dto.version) {
        throw new DomainError(
          ERROR_CODES.CONCURRENT_MODIFICATION,
          HttpStatus.CONFLICT,
          'Ticket baska bir islemle guncellenmis, yeniden okuyup deneyin.',
        );
      }

      // Duzeltme #5: urgency GERCEKTEN degisirse (ayni deger tekrar
      // gonderilirse degil) SLA, ticket.createdAt baz alinarak AYNI
      // transaction icinde taze bir sozlesme sorgusuyla yeniden hesaplanir.
      let slaTargetAt: Date | null | undefined;
      if (dto.urgency !== undefined && dto.urgency !== ticket.urgency) {
        const contract = await this.contractQuery.findActiveForSite(ticket.siteId, tx);
        const emergencySlaHours = this.config.getOrThrow<number>('tickets.emergencySlaHours');
        slaTargetAt = computeSlaTargetAt(
          ticket.createdAt,
          dto.urgency,
          contract,
          emergencySlaHours,
        );
      }

      const updated = await this.ticketRepo.updateFields(tx, ticketId, ticket.version, {
        title: dto.title,
        description: dto.description,
        category: dto.category,
        urgency: dto.urgency,
        operationNote: dto.operationNote,
        ...(slaTargetAt !== undefined ? { slaTargetAt } : {}),
      });
      if (!updated) {
        throw new DomainError(
          ERROR_CODES.CONCURRENT_MODIFICATION,
          HttpStatus.CONFLICT,
          'Ticket baska bir islemle guncellenmis, yeniden okuyup deneyin.',
        );
      }

      await this.audit.log(tx, {
        action: DOMAIN_AUDIT_ACTIONS.TICKET_UPDATED,
        actorUserId: actor.id,
        entityType: 'Ticket',
        entityId: ticketId,
        siteId: ticket.siteId,
        metadata: { changedFields },
      });

      return updated;
    });
  }

  async changeStatus(
    actor: AuthenticatedUser,
    ticketId: string,
    dto: ChangeTicketStatusDto,
  ): Promise<TicketRow> {
    return this.applyTransition(
      actor,
      ticketId,
      dto.toStatus,
      dto.reason,
      DOMAIN_AUDIT_ACTIONS.TICKET_STATUS_CHANGED,
    );
  }

  async cancel(
    actor: AuthenticatedUser,
    ticketId: string,
    dto: CancelTicketDto,
  ): Promise<TicketRow> {
    return this.applyTransition(
      actor,
      ticketId,
      'CANCELLED',
      dto.reason,
      DOMAIN_AUDIT_ACTIONS.TICKET_CANCELLED,
    );
  }

  private async applyTransition(
    actor: AuthenticatedUser,
    ticketId: string,
    toStatus: TicketStatus,
    reason: string | undefined,
    auditAction: DomainAuditAction,
  ): Promise<TicketRow> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.ticketRepo.findByIdForUpdate(tx, ticketId);
      if (!ticket) {
        throw new DomainError(
          ERROR_CODES.TICKET_NOT_FOUND,
          HttpStatus.NOT_FOUND,
          'Ticket bulunamadi.',
        );
      }

      await this.policy.assertCanRead(actor, ticket, tx);

      // Onemli sira (Faz 5'te korunuyor): ONCE stateMachine.assertTransition -
      // bu, from===to durumunu 409 TICKET_STATUS_UNCHANGED olarak dogru
      // siniflandirir (implementation-overrides.md #9). Eger directPolicy
      // once calisirsa, ornegin ticket zaten TRIAGED iken tekrar
      // toStatus=TRIAGED gonderilirse (TRIAGED->TRIAGED ciftinin kendisi
      // allowlist'te OLMADIGI icin) yanlislikla
      // TICKET_INVALID_STATUS_TRANSITION donerdi. stateMachine'den SONRA
      // directPolicy.assertAllowedDirectly cagrilir - genel ticket ucunun
      // kosulsuz siniri hala tam korunur, cunku hicbir DB yazimi bu iki
      // kontrolden once gerceklesmez: ASSIGNED->CANCELLED gibi assignment'a
      // ait gecisler (state machine ilgili role izin verse bile)
      // directPolicy tarafindan mutasyondan ONCE kesilir - yalniz
      // TicketAssignmentWorkflowService bu gecisleri yapabilir.
      this.stateMachine.assertTransition(ticket.status, toStatus, actor.role, reason);
      this.directPolicy.assertAllowedDirectly(ticket.status, toStatus);

      return this.ticketTransition.applyStatusTransition(tx, {
        actor,
        ticket,
        toStatus,
        reason,
        auditAction,
      });
    });
  }

  private async assertSiteExists(siteId: string): Promise<void> {
    const site = await this.facilityRepo.findAliveById(this.prisma, siteId);
    if (!site || site.type !== 'SITE') {
      throw new DomainError(ERROR_CODES.SITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Site bulunamadi.');
    }
  }
}
