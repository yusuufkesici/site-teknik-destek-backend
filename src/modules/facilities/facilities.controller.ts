import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SiteScopeGuard } from '../../common/guards/site-scope.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UserRole } from '../../generated/prisma-client/enums';
import { CreateBlockDto } from './dto/create-block.dto';
import { CreateCommonAreaDto } from './dto/create-common-area.dto';
import { CreateSiteDto } from './dto/create-site.dto';
import { CreateUnitDto } from './dto/create-unit.dto';
import { FacilityService } from './services/facility.service';

// Onaylanan Faz 3 plani Bolum 4: site/blok/daire/ortak-alan olusturma
// yalniz OPERATIONS'a acik (karar #3/#10). Agac goruntuleme SITE_MANAGER +
// OPERATIONS icin, SiteScopeGuard ile tenant kapsamli.
@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly facilityService: FacilityService) {}

  @Roles(UserRole.OPERATIONS)
  @Post('sites')
  @HttpCode(HttpStatus.CREATED)
  async createSite(@Body() dto: CreateSiteDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.facilityService.createSite(dto, actor);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('sites/:siteId/blocks')
  @HttpCode(HttpStatus.CREATED)
  async createBlock(
    @Param('siteId') siteId: string,
    @Body() dto: CreateBlockDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.facilityService.createBlock(siteId, dto, actor);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('blocks/:blockId/units')
  @HttpCode(HttpStatus.CREATED)
  async createUnit(
    @Param('blockId') blockId: string,
    @Body() dto: CreateUnitDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.facilityService.createUnit(blockId, dto, actor);
  }

  @Roles(UserRole.OPERATIONS)
  @Post(':parentId/common-areas')
  @HttpCode(HttpStatus.CREATED)
  async createCommonArea(
    @Param('parentId') parentId: string,
    @Body() dto: CreateCommonAreaDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.facilityService.createCommonArea(parentId, dto, actor);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Get('sites/:siteId/tree')
  async getTree(@Param('siteId') siteId: string) {
    return this.facilityService.getTree(siteId);
  }
}
