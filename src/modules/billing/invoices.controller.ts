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
// doner (ParseUUIDPipe varsayilani 400'dur).
const UUID_PIPE = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });
import { Roles } from '../../common/decorators/roles.decorator';
import { SiteScopeGuard } from '../../common/guards/site-scope.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { UserRole } from '../../generated/prisma-client/enums';
import { ChangeInvoiceStatusDto } from './dto/change-invoice-status.dto';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { toInvoiceResponse } from './mappers/invoice.mapper';
import { InvoiceService } from './services/invoice.service';

// Onaylanan Faz 7 plani Bolum 6/9: yalniz uc endpoint. Mutasyon uclari
// OPERATIONS-only; liste ucu :siteId tasidigi icin SiteScopeGuard ile
// tenant-izole edilir (uniform 404, varlik sizdirilmaz). Site kapsami
// invoice sorgularinda contract.siteId uzerinden uygulanir.
@Controller()
export class InvoicesController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Roles(UserRole.OPERATIONS)
  @Post('contracts/:id/invoices')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('id', UUID_PIPE) contractId: string,
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const created = await this.invoiceService.create(actor, contractId, dto);
    return toInvoiceResponse(created);
  }

  @Roles(UserRole.OPERATIONS)
  @Patch('invoices/:id/status')
  async changeStatus(
    @Param('id', UUID_PIPE) id: string,
    @Body() dto: ChangeInvoiceStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const updated = await this.invoiceService.changeStatus(actor, id, dto);
    return toInvoiceResponse(updated);
  }

  @Roles(UserRole.SITE_MANAGER, UserRole.OPERATIONS)
  @UseGuards(SiteScopeGuard)
  @Get('sites/:siteId/invoices')
  async listForSite(
    @Param('siteId', UUID_PIPE) siteId: string,
    @Query() query: ListInvoicesQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const page = await this.invoiceService.listForSite(actor, siteId, query);
    return {
      items: page.items.map(toInvoiceResponse),
      nextCursor: page.nextCursor,
    };
  }
}
