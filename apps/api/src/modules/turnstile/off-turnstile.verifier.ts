import { TurnstileVerifierPort, TurnstileVerdict } from './turnstile-verifier.port';

/**
 * TURNSTILE_MODE=off: every request passes, token or not. Bound only where
 * turnstile.config.ts permits a bypass — the integration suite, a declared
 * local stack — and never on staging or production.
 */
export class OffTurnstileVerifier extends TurnstileVerifierPort {
  async verify(): Promise<TurnstileVerdict> {
    return { ok: true };
  }
}
