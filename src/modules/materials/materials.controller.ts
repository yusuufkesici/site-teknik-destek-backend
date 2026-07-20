import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../generated/prisma-client/enums';
import { ListMaterialsQueryDto } from './dto/list-materials-query.dto';
import { toMaterialResponse } from './mappers/material.mapper';
import { MaterialLookupService } from './services/material-lookup.service';

// Frontend enablement plani E3 (docs/frontend-enablement-plan.md Bolum 3):
// yalniz salt-okunur aktif katalog listesi. Malzemeyi ekleyebilen roller
// (TECHNICIAN + OPERATIONS, bkz. assignments.controller.ts addMaterial)
// katalogu gorebilir. Tenant kapsami yoktur - Material site'a bagli olmayan
// sirket katalogudur. JwtAuthGuard/RolesGuard AuthModule'de APP_GUARD olarak
// global kayitli.
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materialLookup: MaterialLookupService) {}

  @Roles(UserRole.TECHNICIAN, UserRole.OPERATIONS)
  @Get()
  async list(@Query() query: ListMaterialsQueryDto) {
    const page = await this.materialLookup.listActiveCatalog(query);
    return {
      items: page.items.map(toMaterialResponse),
      nextCursor: page.nextCursor,
    };
  }
}
