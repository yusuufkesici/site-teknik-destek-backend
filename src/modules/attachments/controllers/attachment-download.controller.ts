import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { UserRole } from '../../../generated/prisma-client/enums';
import { AttachmentService } from '../services/attachment.service';

// Onaylanan Faz 6 plani Bolum 6/10: ticketId path param'i YOK - metadata'dan
// bulunur, parent ticket uzerinden yetki tekrar dogrulanir (AttachmentService
// icinde). Local storage'ta native presigned URL karsiligi olmadigindan
// dogrudan authenticated stream endpoint'i tercih edildi (signed URL degil).
function encodeContentDisposition(originalFileName: string): string {
  // RFC 5987: hem ascii-fallback hem UTF-8 encoded varyant - header
  // injection'a karsi yalniz yazdirilabilir ASCII karakterler birebir kopyalanir.
  const asciiFallback = originalFileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const encoded = encodeURIComponent(originalFileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

@Controller('attachments')
export class AttachmentDownloadController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Roles(UserRole.RESIDENT, UserRole.SITE_MANAGER, UserRole.OPERATIONS, UserRole.TECHNICIAN)
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const { attachment, stream } = await this.attachmentService.openDownloadStream(actor, id);

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', attachment.fileSize);
    res.setHeader('Content-Disposition', encodeContentDisposition(attachment.originalFileName));
    res.setHeader('X-Content-Type-Options', 'nosniff');

    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  }
}
