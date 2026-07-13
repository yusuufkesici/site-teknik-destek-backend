import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { normalizeE164 } from '../../../common/utils/phone.util';
import { IsE164Phone } from '../../../common/validators/is-e164-phone.validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normalizeE164(value) ?? value) : value,
  )
  @IsE164Phone()
  phoneNumber?: string;
}
