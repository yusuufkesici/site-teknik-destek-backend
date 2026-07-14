import type { ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AttachmentUploadCleanupInterceptor } from './attachment-upload-cleanup.interceptor';

function buildContext(file?: { path: string }): ExecutionContext {
  const request = { file };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('AttachmentUploadCleanupInterceptor', () => {
  it('basarili istekte deleteTemp cagirmaz', (done) => {
    const storage = { deleteTemp: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AttachmentUploadCleanupInterceptor(storage as never);
    const next = { handle: () => of('ok') };

    interceptor.intercept(buildContext({ path: '/tmp/x' }), next as never).subscribe({
      next: (value) => expect(value).toBe('ok'),
      complete: () => {
        expect(storage.deleteTemp).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('hata olustugunda ve dosya varsa deleteTemp cagirir, orijinal hatayi degistirmeden yeniden firlatir', (done) => {
    const storage = { deleteTemp: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AttachmentUploadCleanupInterceptor(storage as never);
    const originalError = new Error('DTO validation hatasi');
    const next = { handle: () => throwError(() => originalError) };

    interceptor.intercept(buildContext({ path: '/tmp/x' }), next as never).subscribe({
      error: (err: unknown) => {
        expect(err).toBe(originalError);
        expect(storage.deleteTemp).toHaveBeenCalledWith('/tmp/x');
        done();
      },
    });
  });

  it('req.file yoksa deleteTemp cagirmadan hatayi yeniden firlatir', (done) => {
    const storage = { deleteTemp: jest.fn() };
    const interceptor = new AttachmentUploadCleanupInterceptor(storage as never);
    const originalError = new Error('bilinmeyen multipart alani');
    const next = { handle: () => throwError(() => originalError) };

    interceptor.intercept(buildContext(undefined), next as never).subscribe({
      error: (err: unknown) => {
        expect(err).toBe(originalError);
        expect(storage.deleteTemp).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('deleteTemp basarisiz olsa da (idempotency) orijinal hata degismeden firlatilir', (done) => {
    const storage = {
      deleteTemp: jest.fn().mockRejectedValue(new Error('ENOENT - zaten silinmis')),
    };
    const interceptor = new AttachmentUploadCleanupInterceptor(storage as never);
    const originalError = new Error('servis hatasi');
    const next = { handle: () => throwError(() => originalError) };

    interceptor.intercept(buildContext({ path: '/tmp/x' }), next as never).subscribe({
      error: (err: unknown) => {
        expect(err).toBe(originalError);
        done();
      },
    });
  });
});
