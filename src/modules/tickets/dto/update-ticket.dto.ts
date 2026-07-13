import { IsEnum, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';
import { TicketCategory, TicketUrgency } from '../../../generated/prisma-client/enums';

export class UpdateTicketDto {
  @IsOptional()
  @IsString()
  @Length(5, 150)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(10, 4000)
  description?: string;

  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @IsOptional()
  @IsEnum(TicketUrgency)
  urgency?: TicketUrgency;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  operationNote?: string;

  @IsInt()
  @Min(0)
  version!: number;
}
