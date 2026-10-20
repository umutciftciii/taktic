import { clientForwardingHeaders } from '../../lib/forwarded-for';
import { apiUrl } from '../api-base';

/**
 * The e-mail verification link, read on the page and spent by its button
 * (STAGING-UAT-001 B3).
 *
 * Opening the page used to confirm the link. Opening a page is a GET, and a GET
 * is not only the person: mail security scanners (Safe Links and the like),
 * link previews and prefetchers follow every link in a message. One of them
 * spent the link, and the person who clicked a moment later read "invalid or
 * expired" about an account that had just been verified. So the page only
 * reads the link (`GET /auth/email-verification`), and the link is spent by a
 * plain form post to a fixed URL (`/e-posta-dogrula/submit`) — the same split
 * every other mailed link in this app already uses (activation, claim, reset).
 */

export type VerifiedAccountKind = 'CUSTOMER' | 'PROVIDER';

/** What the page shows. `ready` is the only state that offers the button. */
export type VerificationState =
  | { kind: 'ready'; accountKind: VerifiedAccountKind }
  | { kind: 'verified'; accountKind: VerifiedAccountKind }
  | { kind: 'already'; accountKind: VerifiedAccountKind }
  | { kind: 'expired'; accountKind: VerifiedAccountKind }
  | { kind: 'invalid' }
  | { kind: 'failed' };

/** The result words the submit route puts in the URL — never the link itself. */
const RESULT_PARAM = 'sonuc';
const ACCOUNT_PARAM = 'hesap';
const RESULTS = {
  verified: 'dogrulandi',
  already: 'zaten-dogrulanmis',
  expired: 'suresi-doldu',
  invalid: 'gecersiz',
  failed: 'tamamlanamadi',
} as const;
const PROVIDER_ACCOUNT = 'hizmet-veren';

type ResultKind = keyof typeof RESULTS;

/** Reads the link without spending it. */
export async function readVerificationLink(token: string): Promise<VerificationState> {
  try {
    const response = await fetch(`${apiUrl}/auth/email-verification?token=${encodeURIComponent(token)}`, {
      // The reader's own address, so the API's per-address auth budget counts
      // them — not the web server every reader (and every scanner) shares.
      headers: await clientForwardingHeaders(),
      cache: 'no-store',
    });

    if (response.ok) {
      const payload = (await response.json()) as { status?: unknown; accountKind?: unknown };
      return payload.status === 'VALID'
        ? { kind: 'ready', accountKind: accountKindOf(payload.accountKind) }
        : { kind: 'invalid' };
    }

    return await refusalState(response);
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * `POST /e-posta-dogrula/submit` — the button. Spends the link and answers with
 * the path of the result screen, which carries a result word and the kind of
 * account, so a reload of that screen re-posts nothing and shows no token.
 */
export async function submitEmailVerification(formData: FormData): Promise<string> {
  const value = formData.get('token');
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) {
    return resultPath({ kind: 'invalid' });
  }

  let state: VerificationState;
  try {
    const response = await fetch(`${apiUrl}/auth/email-verification/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await clientForwardingHeaders()) },
      body: JSON.stringify({ token }),
      cache: 'no-store',
    });

    if (response.ok) {
      const payload = (await response.json()) as { alreadyVerified?: unknown; accountKind?: unknown };
      const accountKind = accountKindOf(payload.accountKind);
      state = payload.alreadyVerified === true ? { kind: 'already', accountKind } : { kind: 'verified', accountKind };
    } else {
      state = await refusalState(response);
    }
  } catch {
    state = { kind: 'failed' };
  }

  return resultPath(state);
}

/**
 * The result screen's state, from its own URL. Unknown words read as nothing,
 * so the page falls back to reading the link (or to "invalid" without one).
 */
export function resultFromSearchParams(params: { sonuc?: string; hesap?: string }): VerificationState | null {
  const kind = (Object.keys(RESULTS) as ResultKind[]).find((key) => RESULTS[key] === params.sonuc);
  if (!kind) {
    return null;
  }

  if (kind === 'invalid' || kind === 'failed') {
    return { kind };
  }

  return { kind, accountKind: params.hesap === PROVIDER_ACCOUNT ? 'PROVIDER' : 'CUSTOMER' };
}

function resultPath(state: VerificationState): string {
  const kind: ResultKind = state.kind === 'ready' ? 'failed' : state.kind;
  const params = new URLSearchParams({ [RESULT_PARAM]: RESULTS[kind] });
  if ('accountKind' in state && state.accountKind === 'PROVIDER') {
    params.set(ACCOUNT_PARAM, PROVIDER_ACCOUNT);
  }
  return `/e-posta-dogrula?${params.toString()}`;
}

/** The API's 400 carries a code; anything else (a 5xx, a throttle) is "try again". */
async function refusalState(response: Response): Promise<VerificationState> {
  if (response.status !== 400) {
    return { kind: 'failed' };
  }

  let body: { code?: unknown; accountKind?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // An unreadable refusal is still a refusal.
  }

  switch (body.code) {
    case 'EMAIL_VERIFICATION_ALREADY_VERIFIED':
      return { kind: 'already', accountKind: accountKindOf(body.accountKind) };
    case 'EMAIL_VERIFICATION_EXPIRED':
      return { kind: 'expired', accountKind: accountKindOf(body.accountKind) };
    default:
      return { kind: 'invalid' };
  }
}

function accountKindOf(value: unknown): VerifiedAccountKind {
  return value === 'PROVIDER' ? 'PROVIDER' : 'CUSTOMER';
}
