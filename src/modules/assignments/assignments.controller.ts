import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UserRole } from '../../generated/prisma-client/enums';
import { AddMaterialDto } from './dto/add-material.dto';
import { CancelAssignmentDto } from './dto/cancel-assignment.dto';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { ListMyAssignmentsQueryDto } from './dto/list-my-assignments-query.dto';
import { RejectAssignmentDto } from './dto/reject-assignment.dto';
import { UpdateAssignmentStatusDto } from './dto/update-assignment-status.dto';
import { toAssignmentMaterialResponse } from './mappers/assignment-material.mapper';
import { toAssignmentResponse, toMyAssignmentResponse } from './mappers/assignment.mapper';
import { AssignmentService } from './services/assignment.service';
import { TicketAssignmentWorkflowService } from './services/ticket-assignment-workflow.service';

// Onaylanan Faz 5 plani Bolum 4: controller yalniz HTTP/DTO katmani. Yazma
// islemleri TicketAssignmentWorkflowService'e, okuma islemleri
// AssignmentService'e delege edilir.
@Controller()
export class AssignmentsController {
  constructor(
    private readonly workflow: TicketAssignmentWorkflowService,
    private readonly assignmentService: AssignmentService,
  ) {}

  @Roles(UserRole.OPERATIONS)
  @Post('tickets/:ticketId/assignments')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('ticketId') ticketId: string,
    @Body() dto: CreateAssignmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const created = await this.workflow.assignTechnician(actor, ticketId, dto);
    return toAssignmentResponse(created);
  }

  // Frontend enablement plani E4 (docs/frontend-enablement-plan.md Bolum 3):
  // OPERATIONS'in reassign/cancel akisi icin current assignment kesfi.
  // Diger rollere acilmasi ayri bir urun/PII karari oldugu icin bilinçli
  // olarak yalniz OPERATIONS (plan Bolum 3/E4 gerekcesi).
  @Roles(UserRole.OPERATIONS)
  @Get('tickets/:ticketId/assignments/current')
  async currentForTicket(
    @Param('ticketId') ticketId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const current = await this.assignmentService.getCurrentForTicket(actor, ticketId);
    return toAssignmentResponse(current);
  }

  @Roles(UserRole.TECHNICIAN)
  @Post('assignments/:id/accept')
  async accept(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    const updated = await this.workflow.accept(actor, id);
    return toAssignmentResponse(updated);
  }

  @Roles(UserRole.TECHNICIAN)
  @Post('assignments/:id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectAssignmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.workflow.reject(actor, id, dto);
    return toAssignmentResponse(updated);
  }

  @Roles(UserRole.TECHNICIAN, UserRole.OPERATIONS)
  @Post('assignments/:id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAssignmentStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.workflow.applyStatusEvent(actor, id, dto);
    return toAssignmentResponse(updated);
  }

  // Faz 5 acik karar #1 cozumu: ASSIGNED ticket iptali yalniz OPERATIONS.
  @Roles(UserRole.OPERATIONS)
  @Post('assignments/:id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelAssignmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.workflow.cancelAssignedTicket(actor, id, dto);
    return toAssignmentResponse(updated);
  }

  @Roles(UserRole.TECHNICIAN)
  @Get('assignments/my')
  async listMy(@Query() query: ListMyAssignmentsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    const page = await this.assignmentService.listMy(actor, query);
    return {
      items: page.items.map(toMyAssignmentResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Roles(UserRole.TECHNICIAN, UserRole.OPERATIONS)
  @Post('assignments/:id/materials')
  @HttpCode(HttpStatus.CREATED)
  async addMaterial(
    @Param('id') id: string,
    @Body() dto: AddMaterialDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const created = await this.workflow.addMaterial(actor, id, dto);
    return toAssignmentMaterialResponse(created);
  }

  @Roles(UserRole.TECHNICIAN, UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @Get('assignments/:id/materials')
  async listMaterials(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    const rows = await this.assignmentService.listMaterials(actor, id);
    return rows.map(toAssignmentMaterialResponse);
  }
}
