import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
