import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectAssignmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
