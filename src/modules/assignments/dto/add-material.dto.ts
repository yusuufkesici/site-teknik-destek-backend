import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { SuppliedBy } from '../../../generated/prisma-client/enums';

// Faz 5 Bolum 8: quantity/unitPrice HTTP katmaninda string olarak alinir ve
// servis katmaninda Prisma.Decimal'e cevrilir - JSON number precision riski
// (ör. float yuvarlama hatasi) tasinmaz. DB kolon hassasiyetiyle uyumlu:
// quantity Decimal(12,3), unitPrice Decimal(12,2).
export class AddMaterialDto {
  @IsUUID()
  materialId!: string;

  @IsString()
  @Matches(/^\d{1,9}(\.\d{1,3})?$/, {
    message: 'quantity gecerli bir ondalik sayi olmalidir (en fazla 3 basamak).',
  })
  quantity!: string;

  @IsString()
  @Matches(/^\d{1,9}(\.\d{1,2})?$/, {
    message: 'unitPrice gecerli bir ondalik sayi olmalidir (en fazla 2 basamak).',
  })
  unitPrice!: string;

  @IsEnum(SuppliedBy)
  suppliedBy!: SuppliedBy;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
