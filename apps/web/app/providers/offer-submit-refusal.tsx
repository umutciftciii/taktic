import { ApiError } from '../../lib/api';

/**
 * The offer form's refusals that used to reach the error boundary
 * (RELEASE-GAP-001 G-07, UAT B-07): every one of them is an expected outcome
 * of a provider acting on a request that moved, or on a balance that ran out.
 * In each the API created no offer and spent no credit, and the sentence says
 * so first.
 *
 * The pricing and schedule refusals keep their own flags and notices
 * (actions.ts, offer-schedule-fields.tsx); this file only adds what they did
 * not cover.
 */
export const OFFER_SUBMIT_REFUSAL_MESSAGES = {
  requestUnavailable:
    'Bu talep artık teklif almıyor: müşteri talebi kapatmış, başka bir uzmanla eşleşmiş ya da talep sizin için uygun olmaktan çıkmış olabilir.',
  roundClosed:
    'Bu talebin teklif turu kapandı; yeni teklif verilemez.',
  alreadySubmitted:
    'Bu talebe bu turda zaten teklif gönderdiniz. Aynı talebe ikinci teklif verilemez.',
  insufficientCredit:
    'Kredi bakiyeniz bu teklif için yeterli değil. Kredi yükledikten sonra tekrar deneyebilirsiniz.',
  invalid:
    'Formdaki bilgiler kabul edilmedi. Fiyat en az 1,00 ₺ olmalı ve mesaj alanı boş bırakılmamalı; kontrol edip tekrar gönderin.',
  conflict:
    'Talebin durumu siz formu doldururken değişti. Sayfayı yenileyip tekrar deneyin.',
} as const;

export type OfferSubmitRefusal = keyof typeof OFFER_SUBMIT_REFUSAL_MESSAGES;

/**
 * Where a refused submit lands. `list` when the request is no longer the
 * provider's to see — the detail page would answer 404 — and `form` otherwise.
 */
export type OfferSubmitRefusalTarget = { refusal: OfferSubmitRefusal; on: 'form' | 'list' };

/**
 * An API refusal of `POST …/requests/:id/offers` as a flag the page can turn
 * into a sentence, or null for a real failure (5xx, 401, 403, network) that
 * still belongs to the error boundary.
 */
export function describeOfferSubmitRefusal(error: unknown): OfferSubmitRefusalTarget | null {
  if (!(error instanceof ApiError)) return null;
  const code = readCode(error.body);

  switch (error.status) {
    case 404:
      return { refusal: 'requestUnavailable', on: 'list' };
    case 402:
      return { refusal: 'insufficientCredit', on: 'form' };
    case 400:
      return { refusal: 'invalid', on: 'form' };
    case 409:
      if (code === 'OFFER_ROUND_CLOSED') return { refusal: 'roundClosed', on: 'list' };
      // A customer's service-issue report ended this provider's part in the
      // request: from their side it is simply no longer available.
      if (code === 'PROVIDER_EXCLUDED') return { refusal: 'requestUnavailable', on: 'list' };
      if (code === 'OFFER_ALREADY_SUBMITTED') return { refusal: 'alreadySubmitted', on: 'form' };
      return { refusal: 'conflict', on: 'form' };
    default:
      return null;
  }
}

/** The flag read back off the URL, or null for anything this file does not own. */
export function readOfferSubmitRefusal(value: string | undefined): OfferSubmitRefusal | null {
  return value && Object.hasOwn(OFFER_SUBMIT_REFUSAL_MESSAGES, value) ? (value as OfferSubmitRefusal) : null;
}

export function OfferSubmitRefusalNotice({ code }: { code: string | undefined }) {
  const refusal = readOfferSubmitRefusal(code);
  if (!refusal) return null;

  return (
    <div className="pdash-notice pdash-notice-error" role="alert" data-testid="offer-submit-refusal" data-refusal={refusal}>
      <span>
        <strong>Teklif gönderilmedi, kredi düşülmedi.</strong> {OFFER_SUBMIT_REFUSAL_MESSAGES[refusal]}
      </span>
    </div>
  );
}

function readCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}
