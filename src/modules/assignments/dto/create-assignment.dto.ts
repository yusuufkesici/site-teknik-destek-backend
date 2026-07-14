import { IsUUID } from 'class-validator';

export class CreateAssignmentDto {
  @IsUUID()
  technicianId!: string;
}
