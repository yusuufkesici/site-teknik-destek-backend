import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { TicketCategory, TicketUrgency } from '../../../generated/prisma-client/enums';

export class CreateTicketDto {
  @IsUUID()
  facilityId!: string;

  @IsString()
  @Length(5, 150)
  title!: string;

  @IsString()
  @Length(10, 4000)
  description!: string;

  @IsEnum(TicketCategory)
  category!: TicketCategory;

  @IsOptional()
  @IsEnum(TicketUrgency)
  urgency?: TicketUrgency;
}
