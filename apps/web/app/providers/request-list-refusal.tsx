import Link from 'next/link';
import { ApiError, type ProviderStatus } from '../../lib/api';

/**
 * Why the provider's matching-request list could not be read, as a word the
 * page turns into a sentence (PROVIDER-STATUS-UX-001).
 *
 * The page used to print the caught error's message, and an `ApiError`'s
 * message is the API's raw body — a suspended provider read
 * `{"message":"Provider must be approved…","statusCode":403}`. Nothing of the
 * API's text reaches the screen any more:
 *
 * - `restricted` — a 403 while the provider is SUSPENDED. The API's rule is
 *   unchanged (only an approved provider sees matching requests); the screen
 *   says so in general, neutral terms and points at support. Never the reason
 *   or the operator's note: neither is on the provider's own projection.
 * - `notApproved` — the same 403 for any other status that is not approved
 *   (an application under review, a draft, a rejection).
 * - `signedOut` — the session ended between the page's own check and the
 *   list read; the page sends the provider to sign in, as it does up front.
 * - `failed` — everything else (5xx, network, an unexpected answer).
 */
export type RequestListRefusal = 'restricted' | 'notApproved' | 'signedOut' | 'failed';

export function describeRequestListRefusal(error: unknown, providerStatus: ProviderStatus): RequestListRefusal {
  if (error instanceof ApiError && error.status === 401) return 'signedOut';
  if (error instanceof ApiError && error.status === 403 && providerStatus !== 'APPROVED') {
    return providerStatus === 'SUSPENDED' ? 'restricted' : 'notApproved';
  }
  return 'failed';
}

export const REQUEST_LIST_REFUSAL_MESSAGES = {
  restricted: 'Hesabınız geçici olarak sınırlandırılmıştır. Yeni taleplere şu anda erişemiyorsunuz.',
  notApproved: 'Yeni taleplere şu anda erişemiyorsunuz. Hesabınız onaylandığında uygun talepler burada listelenir.',
  failed: 'Talepler şu anda yüklenemedi. Lütfen biraz sonra tekrar deneyin.',
} as const satisfies Record<Exclude<RequestListRefusal, 'signedOut'>, string>;

export function RequestListRefusalNotice({ refusal }: { refusal: Exclude<RequestListRefusal, 'signedOut'> | null }) {
  if (!refusal) return null;

  if (refusal === 'failed') {
    return (
      <div className="pdash-notice pdash-notice-error" role="alert" data-testid="request-list-refusal">
        {REQUEST_LIST_REFUSAL_MESSAGES.failed}
      </div>
    );
  }

  return (
    <div className="pdash-notice pdash-notice-warn notice-prose" role="status" data-testid="request-list-refusal">
      {REQUEST_LIST_REFUSAL_MESSAGES[refusal]} Bilgi veya inceleme talebi için{' '}
      <Link href="/destek">Destek</Link> üzerinden bize yazabilirsiniz.
    </div>
  );
}
