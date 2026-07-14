import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AttachmentType } from '../../../generated/prisma-client/enums';

export class UploadAttachmentDto {
  @IsEnum(AttachmentType)
  attachmentType!: AttachmentType;

  @IsOptional()
  @IsUUID()
  assignmentId?: string;
}
