import { BadRequestException, ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';

/**
 * SEO-004 — every refusal the SEO write paths make, each with a stable code a
 * client can branch on. Messages are Turkish operator copy; the code is the
 * contract.
 */

export const SEO_ERROR_CODES = {
  PATH_INVALID: 'SEO_PATH_INVALID',
  SOURCE_RESERVED: 'SEO_SOURCE_RESERVED',
  SOURCE_IS_LIVE_PAGE: 'SEO_SOURCE_IS_LIVE_PAGE',
  SOURCE_TAKEN: 'SEO_SOURCE_TAKEN',
  TARGET_NOT_CANONICAL: 'SEO_TARGET_NOT_CANONICAL',
  TARGET_NOT_LIVE: 'SEO_TARGET_NOT_LIVE',
  REDIRECT_TO_ITSELF: 'SEO_REDIRECT_TO_ITSELF',
  REDIRECT_CHAIN: 'SEO_REDIRECT_CHAIN',
  REDIRECT_NOT_FOUND: 'SEO_REDIRECT_NOT_FOUND',
  REDIRECT_INACTIVE: 'SEO_REDIRECT_INACTIVE',
  SLUG_REDIRECT_PERMANENT: 'SEO_SLUG_REDIRECT_PERMANENT',
  SLUG_INVALID: 'CATEGORY_SLUG_INVALID',
  SLUG_TAKEN: 'CATEGORY_SLUG_TAKEN',
  SLUG_HELD_BY_REDIRECT: 'SLUG_HELD_BY_REDIRECT',
  SUGGESTION_NOT_FOUND: 'SEO_SUGGESTION_NOT_FOUND',
  SUGGESTION_DECIDED: 'SEO_SUGGESTION_ALREADY_DECIDED',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
} as const;

export function seoPathInvalid(field: string, refusal: string) {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: SEO_ERROR_CODES.PATH_INVALID,
    field,
    refusal,
    message: 'Adres geçerli bir site içi yol değil.',
  });
}

export function seoBadRequest(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, error: 'Bad Request', code, message, ...extra });
}

export function seoConflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', code, message, ...extra });
}

export function seoNotFound(code: string, message: string) {
  return new NotFoundException({ statusCode: HttpStatus.NOT_FOUND, error: 'Not Found', code, message });
}
