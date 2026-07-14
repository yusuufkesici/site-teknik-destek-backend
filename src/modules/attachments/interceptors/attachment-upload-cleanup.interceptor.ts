import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { catchError, from, mergeMap, Observable, of, throwError } from 'rxjs';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../../infrastructure/storage/storage-provider.interface';

interface RequestWithUploadedFile extends Request {
  file?: Express.Multer.File;
}

// Onaylanan Faz 6 plani Bolum 8: DTO/ValidationPipe hatasi (bilinmeyen
// multipart alani, gecersiz UUID/attachmentType), controller/service
// hatasi gibi next.handle() zincirinde olusan HERHANGI bir hatada temp
// dosyayi temizleyen safety-net. HTTP eslemesi burada YAPILMAZ - yalniz
// GlobalExceptionFilter'in isleyecegi orijinal hata degismeden yeniden
// firlatilir. Cleanup idempotent (StorageProvider.deleteTemp ENOENT'i
// yutar) - AttachmentService kendi cleanup'ini zaten yapmis olsa da bu
// interceptor'in ikinci cagrisi guvenlidir.
@Injectable()
export class AttachmentUploadCleanupInterceptor implements NestInterceptor {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const request = context.switchToHttp().getRequest<RequestWithUploadedFile>();
        const tempPath = request.file?.path;
        if (!tempPath) {
          return throwError(() => error);
        }

        return from(this.storage.deleteTemp(tempPath)).pipe(
          catchError(() => of(undefined)),
          mergeMap(() => throwError(() => error)),
        );
      }),
    );
  }
}
