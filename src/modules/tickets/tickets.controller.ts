import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UserRole } from '../../generated/prisma-client/enums';
import { CancelTicketDto } from './dto/cancel-ticket.dto';
import { ChangeTicketStatusDto } from './dto/change-ticket-status.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { toTicketResponse } from './mappers/ticket.mapper';
import { TicketService } from './services/ticket.service';

// Onaylanan Faz 4 plani Bolum 5: controller yalniz HTTP/DTO katmani, is
// kurali/yetki TicketService + TicketAuthorizationPolicy'de. JwtAuthGuard/
// RolesGuard AuthModule'de APP_GUARD olarak global kayitli.
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketService: TicketService) {}

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateTicketDto, @CurrentUser() actor: AuthenticatedUser) {
    const created = await this.ticketService.create(actor, dto);
    return toTicketResponse(created, actor);
  }

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @Get()
  async list(@Query() query: ListTicketsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    const page = await this.ticketService.list(actor, query);
    return {
      items: page.items.map((row) => toTicketResponse(row, actor)),
      nextCursor: page.nextCursor,
    };
  }

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS, UserRole.TECHNICIAN)
  @Get(':id')
  async findById(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    const ticket = await this.ticketService.findById(actor, id);
    return toTicketResponse(ticket, actor);
  }

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.ticketService.update(actor, id, dto);
    return toTicketResponse(updated, actor);
  }

  // Onaylanan Faz 4 plani Bolum 5: bu fazda yalniz OPERATIONS'a acik,
  // yalniz OPEN->TRIAGED calisir (Phase4TicketTransitionPolicy).
  @Roles(UserRole.OPERATIONS)
  @Post(':id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeTicketStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.ticketService.changeStatus(actor, id, dto);
    return toTicketResponse(updated, actor);
  }

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelTicketDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.ticketService.cancel(actor, id, dto);
    return toTicketResponse(updated, actor);
  }

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS, UserRole.TECHNICIAN)
  @Get(':id/history')
  async history(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.ticketService.listHistory(actor, id);
  }
}
