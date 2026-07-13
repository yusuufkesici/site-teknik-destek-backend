import { HttpException } from '@nestjs/common';
import type { ErrorCode } from '../constants/error-codes.constant';

// GlobalExceptionFilter bu sinifi HttpException'dan once yakalar ve
// 'code'u dogrudan yanit zarfina tasir (bkz. onaylanan Faz 2 plani Bolum 9).
export class DomainError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: number,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}
