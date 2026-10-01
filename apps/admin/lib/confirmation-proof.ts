import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Proof that a person really pressed "Evet, …" in a `ConfirmDialog`
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 *
 * ## The hole this closes
 *
 * A dialog's trigger is the form's submit button. Before React hydrates, its
 * click handler does not exist: the browser submits the form, React 19's inline
 * replay script queues that submission, and once the page hydrates the queued
 * FormData is sent to the server action — which runs, with no dialog ever
 * shown. With JavaScript off the same form posts straight to the action. A
 * confirmation the server never checks is only a suggestion.
 *
 * ## Why not a hidden `confirm=yes`
 *
 * Anything that is in the page's markup is in the pre-hydration submission
 * too, and anything with a fixed value can be typed by hand. The proof has to
 * be something the form can only carry *after* the dialog's confirm button was
 * pressed, and something the server can tell apart from a value somebody made
 * up. So it is minted by the server at that moment (`mintConfirmationProof`,
 * called by the dialog's confirm handler — code that does not run before
 * hydration) and checked by the server action before it writes anything.
 *
 * ## What a proof is
 *
 * `<payload>.<signature>`, both base64url. The payload names:
 *
 * - `k` the action it was minted for (`CONFIRMATION_PROOF_KEYS`), so a proof
 *   for one confirmation cannot open another;
 * - `s` a SHA-256 of the session cookie, so it is worthless in another session
 *   (or after signing out and in again);
 * - `n` a random nonce, the unit of single use;
 * - `e` its expiry, `CONFIRMATION_PROOF_TTL_MS` after minting.
 *
 * The signature is an HMAC-SHA-256 over the payload. It is not a CSRF token
 * and does not replace one: Next's server actions already refuse cross-origin
 * posts. This answers a different question — did this session pass through the
 * second step — and is checked next to, not instead of, the API's permissions.
 *
 * ## Single use
 *
 * A verified nonce is recorded and refused the second time. A replayed proof
 * would otherwise turn one confirmation into several writes — two credit
 * grants from one "Evet, kredi ekle", a retried submission charging twice —
 * and the API cannot tell those apart from two real decisions. The record
 * lives as long as the proof could (TTL), so it stays small.
 *
 * Everything in this file is pure: the secret, the clock, the session value
 * and the ledger are passed in. `confirmation-proof-server.ts` supplies them.
 */

export {
  CONFIRMATION_PROOF_FIELD,
  CONFIRMATION_PROOF_KEYS,
  CONFIRMATION_PROOF_REFUSAL_MESSAGE,
  CONFIRMATION_PROOF_TTL_MS,
  isConfirmationProofKey,
  type ConfirmationProofKey,
} from './confirmation-proof-keys';
import { CONFIRMATION_PROOF_TTL_MS, type ConfirmationProofKey } from './confirmation-proof-keys';

type ProofPayload = { k: string; s: string; n: string; e: number };

export type ProofRefusal = 'missing' | 'malformed' | 'signature' | 'scope' | 'session' | 'expired' | 'replayed';

export type ProofVerdict = { ok: true } | { ok: false; reason: ProofRefusal };

/** The nonces already spent, until they would have expired anyway. */
export type ProofLedger = Map<string, number>;

/** The session a proof is bound to, never the cookie itself. */
export function sessionFingerprint(sessionValue: string): string {
  return createHash('sha256').update(sessionValue).digest('base64url');
}

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintProof(input: {
  key: ConfirmationProofKey;
  sessionValue: string;
  secret: Buffer;
  now: number;
  nonce?: string;
}): string {
  const payload: ProofPayload = {
    k: input.key,
    s: sessionFingerprint(input.sessionValue),
    n: input.nonce ?? randomBytes(16).toString('base64url'),
    e: input.now + CONFIRMATION_PROOF_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, input.secret)}`;
}

/**
 * Checks a proof and, when it is good, spends it. The order is the point: the
 * signature before anything in the payload is believed, the scope and session
 * before the nonce is recorded, so a refused proof never uses up a good one.
 */
export function verifyAndSpendProof(input: {
  token: unknown;
  key: ConfirmationProofKey;
  sessionValue: string | null;
  secret: Buffer;
  now: number;
  ledger: ProofLedger;
}): ProofVerdict {
  const { token } = input;
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [encoded, signature] = parts as [string, string];

  const expected = Buffer.from(sign(encoded, input.secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }

  let payload: ProofPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ProofPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload?.k !== 'string' ||
    typeof payload.s !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.e !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.k !== input.key) return { ok: false, reason: 'scope' };
  if (!input.sessionValue || payload.s !== sessionFingerprint(input.sessionValue)) {
    return { ok: false, reason: 'session' };
  }
  if (payload.e <= input.now) return { ok: false, reason: 'expired' };

  pruneLedger(input.ledger, input.now);
  if (input.ledger.has(payload.n)) return { ok: false, reason: 'replayed' };
  input.ledger.set(payload.n, payload.e);
  return { ok: true };
}

function pruneLedger(ledger: ProofLedger, now: number) {
  for (const [nonce, expiresAt] of ledger) {
    if (expiresAt <= now) ledger.delete(nonce);
  }
}
