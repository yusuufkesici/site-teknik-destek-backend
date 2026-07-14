import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { MAX_FILE_SIZE_BYTES } from '../../common/constants/attachment.constant';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { EventsModule } from '../../infrastructure/events/events.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AttachmentDownloadController } from './controllers/attachment-download.controller';
import { TicketAttachmentsController } from './controllers/ticket-attachments.controller';
import { AttachmentUploadCleanupInterceptor } from './interceptors/attachment-upload-cleanup.interceptor';
import { AttachmentAuthorizationPolicy } from './policies/attachment-authorization.policy';
import { TicketAttachmentRepository } from './repositories/ticket-attachment.repository';
import { AttachmentService } from './services/attachment.service';

// Onaylanan Faz 6 plani Bolum 3: tek yonlu bagimlilik - AttachmentsModule
// TicketsModule ve AssignmentsModule'u import eder, tersi asla olmaz.
// TicketRepository/AssignmentRepository asla dogrudan enjekte edilmez,
// yalniz bu modullerin export ettigi TicketReadAccessService ve
// AssignmentLookupService kullanilir. Multer konfigurasyonu DI-uyumlu
// (MulterModule.registerAsync) - FileInterceptor icinde dogrudan
// ConfigService kullanilmaz (Bolum 5/8).
@Module({
  imports: [
    TicketsModule,
    AssignmentsModule,
    AuditModule,
    EventsModule,
    StorageModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const localPath = config.getOrThrow<string>('storage.localPath');
        const tempDir = path.join(localPath, 'tmp');

        return {
          storage: diskStorage({
            destination: (_req, _file, callback) => {
              mkdir(tempDir, { recursive: true })
                .then(() => callback(null, tempDir))
                .catch((error: unknown) => callback(error as Error, tempDir));
            },
            filename: (_req, _file, callback) => callback(null, randomUUID()),
          }),
          limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
        };
      },
    }),
  ],
  controllers: [TicketAttachmentsController, AttachmentDownloadController],
  providers: [
    TicketAttachmentRepository,
    AttachmentAuthorizationPolicy,
    AttachmentService,
    AttachmentUploadCleanupInterceptor,
  ],
})
export class AttachmentsModule {}
