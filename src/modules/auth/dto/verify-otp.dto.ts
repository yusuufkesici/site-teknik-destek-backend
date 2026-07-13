import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { IsE164Phone } from '../../../common/validators/is-e164-phone.validator';
import { normalizeE164 } from '../../../common/utils/phone.util';

export class VerifyOtpDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normalizeE164(value) ?? value) : value,
  )
  @IsE164Phone()
  phoneNumber!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;

  @IsOptional()
  @IsString()
  deviceId?: string;
}
