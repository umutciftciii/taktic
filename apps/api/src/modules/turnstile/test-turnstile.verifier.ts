import { TURNSTILE_TEST_TOKEN_PREFIX, TURNSTILE_TEST_UNAVAILABLE_ACTION } from './turnstile.constants';
import { TurnstileVerifierPort, TurnstileVerdict, TurnstileVerifyInput } from './turnstile-verifier.port';

/**
 * The verifier behind TURNSTILE_MODE=test: no network, no secret, one shape.
 *
 * `turnstile-test:<action>:<nonce>` is accepted when `<action>` names the
 * operation the request is performing, so the browser suite proves the same
 * things the real verifier enforces — the token reached the API, it was
 * minted for this operation, and (through the guard's replay cache) it is
 * used once. `<action>` of `__unavailable__` answers as an unreachable
 * Cloudflare, so the "try again" path can be driven from a browser. Any other
 * value, including a real Cloudflare token, is refused: this verifier is bound
 * only where turnstile.config.ts permits a bypass, and even there it accepts
 * nothing it did not define.
 */
export class TestTurnstileVerifier extends TurnstileVerifierPort {
  async verify(input: TurnstileVerifyInput): Promise<TurnstileVerdict> {
    const token = input.token?.trim() ?? '';
    if (!token) {
      return { ok: false, reason: 'TOKEN_MISSING' };
    }
    if (!token.startsWith(TURNSTILE_TEST_TOKEN_PREFIX)) {
      return { ok: false, reason: 'TOKEN_INVALID' };
    }
    const [action, nonce] = token.slice(TURNSTILE_TEST_TOKEN_PREFIX.length).split(':');
    if (!action || !nonce) {
      return { ok: false, reason: 'TOKEN_INVALID' };
    }
    if (action === TURNSTILE_TEST_UNAVAILABLE_ACTION) {
      return { ok: false, reason: 'VERIFIER_UNAVAILABLE' };
    }
    if (action !== input.action) {
      return { ok: false, reason: 'ACTION_MISMATCH' };
    }
    return { ok: true };
  }
}
