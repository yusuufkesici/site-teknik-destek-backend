import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

// Gecersiz UUID, projenin genel dogrulama sozlesmesiyle tutarli olarak 422
// doner (global ValidationPipe errorHttpStatusCode ile ayni; ParseUUIDPipe
// varsayilani 400'dur). GlobalExceptionFilter 422'yi VALIDATION_ERROR'a esler.
const UUID_PIPE = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });
import { Roles } from '../../common/decorators/roles.decorator';
import { SiteScopeGuard } from '../../common/guards/site-scope.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UserRole } from '../../generated/prisma-client/enums';
import { CreateContractDto } from './dto/create-contract.dto';
import { ListContractsQueryDto } from './dto/list-contracts-query.dto';
import { UpdateContractDto } from './dto/update-contract.dto';
import { toContractResponse } from './mappers/contract.mapper';
import { ContractService } from './services/contract.service';

// Onaylanan Faz 7 plani Bolum 6/9: yalniz uc endpoint. POST/PATCH
// OPERATIONS-only (403 rol hatasi RolesGuard'da); liste ucu :siteId tasidigi
// icin SiteScopeGuard ile tenant-izole edilir (yetkisiz erisim uniform 404
// SITE_NOT_FOUND, varlik sizdirilmaz). Ek policy/guard sinifi gerekmez -
// ID'li mutasyon uclari zaten OPERATIONS-only oldugundan IDOR yuzeyi yoktur.
@Controller()
export class ContractsController {
  constructor(private readonly contractService: ContractService) {}

  @Roles(UserRole.OPERATIONS)
  @Post('contracts')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateContractDto, @CurrentUser() actor: AuthenticatedUser) {
    const created = await this.contractService.create(actor, dto);
    return toContractResponse(created);
  }

  @Roles(UserRole.OPERATIONS)
  @Patch('contracts/:id')
  async update(
    @Param('id', UUID_PIPE) id: string,
    @Body() dto: UpdateContractDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.contractService.update(actor, id, dto);
    return toContractResponse(updated);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Get('sites/:siteId/contracts')
  async listForSite(
    @Param('siteId', UUID_PIPE) siteId: string,
    @Query() query: ListContractsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const page = await this.contractService.listForSite(actor, siteId, query);
    return {
      items: page.items.map(toContractResponse),
      nextCursor: page.nextCursor,
    };
  }
}
