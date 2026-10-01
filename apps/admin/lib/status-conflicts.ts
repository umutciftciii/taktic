/**
 * What the request and offer screens say when the API refuses a status write
 * with a 409.
 *
 * A 409 on these writes is never a crash: the operator asked for something the
 * row's state does not allow — usually because the row moved after the page
 * was drawn (a customer accepted another offer, the expiry job closed the
 * request, another operator got there first). The API refuses before writing
 * anything, so the answer is a sentence next to the control that was used,
 * not the generic error boundary.
 *
 * Codes come from the API:
 * - OFFER_ACTION_NOT_ALLOWED (API-GUARD-OFFER-001, PR #119): the offer is
 *   already ACCEPTED or REJECTED.
 * - OFFER_ACCEPT_INSUFFICIENT_CREDIT (BUG-OFFER-REFUND-ACCEPT-001): the
 *   offer's credit was refunded, an acceptance charges it again, and the
 *   provider's balance cannot cover it.
 * - CONTACT_DISCLOSURE_REQUIRED: contact sharing is on and the customer's
 *   consent to the current wording is not on file, so an acceptance cannot
 *   open the details.
 * - REQUEST_STATUS_TRANSITION_NOT_ALLOWED (API-GUARD-REQUEST-001, PR #119):
 *   IN_REVIEW / APPROVED asked of a request outside the moderation queue or
 *   already matched.
 * - REQUEST_STATUS_NOT_MODERATION_TARGET (API-GUARD-REQUEST-002, PR #120): a
 *   status the moderation endpoint never writes. The screen never sends one;
 *   mapped so a hand-built form cannot reach the error boundary either.
 * - REQUEST_NOT_REMOVABLE, PHONE_NOT_VERIFIED: as before.
 *
 * The lifecycle endpoints (`/complete`, `/cancel`) and the remaining offer
 * conflicts answer with a bare 409 and no code; every one of them means "the
 * state changed", so each endpoint maps its bare 409 to one sentence.
 *
 * Kept free of Next and of `lib/api` so it can be unit-tested on its own.
 */

import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from './confirmation-proof-keys';

export type OfferStatusErrorKey = 'decided' | 'disclosureRequired' | 'insufficientCredit' | 'stale' | 'confirmationRequired';

export const OFFER_STATUS_ERROR_MESSAGES: Record<OfferStatusErrorKey, string> = {
  decided:
    'Teklif durumu değiştirilmedi. Bu teklif için karar zaten verilmiş: kabul edilmiş teklif reddedilemez ya da kısa listeye alınamaz, reddedilmiş teklif yeniden açılamaz veya kabul edilemez. Aşağıda teklifin güncel durumu görünüyor.',
  disclosureRequired:
    'Teklif kabul edilmedi. İletişim paylaşımı açık ve müşterinin güncel bilgilendirme metnine onayı kayıtlı değil; kabul iletişim bilgilerini açacağı için bu onay olmadan yapılamaz. Müşteri teklifi kendi panelinden, bilgilendirmeyi onaylayarak kabul edebilir. Talep ve teklifler değişmedi.',
  insufficientCredit:
    'Teklif kabul edilmedi. Bu teklifin kredisi daha önce firmaya iade edilmişti; kabul krediyi yeniden düşer ve firmanın bakiyesi yetmiyor. Firma bakiye yükledikten sonra tekrar deneyin. Talep, teklifler ve krediler değişmedi.',
  // ADMIN-DESTRUCTIVE-CONFIRMATION-001: the dialog's proof was missing or
  // spent; nothing was sent to the API.
  confirmationRequired: CONFIRMATION_PROOF_REFUSAL_MESSAGE,
  stale:
    'Teklif durumu değiştirilmedi. Teklif ya da talep bu sayfa açıldıktan sonra değişti (örneğin talep başka bir teklifle eşleşti, teklif geri çekildi ya da talep yayından çıktı). Aşağıda güncel durum görünüyor; işlemi buna göre yeniden değerlendirin.',
};

/** Every 409 from `PATCH /offers/:id/status` is a state conflict; the code picks the sentence. */
export function offerStatusErrorKey(code: string | null): OfferStatusErrorKey {
  if (code === 'OFFER_ACTION_NOT_ALLOWED') return 'decided';
  if (code === 'CONTACT_DISCLOSURE_REQUIRED') return 'disclosureRequired';
  if (code === 'OFFER_ACCEPT_INSUFFICIENT_CREDIT') return 'insufficientCredit';
  return 'stale';
}

export function offerStatusErrorMessage(key: string | undefined): string | null {
  return key && Object.prototype.hasOwnProperty.call(OFFER_STATUS_ERROR_MESSAGES, key)
    ? OFFER_STATUS_ERROR_MESSAGES[key as OfferStatusErrorKey]
    : null;
}

export type RequestStatusErrorKey =
  | 'phoneNotVerified'
  | 'notRemovable'
  | 'transitionNotAllowed'
  | 'notModerationTarget'
  | 'notCancellable'
  | 'cancelStateChanged'
  | 'withholdReasonRequired'
  | 'notCompletable'
  | 'creditBalanceLimit'
  | 'confirmationRequired';

export const REQUEST_STATUS_ERROR_MESSAGES: Record<RequestStatusErrorKey, string> = {
  phoneNotVerified:
    'Durum değiştirilmedi. Telefon doğrulaması zorunlu olduğu için doğrulanmamış bir talep onaylanamaz. Müşteri numarasını doğruladıktan sonra tekrar deneyin. Talep yayına alınmayacaksa, açık (yeni, incelemede, yayında) ve eşleşmemiş talep gerekçeyle reddedilebilir.',
  // The page appends the current status's reason (removalUnavailableReason),
  // so this sentence names no alternative of its own.
  notRemovable:
    'Talep reddedilmedi. Ret yalnız açık (yeni, incelemede, yayında) ve bir teklifle eşleşmemiş talebe uygulanır; talep bu sayfa açıldıktan sonra değişmiş olabilir.',
  transitionNotAllowed:
    'Durum değiştirilmedi. Talep artık inceleme kuyruğunda değil: eşleşmiş, kapanmış ya da reddedilmiş olabilir. İncelemeye alma ve onay yalnız yeni, incelemedeki veya onaylı ve eşleşmemiş talebe uygulanır. Yukarıda talebin güncel durumu görünüyor.',
  notModerationTarget:
    'Durum değiştirilmedi. İstenen durum moderasyonla yazılmaz; moderasyon yalnız incelemeye alır, onaylar veya reddeder. Talep değişmedi.',
  notCancellable:
    'Talep iptal edilmedi. Talep bu sayfa açıldıktan sonra kapandı (tamamlandı, reddedildi, süresi doldu ya da zaten iptal edildi); kapanmış talep iptal edilemez. Teklifler ve krediler değişmedi.',
  cancelStateChanged:
    'Talep iptal edilmedi. Talep bu sayfa açıldıktan sonra değişti (örneğin bir teklif kabul edildi); iptal kararı eski duruma göre verilmişti. Yukarıda güncel durum görünüyor; kararı buna göre yeniden verin. Hiçbir teklif ve kredi değişmedi.',
  withholdReasonRequired:
    'Talep iptal edilmedi. Kazanan teklifin kredisi iade edilmeyecekse en az 10 karakterlik gerekçe yazılması zorunludur.',
  notCompletable:
    'Talep tamamlandı olarak işaretlenmedi. Yalnız eşleşmiş talep tamamlanabilir ve talep bu sayfa açıldıktan sonra durum değiştirdi. Yukarıda talebin güncel durumu görünüyor.',
  // API-HARDENING-001: an offer refund in the same transaction would have
  // passed the ledger's integer bound, so the whole operation was refused.
  creditBalanceLimit:
    'İşlem yapılmadı. Bir teklifin kredisini iade etmek hizmet verenin bakiyesini üst sınırın üzerine çıkaracaktı; talep, teklifler ve krediler değişmedi. Hizmet verenin bakiyesi düştükten sonra yeniden deneyin.',
  confirmationRequired: CONFIRMATION_PROOF_REFUSAL_MESSAGE,
};

/** API-HARDENING-001: the ledger bound refused a refund inside the operation. */
export function isCreditBalanceLimitError(error: unknown): boolean {
  // Read structurally (an ApiError carries `status` and the raw `body`), so
  // this module stays free of the server-only API client.
  const candidate = error as { status?: unknown; body?: unknown } | null;
  if (!candidate || candidate.status !== 400 || typeof candidate.body !== 'string') return false;
  try {
    return (JSON.parse(candidate.body) as { code?: unknown }).code === 'CREDIT_BALANCE_LIMIT_EXCEEDED';
  } catch {
    return false;
  }
}

/**
 * The moderation save's coded refusals. Anything else — an unknown code, a
 * bare 409 — returns null and still surfaces as an error: the moderation
 * endpoint has no bare 409 today, so one appearing is worth seeing.
 */
export function requestModerationErrorKey(code: string | null): RequestStatusErrorKey | null {
  switch (code) {
    case 'PHONE_NOT_VERIFIED':
      return 'phoneNotVerified';
    case 'REQUEST_NOT_REMOVABLE':
      return 'notRemovable';
    case 'REQUEST_STATUS_TRANSITION_NOT_ALLOWED':
      return 'transitionNotAllowed';
    case 'REQUEST_STATUS_NOT_MODERATION_TARGET':
      return 'notModerationTarget';
    default:
      return null;
  }
}

export function requestStatusErrorMessage(key: string | undefined): string | null {
  return key && Object.prototype.hasOwnProperty.call(REQUEST_STATUS_ERROR_MESSAGES, key)
    ? REQUEST_STATUS_ERROR_MESSAGES[key as RequestStatusErrorKey]
    : null;
}
