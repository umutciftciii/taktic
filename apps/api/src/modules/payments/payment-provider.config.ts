import { readLemonSqueezyConfig } from './lemon-squeezy.config';

/**
 * Which payment provider this process is wired to, and the rules that decide
 * whether it is allowed to exist at all.
 *
 * The set is a closed allow-list read from PAYMENT_PROVIDER. There is no
 * "whatever was in the variable" branch and no live branch: this phase ships a
 * sandbox integration only, so the file's job is as much about what it refuses
 * as about what it selects.
 *
 * Three refusals, and all three are deliberate:
 *
 * 1. An unrecognised PAYMENT_PROVIDER fails at boot rather than silently
 *    falling back to a provider nobody chose. The value is never echoed — a
 *    misconfiguration that pastes an API key into the wrong variable must not
 *    turn the boot log into the place that key finally gets written down.
 * 2. `lemon-squeezy-test` is refused under NODE_ENV=production. The sandbox
 *    provider settles nothing; a production deployment wired to it would hand
 *    out credits against payments that never happened.
 * 3. Any environment variable that could only mean "go live" fails the boot,
 *    whichever provider is selected. Lemon Squeezy's suitability for this
 *    marketplace has not been approved in writing, so live mode is not a switch
 *    that exists yet — not even one that is off.
 */

/**
 * The providers a process may be wired to.
 *
 * `mock` is the shipped default and the behaviour this repository has always
 * had: an in-app form that settles nothing and is labelled as such on screen.
 * `lemon-squeezy-test` talks to Lemon Squeezy's sandbox and can only ever
 * create test-mode checkouts.
 */
export const PAYMENT_PROVIDER_KINDS = ['mock', 'lemon-squeezy-test'] as const;

export type PaymentProviderKind = (typeof PAYMENT_PROVIDER_KINDS)[number];

export const DEFAULT_PAYMENT_PROVIDER: PaymentProviderKind = 'mock';

/**
 * What the Lemon Squeezy product this integration points at is selling, stated
 * once so the storefront copy, the checkout line item and the code that builds
 * it cannot drift apart.
 *
 * It is software usage credit for the provider's own account — the right to
 * send offers through this application. There is no service being sold here and
 * no money moving from a customer to a provider; naming it anything vaguer
 * would misrepresent the transaction to both the buyer and the payment
 * provider.
 */
export const CREDIT_PRODUCT_NAME = 'Provider software usage credits';
export const CREDIT_PRODUCT_DESCRIPTION_EN =
  'Prepaid software usage credits for a service provider account. Credits are spent to send ' +
  'offers inside the application. This is not a service purchase and no money is transferred ' +
  'from a customer to a provider.';
export const CREDIT_PRODUCT_DESCRIPTION_TR =
  'Hizmet veren hesabı için ön ödemeli yazılım kullanım kredisi. Krediler uygulama içinde teklif ' +
  'göndermek için harcanır. Bu bir hizmet satışı değildir ve müşteriden hizmet verene para ' +
  'aktarımı yoktur.';

/**
 * Environment variables that can only mean "start taking real money".
 *
 * Set to anything at all — including "false" — any one of these fails the boot.
 * That is stricter than reading them as booleans on purpose: this phase has no
 * live mode to turn off, so a deployment that carries the switch at all is a
 * deployment somebody is preparing to flip, and it should fail while a person
 * is still watching rather than the first time a card is charged.
 */
export const REFUSED_LIVE_MODE_ENV_KEYS = [
  'LEMON_SQUEEZY_LIVE_ENABLED',
  'LEMON_SQUEEZY_LIVE_API_KEY',
  'LEMON_SQUEEZY_LIVE_STORE_ID',
  'PAYMENT_LIVE_ENABLED',
] as const;

/** The only value LEMON_SQUEEZY_MODE may carry, if it is set at all. */
export const ONLY_SUPPORTED_LEMON_SQUEEZY_MODE = 'test';

/**
 * Read on every call rather than cached at import time, so a deployment (and a
 * test) sees the environment it actually has.
 */
export function resolvePaymentProviderKind(): PaymentProviderKind {
  const raw = process.env.PAYMENT_PROVIDER?.trim();

  if (!raw) {
    return DEFAULT_PAYMENT_PROVIDER;
  }

  if (!isPaymentProviderKind(raw)) {
    throw new Error(
      `PAYMENT_PROVIDER must be exactly one of: ${PAYMENT_PROVIDER_KINDS.join(', ')}. ` +
        'The value itself is deliberately not shown.',
    );
  }

  return raw;
}

export function isPaymentProviderKind(value: string): value is PaymentProviderKind {
  return (PAYMENT_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Called once at boot, before anything listens, so a misconfigured payment
 * provider is a startup failure rather than a surprise on the first checkout.
 */
export function assertPaymentProviderConfig(): void {
  assertNoLiveModeConfig();

  const kind = resolvePaymentProviderKind();

  if (kind === 'lemon-squeezy-test' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'PAYMENT_PROVIDER=lemon-squeezy-test cannot run under NODE_ENV=production: it is a sandbox ' +
        'integration that settles nothing, so a production process wired to it would load credits ' +
        'against payments that never happened. Keep PAYMENT_PROVIDER=mock.',
    );
  }

  if (kind === 'lemon-squeezy-test') {
    // Validates the API key, store, webhook secret and variant mapping. Throws
    // without echoing any of them.
    readLemonSqueezyConfig();
  }
}

/**
 * The live-mode refusal, checked whichever provider is selected.
 *
 * Kept separate from the provider switch so it also fires for a `mock`
 * deployment that has quietly started carrying live credentials.
 */
export function assertNoLiveModeConfig(): void {
  for (const key of REFUSED_LIVE_MODE_ENV_KEYS) {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      throw new Error(
        `${key} is set, but live payment collection is not part of this build. Lemon Squeezy has ` +
          'not approved this marketplace in writing, so there is no live mode to enable — remove ' +
          'the variable entirely rather than setting it to a falsy value.',
      );
    }
  }

  const mode = process.env.LEMON_SQUEEZY_MODE?.trim();
  if (mode !== undefined && mode !== '' && mode !== ONLY_SUPPORTED_LEMON_SQUEEZY_MODE) {
    throw new Error(
      `LEMON_SQUEEZY_MODE may only be "${ONLY_SUPPORTED_LEMON_SQUEEZY_MODE}" in this build. ` +
        'The value itself is deliberately not shown.',
    );
  }
}

/**
 * The base URL the provider-facing return links are built on. Mirrors the
 * claim-link resolver so both land on the same deployment of the web app.
 */
export function resolveWebAppBaseUrl(): string {
  const candidates = [
    process.env.WEB_APP_URL,
    process.env.WEB_ORIGIN,
    process.env.NEXT_PUBLIC_WEB_URL,
  ];

  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/\/+$/, '');
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return 'http://localhost:3000';
}
