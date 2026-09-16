import type { TurnstileAction } from './turnstile.constants';

export type TurnstileVerifyInput = {
  /** The header's value, or null when the request carried none. */
  token: string | null;
  /** The operation this request is about to perform. */
  action: TurnstileAction;
  /** Express `req.ip` — honours TRUST_PROXY — or null when unknown. */
  remoteIp: string | null;
};

/**
 * Why a token was refused. Names only: nothing here carries the token, the
 * hostname Cloudflare reported, or any detail a caller could learn from.
 *
 *   TOKEN_MISSING         no header, or a blank one
 *   TOKEN_INVALID         Cloudflare said no (expired, already used, forged,
 *                         wrong secret), or the value is not a token at all
 *   ACTION_MISMATCH       a real token, minted for another operation
 *   HOSTNAME_MISMATCH     a real token, solved on a hostname this deployment
 *                         does not serve
 *   VERIFIER_UNAVAILABLE  the question could not be asked or the answer could
 *                         not be read — timeout, network, 5xx, malformed body
 */
export type TurnstileRefusal =
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'ACTION_MISMATCH'
  | 'HOSTNAME_MISMATCH'
  | 'VERIFIER_UNAVAILABLE';

export type TurnstileVerdict = { ok: true } | { ok: false; reason: TurnstileRefusal };

/**
 * The one question the guard asks. Bound at boot to the Cloudflare verifier,
 * the deterministic test verifier or the pass-through, by turnstile.config.ts;
 * an abstract class rather than an interface so it can be a Nest injection
 * token, the way NotificationPort and SmsPort are.
 */
export abstract class TurnstileVerifierPort {
  abstract verify(input: TurnstileVerifyInput): Promise<TurnstileVerdict>;
}
