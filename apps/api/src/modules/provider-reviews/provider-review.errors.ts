import { ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

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

/** 429 with the repo's `{ statusCode, error, code, message }` body. */
export function tooMany(code: string, message: string): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code,
      message,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
