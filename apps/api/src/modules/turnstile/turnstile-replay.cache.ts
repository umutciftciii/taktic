import { createHash } from 'node:crypto';
import { TURNSTILE_REPLAY_TTL_MS } from './turnstile.constants';

/**
 * Remembers which tokens this process has already seen, for as long as a
 * token could still be valid.
 *
 * Cloudflare itself refuses a token the second time it is verified, so this
 * is a second lock on the same door rather than the only one: it makes the
 * single-use rule hold even when the first verification never reached
 * Cloudflare (a timeout), and it makes the rule testable against the
 * deterministic verifier. A token is claimed on first sight, whatever the
 * verdict then is — a token that failed once is not worth a second call.
 *
 * Per process and in memory, like the throttler's storage. Only a SHA-256
 * digest is kept, never the token; expired entries are swept on each claim
 * from the oldest end, which is cheap because insertion order is age order.
 *
 * Not decorated: the TTL is a plain constructor argument, so the module binds
 * it through a factory rather than letting Nest try to resolve a number.
 */
export class TurnstileReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number = TURNSTILE_REPLAY_TTL_MS) {}

  /** True when this is the first sight of the token within the TTL. */
  claim(token: string, now: number = Date.now()): boolean {
    this.sweep(now);
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    if (this.seen.has(digest)) {
      return false;
    }
    this.seen.set(digest, now + this.ttlMs);
    return true;
  }

  /** For the suite's "digests, not tokens" check. */
  entries(): IterableIterator<[string, number]> {
    return this.seen.entries();
  }

  private sweep(now: number): void {
    for (const [digest, expiresAt] of this.seen) {
      if (expiresAt > now) {
        break;
      }
      this.seen.delete(digest);
    }
  }
}
