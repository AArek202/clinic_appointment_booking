import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-code.enum';

export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ code, message, ...extra }, status);
  }
}

export class ConflictError extends AppException {
  constructor(
    code: ErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(code, message, HttpStatus.CONFLICT, extra);
  }
}

export class BadRequestError extends AppException {
  constructor(
    code: ErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(code, message, HttpStatus.BAD_REQUEST, extra);
  }
}
