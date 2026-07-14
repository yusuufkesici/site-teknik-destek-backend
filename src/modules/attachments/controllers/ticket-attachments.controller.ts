import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { UserRole } from '../../../generated/prisma-client/enums';
import { ListAttachmentsQueryDto } from '../dto/list-attachments-query.dto';
import { UploadAttachmentDto } from '../dto/upload-attachment.dto';
import { AttachmentUploadCleanupInterceptor } from '../interceptors/attachment-upload-cleanup.interceptor';
import { toAttachmentResponse } from '../mappers/attachment.mapper';
import { AttachmentService } from '../services/attachment.service';

// Onaylanan Faz 6 plani Bolum 4/6: upload/list bu controller'da, download
// ayri bir controller'da (attachment-download.controller.ts) ust seviye
// /attachments/:id/download altinda - controller yalniz HTTP/DTO katmani,
// is kurali AttachmentService + AttachmentAuthorizationPolicy'de.
@Controller('tickets/:ticketId/attachments')
export class TicketAttachmentsController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS, UserRole.TECHNICIAN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'), AttachmentUploadCleanupInterceptor)
  async upload(
    @Param('ticketId') ticketId: string,
    @Body() dto: UploadAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const created = await this.attachmentService.upload(actor, ticketId, dto, file);
    return toAttachmentResponse(created);
  }

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS, UserRole.TECHNICIAN)
  @Get()
  async list(
    @Param('ticketId') ticketId: string,
    @Query() query: ListAttachmentsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const page = await this.attachmentService.list(actor, ticketId, query);
    return {
      items: page.items.map(toAttachmentResponse),
      nextCursor: page.nextCursor,
    };
  }
}
