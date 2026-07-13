import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { normalizeE164 } from '../../../common/utils/phone.util';
import { IsE164Phone } from '../../../common/validators/is-e164-phone.validator';

export class CreateResidentDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normalizeE164(value) ?? value) : value,
  )
  @IsE164Phone()
  phoneNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @IsUUID()
  unitId!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
