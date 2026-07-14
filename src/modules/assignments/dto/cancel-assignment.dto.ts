import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelAssignmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
