import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeactivateSiteMembershipDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
