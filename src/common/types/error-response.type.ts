import type { ErrorCode } from '../constants/error-codes.constant';

export interface ErrorResponseBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    timestamp: string;
    details?: unknown;
  };
}
