import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ERROR_CODES, type ErrorCode } from '../constants/error-codes.constant';
import { DomainError } from '../errors/domain-error';
import type { ErrorResponseBody } from '../types/error-response.type';

interface ResolvedException {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

// Standart hata zarfi: { success:false, error:{ code, message, requestId, timestamp, details? } }
// (docs/architecture.md Bolum 7). Secret/OTP/token iceren alanlar burada
// islenmez; stack trace yalniz log'a yazilir, yanita hicbir zaman dahil
// edilmez (CLAUDE.md "Kod kalitesi").
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(GlobalExceptionFilter.name)
    private readonly logger: PinoLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = String(request.id);

    const resolved = this.resolve(exception);

    const body: ErrorResponseBody = {
      success: false,
      error: {
        code: resolved.code,
        message: resolved.message,
        requestId,
        timestamp: new Date().toISOString(),
        ...(resolved.details !== undefined ? { details: resolved.details } : {}),
      },
    };

    if (resolved.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    } else {
      this.logger.warn(
        { requestId, code: resolved.code, status: resolved.status },
        resolved.message,
      );
    }

    response.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): ResolvedException {
    // DomainError once kontrol edilir (HttpException'dan turer): kendi
    // 'code'unu tasir, mapStatusToCode'un jenerik eslemesine dusmez
    // (onaylanan Faz 2 plani Bolum 9).
    if (exception instanceof DomainError) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.meta,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      return {
        status,
        code: this.mapStatusToCode(status),
        message: this.extractMessage(payload, exception.message),
        details: this.extractDetails(payload),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Beklenmeyen bir hata olustu.',
    };
  }

  private extractMessage(payload: unknown, fallback: string): string {
    if (typeof payload === 'string') {
      return payload;
    }

    if (this.isRecord(payload) && typeof payload.message === 'string') {
      return payload.message;
    }

    return fallback;
  }

  private extractDetails(payload: unknown): unknown {
    if (this.isRecord(payload) && Array.isArray(payload.message)) {
      return payload.message;
    }

    return undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private mapStatusToCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ERROR_CODES.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ERROR_CODES.CONFLICT;
      // Bu fazda (Faz 6) 413'un tek kaynagi FileInterceptor'in Multer
      // LIMIT_FILE_SIZE hatasini donusturdugu PayloadTooLargeException'dir
      // (@nestjs/platform-express/multer/multer.utils.ts transformException) -
      // ham MulterError filter'a hicbir zaman ulasmaz, bu yuzden burada ayrica
      // ozel bir instanceof kontrolu yerine genel status eslemesi yeterlidir.
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ERROR_CODES.ATTACHMENT_TOO_LARGE;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}
