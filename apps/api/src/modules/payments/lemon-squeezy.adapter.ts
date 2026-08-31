import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CREDIT_PRODUCT_DESCRIPTION_EN,
  CREDIT_PRODUCT_NAME,
  PaymentProviderKind,
} from './payment-provider.config';
import {
  CheckoutSession,
  CheckoutSessionError,
  CheckoutSessionRequest,
  PaymentProviderCapabilities,
  PaymentProviderPort,
} from './payment-provider.port';
import {
  LEMON_SQUEEZY_CHECKOUT_TTL_MINUTES,
  checkoutsEndpoint,
  readLemonSqueezyConfig,
} from './lemon-squeezy.config';

/** The slice of `fetch` this adapter uses. Kept narrow so a test can stand in. */
export type LemonSqueezyFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<LemonSqueezyResponse>;

export type LemonSqueezyResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

/** Injection token for the fetch implementation; unbound in the real graph. */
export const LEMON_SQUEEZY_FETCH = Symbol('LEMON_SQUEEZY_FETCH');

/**
 * The sandbox checkout transport: a typed HTTP client for Lemon Squeezy's
 * `POST /v1/checkouts`.
 *
 * Written against `fetch` rather than the official SDK for the same reason the
 * e-mail transport is: one endpoint, one JSON:API body and one header is not
 * enough surface to justify a dependency that would bring its own retry,
 * logging and error-shape opinions into a path whose whole design is about what
 * must *not* be logged.
 *
 * What this adapter refuses to do is as much of its contract as what it does:
 *
 * - `test_mode: true` is sent on every checkout and is not configurable. There
 *   is no code path in this build that can create a live checkout.
 * - The price is pinned to this application's own snapshot via `custom_price`,
 *   so a variant repriced in the Lemon Squeezy dashboard cannot change what a
 *   provider is charged. The webhook re-checks the settled total anyway.
 * - The API key exists in one place, the Authorization header. It is never
 *   logged, never put in an error and never returned.
 * - A failed response's body is never read. Only the HTTP status is used, and
 *   only to pick one of the closed failure classes.
 * - The only thing sent as checkout metadata is this application's own opaque
 *   correlation token. No provider name, no e-mail address, no purchase note.
 */
@Injectable()
export class LemonSqueezyCheckoutAdapter extends PaymentProviderPort {
  readonly kind: PaymentProviderKind = 'lemon-squeezy-test';

  /**
   * No automatic renewal, for two independent reasons — either one alone would
   * be enough.
   *
   * The first is the integration's shape. This adapter opens one-off checkouts
   * (`POST /v1/checkouts` against a fixed variant, `custom_price` pinned to this
   * application's own snapshot) and stores nothing but the checkout's opaque id.
   * Lemon Squeezy is a merchant of record: it holds the buyer's card, and it
   * exposes no endpoint that lets this application charge a card on file of its
   * own accord. Recurring billing there is a property of a *subscription
   * variant* that Lemon Squeezy itself bills on its own schedule — a different
   * product configuration, a different checkout, and a different set of webhook
   * events (`subscription_payment_success` and friends) than the `order_created`
   * this build accepts.
   *
   * The second is that this build has no live mode at all, and refuses to boot
   * with one (see payment-provider.config.ts). A renewal "succeeding" against a
   * sandbox would be a period granted for money that never moved.
   *
   * So the honest answer here is false, and the feature is presented to
   * providers as unavailable rather than as coming soon.
   */
  readonly capabilities: PaymentProviderCapabilities = {
    automaticRenewal: false,
    automaticRenewalUnsupportedReason: 'NO_LIVE_MODE',
  };

  private readonly logger = new Logger('LemonSqueezyCheckout');
  private readonly fetchImpl: LemonSqueezyFetch;

  constructor(@Optional() @Inject(LEMON_SQUEEZY_FETCH) fetchImpl?: LemonSqueezyFetch) {
    super();
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => globalThis.fetch(input, init) as unknown as Promise<LemonSqueezyResponse>);
  }

  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    // Read per call, like every other configuration switch in this repository,
    // so a rotated key takes effect without a redeploy of the process's
    // assumptions.
    const config = readLemonSqueezyConfig();

    const variantId = config.variantsBySlug.get(request.packageSlug);
    if (!variantId) {
      // An allow-list miss, not a provider failure: this package was never
      // mapped to a sandbox variant, so there is nothing to open.
      throw new CheckoutSessionError('PACKAGE_NOT_MAPPED');
    }

    const expiresAt = new Date(Date.now() + LEMON_SQUEEZY_CHECKOUT_TTL_MINUTES * 60 * 1000);

    const response = await this.post(config.apiKey, config.timeoutMs, checkoutsEndpoint(config), {
      data: {
        type: 'checkouts',
        attributes: {
          // Sandbox only, always, unconditionally.
          test_mode: true,
          custom_price: request.priceAmount,
          product_options: {
            name: `${CREDIT_PRODUCT_NAME} — ${request.packageName}`,
            description: CREDIT_PRODUCT_DESCRIPTION_EN,
            redirect_url: request.returnUrl,
          },
          checkout_options: { embed: false },
          checkout_data: {
            // The one field that travels: this application's own token. It
            // identifies the purchase to us and nothing to anyone else.
            custom: { purchase_reference: request.reference },
          },
          expires_at: expiresAt.toISOString(),
        },
        relationships: {
          store: { data: { type: 'stores', id: config.storeId } },
          variant: { data: { type: 'variants', id: variantId } },
        },
      },
    });

    if (!response.ok) {
      throw new CheckoutSessionError(classifyStatus(response.status), response.status);
    }

    const parsed = await readCheckout(response);
    if (!parsed) {
      throw new CheckoutSessionError('PROVIDER_RESPONSE_INVALID', response.status);
    }

    this.logger.log(`test-mode checkout opened for purchase ${request.purchaseId}`);

    return {
      provider: this.kind,
      url: parsed.url,
      providerCheckoutId: parsed.id,
      expiresAt: parsed.expiresAt ?? expiresAt,
    };
  }

  private async post(
    apiKey: string,
    timeoutMs: number,
    endpoint: string,
    body: unknown,
  ): Promise<LemonSqueezyResponse> {
    try {
      return await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/vnd.api+json',
          accept: 'application/vnd.api+json',
        },
        body: JSON.stringify(body),
        // A hung socket must not hold the HTTP request that triggered it.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CheckoutSessionError(classifyTransportFailure(error));
    }
  }
}

/**
 * Maps a response status onto the closed set of failure classes. Coarse on
 * purpose: it separates "this deployment is misconfigured or the sandbox is
 * down" from "this particular request will never work".
 */
function classifyStatus(status: number): CheckoutSessionError['failureCode'] {
  if (status === 408 || status === 504) {
    return 'PROVIDER_TIMEOUT';
  }

  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return 'PROVIDER_UNAVAILABLE';
  }

  return 'PROVIDER_REJECTED';
}

function classifyTransportFailure(error: unknown): CheckoutSessionError['failureCode'] {
  const name = (error as { name?: unknown } | null)?.name;

  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'PROVIDER_TIMEOUT';
  }

  return 'PROVIDER_UNAVAILABLE';
}

/**
 * Reads the hosted checkout out of a success body.
 *
 * Everything is validated rather than trusted: the URL must be an https URL (a
 * provider that answered with a `javascript:` or a plain-http location must not
 * be able to put it in front of a provider's browser), and the id must be a
 * plain opaque identifier, because it is stored and later shown to an operator.
 */
async function readCheckout(
  response: LemonSqueezyResponse,
): Promise<{ id: string; url: string; expiresAt: Date | null } | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const data = (payload as { data?: unknown } | null)?.data as
    | { id?: unknown; attributes?: { url?: unknown; expires_at?: unknown } }
    | undefined;

  const id = data?.id;
  const url = data?.attributes?.url;

  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    return null;
  }

  if (typeof url !== 'string' || !isSafeCheckoutUrl(url)) {
    return null;
  }

  return { id, url, expiresAt: readExpiry(data?.attributes?.expires_at) };
}

/**
 * https, or loopback http when a stand-in sandbox is configured for the browser
 * suite. Nothing else: this URL is handed straight to a redirect.
 */
function isSafeCheckoutUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === 'https:') {
    return true;
  }

  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    process.env.NODE_ENV !== 'production'
  );
}

function readExpiry(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
