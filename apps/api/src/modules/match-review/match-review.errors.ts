import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';

/**
 * REL-002 Faz 5 — the refusals of the staff "open the next round" action.
 * Every one carries a machine-readable `code` the admin screen maps to its
 * own sentence.
 */
export const MATCH_REVIEW_CODES = {
  NOT_IN_MATCH_REVIEW: 'REQUEST_NOT_IN_MATCH_REVIEW',
  ALREADY_REOPENED: 'MATCH_REVIEW_ALREADY_REOPENED',
  ROUND_CHANGED: 'ROUND_CHANGED',
  INCONSISTENT: 'MATCH_REVIEW_INCONSISTENT',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  NOTE_REQUIRED: 'MATCH_REVIEW_NOTE_REQUIRED',
  NOTE_TOO_LONG: 'MATCH_REVIEW_NOTE_TOO_LONG',
  SUPER_ADMIN_REQUIRED: 'SUPER_ADMIN_REQUIRED',
} as const;

function conflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', code, message, ...extra });
}

export const matchReviewErrors = {
  notFound: () => new NotFoundException('Service request not found'),
  notInMatchReview: () =>
    conflict(MATCH_REVIEW_CODES.NOT_IN_MATCH_REVIEW, 'Talep eşleşme incelemesinde değil; yeni tur açılamaz.'),
  alreadyReopened: (roundNumber: number | null) =>
    conflict(
      MATCH_REVIEW_CODES.ALREADY_REOPENED,
      'Bu talep için yeni tur zaten açıldı; sayfayı yenileyin.',
      roundNumber === null ? {} : { roundNumber },
    ),
  roundChanged: () =>
    conflict(
      MATCH_REVIEW_CODES.ROUND_CHANGED,
      'Talebin güncel turu bu sayfa açıldıktan sonra değişti; lütfen sayfayı yenileyin.',
    ),
  inconsistent: () =>
    conflict(
      MATCH_REVIEW_CODES.INCONSISTENT,
      'Talebin tur kaydı tutarsız görünüyor (güncel tur başarısız değil ya da açık bir tur var); yeni tur açılmadı.',
    ),
  idempotencyKeyReused: () =>
    conflict(
      MATCH_REVIEW_CODES.IDEMPOTENCY_KEY_REUSED,
      'Bu işlem anahtarı farklı bir istekle kullanılmış; formu yenileyip tekrar deneyin.',
    ),
  noteRequired: (minLength: number) =>
    new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: MATCH_REVIEW_CODES.NOTE_REQUIRED,
      message: `Yeni tur açmak için en az ${minLength} karakterlik bir iç not zorunludur.`,
      minLength,
    }),
  noteTooLong: (maxLength: number) =>
    new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: MATCH_REVIEW_CODES.NOTE_TOO_LONG,
      message: `İç not en fazla ${maxLength} karakter olabilir.`,
      maxLength,
    }),
  superAdminRequired: () =>
    new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      code: MATCH_REVIEW_CODES.SUPER_ADMIN_REQUIRED,
      message: 'Yeni tur açmak yalnız süper yöneticiye açıktır.',
    }),
};
