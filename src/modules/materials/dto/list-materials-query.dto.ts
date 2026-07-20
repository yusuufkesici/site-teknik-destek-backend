import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// Frontend enablement plani E3 (docs/frontend-enablement-plan.md Bolum 3):
// yalniz cursor/limit - isActive gibi filtre parametreleri BILINCLI olarak
// yoktur, katalog her zaman yalniz aktif kayitlari doner.
export class ListMaterialsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
