import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateBlockDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;
}
