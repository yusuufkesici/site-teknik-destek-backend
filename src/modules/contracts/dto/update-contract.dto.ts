import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ContractStatus } from '../../../generated/prisma-client/enums';

// Onaylanan Faz 7 plani Bolum 2 (Revize) / Bolum 12(e): birlesik alan+durum
// PATCH DTO'su. siteId/contractNumber/startDate BILINCLI olarak yoktur
// (immutable; forbidNonWhitelisted=true sayesinde gonderilirse 422).
// terminatedAt client'tan ASLA alinmaz. Alan bazli mutability kurallari
// (endDate/monthlyFee/billingDay/currency yalniz uygun durumlarda) servis
// katmaninda mevcut duruma gore uygulanir.
export class UpdateContractDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate YYYY-MM-DD formatinda olmalidir.' })
  endDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,9}(\.\d{1,2})?$/, {
    message: 'monthlyFee en fazla 2 ondalikli pozitif sayi stringi olmalidir.',
  })
  monthlyFee?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  billingDay?: number;

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

  @IsOptional()
  @IsEnum(ContractStatus)
  status?: ContractStatus;

  // Yalniz hedef durum TERMINATED iken zorunlu ve trim-bos olamaz (plan
  // Bolum 4.2); baska hedeflerle gonderilmesi servis katmaninda 422
  // VALIDATION_ERROR ile reddedilir.
  @ValidateIf((o: UpdateContractDto) => o.status === 'TERMINATED')
  @IsString()
  @Matches(/\S/, { message: 'terminationReason bos olamaz.' })
  @MaxLength(1000)
  terminationReason?: string;
}
