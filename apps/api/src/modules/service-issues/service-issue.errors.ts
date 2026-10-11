import { BadRequestException, ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

/**
 * REL-002 Faz 3 — the service-issue endpoint's refusals. Every one carries a
 * machine-readable `code` the customer screen maps to its own sentence; none
 * names the provider or anything about another party.
 */
export const SERVICE_ISSUE_CODES = {
  REQUEST_NOT_MATCHED: 'REQUEST_NOT_MATCHED',
  ROUND_CHANGED: 'ROUND_CHANGED',
  MATCH_INCONSISTENT: 'MATCH_INCONSISTENT',
  REQUIRES_SUPPORT: 'SERVICE_ISSUE_REQUIRES_SUPPORT',
  REASON_NOT_YET_AVAILABLE: 'SERVICE_ISSUE_REASON_NOT_YET_AVAILABLE',
  NOTE_REQUIRED: 'SERVICE_ISSUE_NOTE_REQUIRED',
  NOTE_TOO_LONG: 'SERVICE_ISSUE_NOTE_TOO_LONG',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  ROUND_ALREADY_FAILED: 'ROUND_ALREADY_FAILED',
  RATE_LIMITED: 'SERVICE_ISSUE_RATE_LIMITED',
} as const;

function conflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', code, message, ...extra });
}

/** Unknown request, somebody else's request, and the switch being off: one answer. */
export function serviceIssueNotFound() {
  return new NotFoundException('Service request not found');
}

export const serviceIssueErrors = {
  requestNotMatched: () =>
    conflict(SERVICE_ISSUE_CODES.REQUEST_NOT_MATCHED, 'Bu talepte şu anda devam eden bir eşleşme yok.'),
  roundChanged: () =>
    conflict(
      SERVICE_ISSUE_CODES.ROUND_CHANGED,
      'Talebinizin durumu bu sayfa açıldıktan sonra değişti; lütfen sayfayı yenileyin.',
    ),
  matchInconsistent: () =>
    conflict(
      SERVICE_ISSUE_CODES.MATCH_INCONSISTENT,
      'Eşleşme kaydı tutarsız görünüyor; bildirim alınamadı. Lütfen destek ekibimizle iletişime geçin.',
    ),
  requiresSupport: () =>
    conflict(
      SERVICE_ISSUE_CODES.REQUIRES_SUPPORT,
      'Bu eşleşmede hizmet veren başlangıç ve bitiş tarihi vermediği için sorun buradan bildirilemiyor. Lütfen destek ekibimizle iletişime geçin.',
    ),
  reasonNotYetAvailable: (opensOn: string | null) =>
    conflict(
      SERVICE_ISSUE_CODES.REASON_NOT_YET_AVAILABLE,
      'Bu sebep, hizmet verenin taahhüt ettiği gün geçtikten sonra seçilebilir.',
      { opensOn },
    ),
  noteRequired: (minLength: number) =>
    new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: SERVICE_ISSUE_CODES.NOTE_REQUIRED,
      field: 'note',
      minLength,
      message: `Bu sebep için en az ${minLength} karakterlik bir açıklama yazın.`,
    }),
  noteTooLong: (maxLength: number) =>
    new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: SERVICE_ISSUE_CODES.NOTE_TOO_LONG,
      field: 'note',
      maxLength,
      message: `Açıklama en fazla ${maxLength} karakter olabilir.`,
    }),
  idempotencyKeyReused: () =>
    conflict(
      SERVICE_ISSUE_CODES.IDEMPOTENCY_KEY_REUSED,
      'Bu bildirim anahtarı farklı bir bildirim için kullanılmış; lütfen formu yeniden açın.',
    ),
  roundAlreadyFailed: () =>
    conflict(
      SERVICE_ISSUE_CODES.ROUND_ALREADY_FAILED,
      'Bu eşleşme için hizmet aksaklığı zaten bildirildi.',
    ),
  rateLimited: () =>
    new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: SERVICE_ISSUE_CODES.RATE_LIMITED,
        message: 'Kısa sürede çok fazla bildirim yapıldı. Lütfen biraz sonra tekrar deneyin.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    ),
};
