import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';

/** 409 with the repo's `{ statusCode, error, code, message }` body. */
export function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code,
    message,
  });
}

/** 404 with the repo's `{ statusCode, error, code, message }` body. */
export function notFound(code: string, message: string): NotFoundException {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code,
    message,
  });
}
