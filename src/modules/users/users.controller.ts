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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SiteScopeGuard } from '../../common/guards/site-scope.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UserRole } from '../../generated/prisma-client/enums';
import { CreateResidentDto } from './dto/create-resident.dto';
import { DeactivateSiteMembershipDto } from './dto/deactivate-site-membership.dto';
import { DeactivateUserDto } from './dto/deactivate-user.dto';
import { ListSiteUsersQueryDto } from './dto/list-site-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { type MyUnitResponse, toMyUnitResponse } from './mappers/my-unit.mapper';
import { toTechnicianSummaryResponse } from './mappers/technician-summary.mapper';
import { UsersService } from './services/users.service';

// Onaylanan Faz 3 plani Bolum 4: tek controller icinde hem site-scoped hem
// global rotalar - tenant kapsami rota bazinda SiteScopeGuard ile uygulanir.
// Frontend enablement plani (docs/frontend-enablement-plan.md): statik
// 'users/technicians' ve 'users/me/units' rotalari, ileride olasi bir
// 'users/:id' GET rotasiyla cakismamalari icin SINIFIN BASINDA bildirilir
// (savunmaci sira - bugun GET /users/:id yoktur).
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Frontend enablement plani E2: yalniz OPERATIONS - atama yetkisi kimdeyse
  // kesif listesi de ondadir. Telefon numarasi bilincli olarak donmez.
  @Roles(UserRole.OPERATIONS)
  @Get('users/technicians')
  async listTechnicians() {
    const rows = await this.usersService.listActiveTechnicians();
    return rows.map(toTechnicianSummaryResponse);
  }

  // Frontend enablement plani E1: cagiranin KENDI aktif unit kayitlari.
  // Kayit yoksa bos liste (200) doner - 404 degil.
  @Roles(UserRole.RESIDENT)
  @Get('users/me/units')
  async listMyUnits(@CurrentUser() actor: AuthenticatedUser): Promise<MyUnitResponse[]> {
    const rows = await this.usersService.listMyUnits(actor);
    return rows
      .map(toMyUnitResponse)
      .filter((response): response is MyUnitResponse => response !== null);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Post('sites/:siteId/residents')
  @HttpCode(HttpStatus.CREATED)
  async onboardResident(
    @Param('siteId') siteId: string,
    @Body() dto: CreateResidentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.onboardResident(siteId, dto, actor);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Get('sites/:siteId/users')
  async listSiteUsers(@Param('siteId') siteId: string, @Query() query: ListSiteUsersQueryDto) {
    return this.usersService.listBySite(siteId, query);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @Patch('users/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.update(id, dto, actor);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Post('sites/:siteId/users/:userId/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivateSiteMembership(
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
    @Body() dto: DeactivateSiteMembershipDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    await this.usersService.deactivateSiteMembership(siteId, userId, dto.reason, actor);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('users/:id/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivateGlobally(
    @Param('id') id: string,
    @Body() dto: DeactivateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    await this.usersService.deactivateGlobally(id, dto.reason, actor);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Post('sites/:siteId/units/:unitId/assignments/:assignmentId/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivateAssignment(
    @Param('siteId') siteId: string,
    @Param('unitId') unitId: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    await this.usersService.deactivateAssignment(siteId, unitId, assignmentId, actor);
  }
}
