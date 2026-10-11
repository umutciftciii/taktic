import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * REL-002 Faz 4 — the incident endpoints' refusals, each with a stable `code`
 * the panels map to their own sentence.
 */
export const SERVICE_INCIDENT_CODES = {
  ALREADY_ADJUDICATED: 'INCIDENT_ALREADY_ADJUDICATED',
  NOT_ADJUDICATED: 'INCIDENT_NOT_ADJUDICATED',
  ADJUDICATION_CHANGED: 'INCIDENT_ADJUDICATION_CHANGED',
  CORRECTION_SAME_DECISION: 'INCIDENT_CORRECTION_SAME_DECISION',
  RESPONSE_ALREADY_SUBMITTED: 'INCIDENT_RESPONSE_ALREADY_SUBMITTED',
  RESPONSE_TOO_SHORT: 'INCIDENT_RESPONSE_TOO_SHORT',
  RESPONSE_TOO_LONG: 'INCIDENT_RESPONSE_TOO_LONG',
  RATIONALE_REQUIRED: 'RATIONALE_REQUIRED',
  RATIONALE_TOO_LONG: 'RATIONALE_TOO_LONG',
  SUPER_ADMIN_REQUIRED: 'SUPER_ADMIN_REQUIRED',
  REVIEW_ALREADY_RESOLVED: 'RELIABILITY_REVIEW_ALREADY_RESOLVED',
  REVIEW_ALREADY_ACKNOWLEDGED: 'RELIABILITY_REVIEW_ALREADY_ACKNOWLEDGED',
} as const;

function conflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', code, message, ...extra });
}

function badRequest(code: string, field: string, message: string, extra: Record<string, unknown> = {}) {
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, error: 'Bad Request', code, field, message, ...extra });
}

export function incidentNotFound() {
  return new NotFoundException('Service incident not found');
}

export function reviewNotFound() {
  return new NotFoundException('Reliability review not found');
}

export const serviceIncidentErrors = {
  alreadyAdjudicated: () =>
    conflict(SERVICE_INCIDENT_CODES.ALREADY_ADJUDICATED, 'Bu bildirim için karar zaten verildi.'),
  notAdjudicated: () =>
    conflict(SERVICE_INCIDENT_CODES.NOT_ADJUDICATED, 'Bu bildirim için henüz karar verilmedi; düzeltilecek bir karar yok.'),
  adjudicationChanged: (effectiveAdjudicationId: string | null) =>
    conflict(
      SERVICE_INCIDENT_CODES.ADJUDICATION_CHANGED,
      'Karar bu sayfa açıldıktan sonra değişti; lütfen sayfayı yenileyin.',
      { effectiveAdjudicationId },
    ),
  correctionSameDecision: () =>
    conflict(SERVICE_INCIDENT_CODES.CORRECTION_SAME_DECISION, 'Düzeltme, geçerli karardan farklı bir karar olmalı.'),
  responseAlreadySubmitted: () =>
    conflict(SERVICE_INCIDENT_CODES.RESPONSE_ALREADY_SUBMITTED, 'Bu bildirime yanıtınız zaten kayda geçti.'),
  responseTooShort: (minLength: number) =>
    badRequest(SERVICE_INCIDENT_CODES.RESPONSE_TOO_SHORT, 'responseText', `Yanıtınız en az ${minLength} karakter olmalı.`, { minLength }),
  responseTooLong: (maxLength: number) =>
    badRequest(SERVICE_INCIDENT_CODES.RESPONSE_TOO_LONG, 'responseText', `Yanıtınız en fazla ${maxLength} karakter olabilir.`, { maxLength }),
  rationaleRequired: (minLength: number, field = 'rationale') =>
    badRequest(SERVICE_INCIDENT_CODES.RATIONALE_REQUIRED, field, `En az ${minLength} karakterlik bir gerekçe yazın.`, { minLength }),
  rationaleTooLong: (maxLength: number, field = 'rationale') =>
    badRequest(SERVICE_INCIDENT_CODES.RATIONALE_TOO_LONG, field, `Gerekçe en fazla ${maxLength} karakter olabilir.`, { maxLength }),
  superAdminRequired: () =>
    new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      code: SERVICE_INCIDENT_CODES.SUPER_ADMIN_REQUIRED,
      message: 'Karar düzeltmesini yalnız süper yönetici yapabilir.',
    }),
  reviewAlreadyResolved: () =>
    conflict(SERVICE_INCIDENT_CODES.REVIEW_ALREADY_RESOLVED, 'Bu inceleme zaten sonuçlandırıldı.'),
  reviewAlreadyAcknowledged: () =>
    conflict(SERVICE_INCIDENT_CODES.REVIEW_ALREADY_ACKNOWLEDGED, 'Bu inceleme zaten üstlenildi.'),
};

/**
 * The code a M4 trigger raised, if this error is one. The triggers start their
 * message with the code (`INCIDENT_ADJUDICATION_CHANGED: …`) so a writer that
 * slipped past the application's own reads still gets the right 409.
 */
export function incidentTriggerCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  for (const code of [
    SERVICE_INCIDENT_CODES.ALREADY_ADJUDICATED,
    SERVICE_INCIDENT_CODES.ADJUDICATION_CHANGED,
    SERVICE_INCIDENT_CODES.RESPONSE_ALREADY_SUBMITTED,
  ]) {
    if (message.includes(`${code}:`)) {
      return code;
    }
  }
  return null;
}

/** True for a P2002 on the adjudication chain's uniques (sequence or supersedes). */
export function isAdjudicationChainCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta?.target ?? []) as string[] | string;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some(
    (field) => field === 'sequence' || field === 'supersedesAdjudicationId' || field.includes('ProviderIncidentAdjudication'),
  );
}
