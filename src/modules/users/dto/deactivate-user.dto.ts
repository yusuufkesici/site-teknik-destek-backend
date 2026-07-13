import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeactivateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
