import { BadRequestException, HttpStatus } from '@nestjs/common';
import { detectContactDetails } from './contact-detection';

/**
 * Returned when a free-text field — the description, the address note, or a
 * TEXT/TEXTAREA answer — carries something that looks like a phone number,
 * e-mail address, or link. Requests now publish to providers without an
 * operator reading them first, so this is the only gate left against a
 * customer routing a provider off-platform before an offer is even made;
 * contact details are shared automatically once an offer is accepted.
 */
export const CONTACT_DETAILS_IN_TEXT_CODE = 'CONTACT_DETAILS_IN_TEXT';

/** Refuses `value` if it carries a phone number, e-mail address, or link. */
export function assertNoContactDetails(field: string, value: string | null) {
  if (!value) return;

  const found = detectContactDetails(value);
  if (found) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: CONTACT_DETAILS_IN_TEXT_CODE,
      field,
      kind: found.kind,
      message:
        'İletişim bilgisi (telefon, e-posta, bağlantı) paylaşılamaz; bilgiler teklif kabul edildiğinde otomatik paylaşılır.',
    });
  }
}
