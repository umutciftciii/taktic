/**
 * What a request form says for a refusal.
 *
 * Two sources, in this order:
 *
 * 1. A **specific** code the API named (`SHOWCASE_LEAD_AREA_NOT_SERVED`,
 *    `PHONE_VERIFICATION_INVALID`, …) has a sentence of its own here.
 * 2. Otherwise the API's own message when it gave one for the client — a
 *    conflict such as "Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.",
 *    a DTO validation message — is shown as-is.
 *
 * The generic sentence is the last resort only: a refusal with no code and no
 * message, or a server error. It must never win over a message the API worded
 * for the customer, which is exactly what happened when the code-less fallback
 * (`SHOWCASE_LEAD_FAILED`) was looked up in the table before the message.
 */
import { CONTACT_DETAILS_ERROR, CONTACT_DETAILS_IN_TEXT } from './contact-details-refusal';

export const REQUEST_REFUSAL_GENERIC = 'SHOWCASE_LEAD_FAILED';

export const REQUEST_REFUSAL_TEXTS: Record<string, string> = {
  SHOWCASE_CARD_NOT_FOUND: 'Bu kart artık yayında değil.',
  SHOWCASE_LEAD_PHONE_VERIFICATION_REQUIRED:
    'Telefon doğrulamanız tamamlanmadı ya da süresi doldu. Kodu yeniden isteyin.',
  SHOWCASE_LEAD_RATE_LIMITED: 'Çok fazla talep gönderildi. Lütfen bir süre sonra tekrar deneyin.',
  PHONE_VERIFICATION_INVALID:
    'Doğrulama kodu geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.',
  PHONE_VERIFICATION_RATE_LIMITED:
    'Bu numara için kısa sürede çok fazla kod istendi. Lütfen biraz sonra tekrar deneyin.',
  SHOWCASE_AREA_UNKNOWN: 'Seçilen il, ilçe ve mahalle birlikte geçerli bir bölge oluşturmuyor.',
  SHOWCASE_LEAD_FORBIDDEN:
    'Hizmet veren hesabıyla vitrin talebi gönderilemez. Müşteri olarak devam etmek için oturumu kapatın.',
  REQUEST_FORBIDDEN:
    'Hizmet veren hesabıyla talep oluşturulamaz. Müşteri olarak devam etmek için oturumu kapatın.',
  CUSTOMER_IDENTITY_CONFLICT:
    'Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.',
  // Normally shown under the field the API named; this is the banner's
  // wording when the field is one the form cannot point at.
  [CONTACT_DETAILS_IN_TEXT]: CONTACT_DETAILS_ERROR,
};

const GENERIC_MESSAGE = 'Talebiniz gönderilemedi. Bilgileri kontrol edip tekrar deneyin.';

export function requestRefusalText(failure: {
  code: string;
  message: string | null;
}): string {
  if (failure.code !== REQUEST_REFUSAL_GENERIC) {
    const known = REQUEST_REFUSAL_TEXTS[failure.code];
    if (known) {
      return known;
    }
  }

  return failure.message?.trim() || GENERIC_MESSAGE;
}
