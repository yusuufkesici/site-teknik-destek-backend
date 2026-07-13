import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';
import { IsE164Phone } from '../../../common/validators/is-e164-phone.validator';
import { normalizeE164 } from '../../../common/utils/phone.util';

export class RequestOtpDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normalizeE164(value) ?? value) : value,
  )
  @IsE164Phone()
  phoneNumber!: string;
}
