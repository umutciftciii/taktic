import { Logger } from '@nestjs/common';
import { TURNSTILE_TOKEN_MAX_LENGTH } from './turnstile.constants';
import type { TurnstileConfig } from './turnstile.config';
import { TurnstileVerifierPort, TurnstileVerdict, TurnstileVerifyInput } from './turnstile-verifier.port';

export const CLOUDFLARE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type CloudflareConfig = Extract<TurnstileConfig, { mode: 'cloudflare' }>;

/** The subset of a siteverify answer this verifier reads. */
type SiteverifyBody = {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
};

type WarnSink = { warn(message: string): void };

/**
 * Asks Cloudflare whether a token is genuine, and accepts the answer only when
 * it says what this deployment expects.
 *
 * Three checks, all mandatory: `success` must be true; `hostname` must be one
 * of the hostnames this deployment serves the widget on, so a token solved on
 * somebody else's page is worthless here; `action` must name the operation
 * the request is about to perform, so a token minted for the identity
 * pre-check cannot open a request. Cloudflare also refuses a token the second
 * time it sees one (`timeout-or-duplicate`), which the guard's own replay
 * cache backs up for the window between two instances.
 *
 * Everything that is not a readable "yes" or a readable "no" — a timeout, a
 * refused connection, a 5xx, a body that is not JSON — is
 * VERIFIER_UNAVAILABLE, and the guard turns that into a refusal. Fail closed:
 * a Cloudflare outage makes the request forms wait, not the spam filter lapse.
 *
 * `fetch` is a constructor argument so the suite can stand Cloudflare in and
 * assert on the exact request without a byte leaving the process.
 */
export class CloudflareTurnstileVerifier extends TurnstileVerifierPort {
  private readonly logger: WarnSink;

  constructor(
    private readonly config: CloudflareConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    logger: WarnSink = new Logger(CloudflareTurnstileVerifier.name),
  ) {
    super();
    this.logger = logger;
  }

  async verify(input: TurnstileVerifyInput): Promise<TurnstileVerdict> {
    const token = input.token?.trim() ?? '';
    if (!token) {
      return { ok: false, reason: 'TOKEN_MISSING' };
    }
    if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
      return { ok: false, reason: 'TOKEN_INVALID' };
    }

    const body = new URLSearchParams({ secret: this.config.secretKey, response: token });
    if (input.remoteIp) {
      body.set('remoteip', input.remoteIp);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.siteverifyTimeoutMs);

    let answer: SiteverifyBody;
    try {
      const response = await this.fetchImpl(CLOUDFLARE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`siteverify answered HTTP ${response.status}; refusing (action=${input.action})`);
        return { ok: false, reason: 'VERIFIER_UNAVAILABLE' };
      }
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.warn(`siteverify answered with a body that is not an object; refusing (action=${input.action})`);
        return { ok: false, reason: 'VERIFIER_UNAVAILABLE' };
      }
      answer = parsed as SiteverifyBody;
    } catch (error) {
      // A timeout, a refused connection, a body that is not JSON. The message
      // is the transport's own and never contains the token or the secret;
      // the stack is dropped for the same reason.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.warn(`siteverify could not be asked; refusing (action=${input.action}, ${detail})`);
      return { ok: false, reason: 'VERIFIER_UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }

    if (answer.success !== true) {
      const codes = Array.isArray(answer['error-codes']) ? answer['error-codes'].map(String).join(',') : '-';
      this.logger.warn(`siteverify refused the token (action=${input.action}, error-codes=${codes})`);
      return { ok: false, reason: 'TOKEN_INVALID' };
    }

    const hostname = typeof answer.hostname === 'string' ? answer.hostname.trim().toLowerCase() : '';
    if (!hostname || !this.config.expectedHostnames.has(hostname)) {
      this.logger.warn(`siteverify hostname is not one this deployment serves (action=${input.action})`);
      return { ok: false, reason: 'HOSTNAME_MISMATCH' };
    }

    if (answer.action !== input.action) {
      this.logger.warn(`siteverify action does not name this operation (expected ${input.action})`);
      return { ok: false, reason: 'ACTION_MISMATCH' };
    }

    return { ok: true };
  }
}
