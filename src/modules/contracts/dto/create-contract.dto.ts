import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Onaylanan Faz 7 plani Bolum 6/14: siteId DTO icindedir (POST /contracts,
// route param yok). status ve contractNumber client'tan ALINMAZ - olusturma
// her zaman DRAFT, numara server-side sequence ile uretilir. Para alani
// dogrulanmis string tasinir (AddMaterialDto emsali, negatif isaret regex
// geregi imkansiz). Tarihler @db.Date semantigiyle 'YYYY-MM-DD' formatindadir.
export class CreateContractDto {
  @IsUUID()
  siteId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate YYYY-MM-DD formatinda olmalidir.' })
  startDate!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate YYYY-MM-DD formatinda olmalidir.' })
  endDate!: string;

  @IsString()
  @Matches(/^\d{1,9}(\.\d{1,2})?$/, {
    message: 'monthlyFee en fazla 2 ondalikli pozitif sayi stringi olmalidir.',
  })
  monthlyFee!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  billingDay!: number;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency 3 harfli buyuk harf ISO kodu olmalidir.' })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  serviceScope?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  standardResponseTargetHours?: number;

  @IsOptional()
  @IsBoolean()
  emergencyCoverage?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
