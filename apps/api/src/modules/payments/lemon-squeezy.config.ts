/**
 * Configuration for the Lemon Squeezy sandbox integration.
 *
 * Everything here is read from the environment on every call and validated
 * eagerly at boot (see payment-provider.config.ts). No value is ever echoed
 * back in an error message or an API response: the API key and the webhook
 * secret are credentials, and the store and variant identifiers are the two
 * fields an operator is most likely to paste a key into by mistake.
 *
 * There is no live counterpart to any of this. Every checkout this adapter
 * creates carries `test_mode: true`, and a webhook whose payload does not say
 * it is a test-mode event loads nothing — the sandbox is the whole of the
 * feature until Lemon Squeezy approves this marketplace in writing.
 */

export const LEMON_SQUEEZY_PROVIDER_KIND = 'lemon-squeezy-test';

export const DEFAULT_LEMON_SQUEEZY_API_BASE_URL = 'https://api.lemonsqueezy.com';

export const LEMON_SQUEEZY_CHECKOUTS_PATH = '/v1/checkouts';

export const DEFAULT_LEMON_SQUEEZY_TIMEOUT_MS = 10_000;
const MIN_LEMON_SQUEEZY_TIMEOUT_MS = 1_000;
const MAX_LEMON_SQUEEZY_TIMEOUT_MS = 60_000;

/** How long a freshly created hosted checkout stays usable. */
export const LEMON_SQUEEZY_CHECKOUT_TTL_MINUTES = 60;

/**
 * Shape checks only — the values never leave this process except as an
 * Authorization header, a request body field, or an HMAC key. Checking the
 * shape turns "the variable holds a placeholder, or the whole .env line" into a
 * boot failure instead of a 401 on the first checkout.
 */
const API_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{40,512}$/;
const NUMERIC_ID_PATTERN = /^[0-9]{1,20}$/;
const WEBHOOK_SECRET_PATTERN = /^[\x21-\x7e]{16,255}$/;
const PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The environment variables this integration reads, in the order an operator
 * should fill them in. Exported because the admin screen lists the ones that
 * are missing **by name** — it must never be able to show a value.
 */
export const LEMON_SQUEEZY_REQUIRED_ENV_KEYS = [
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
] as const;

export type LemonSqueezyConfig = {
  apiKey: string;
  storeId: string;
  webhookSecret: string;
  /** Credit package slug → Lemon Squeezy variant id. */
  variantsBySlug: ReadonlyMap<string, string>;
  apiBaseUrl: string;
  timeoutMs: number;
};

export function readLemonSqueezyConfig(): LemonSqueezyConfig {
  return {
    apiKey: readApiKey(),
    storeId: readStoreId(),
    webhookSecret: readWebhookSecret(),
    variantsBySlug: readVariantMap(),
    apiBaseUrl: readApiBaseUrl(),
    timeoutMs: readTimeoutMs(),
  };
}

/**
 * The names of the settings that are absent or malformed, for the admin
 * screen.
 *
 * Names only. Each entry is one of {@link LEMON_SQUEEZY_REQUIRED_ENV_KEYS} —
 * the reader below throws with the variable's name in the message and never its
 * contents, so mapping a failure back to a name cannot leak anything.
 */
export function missingLemonSqueezyConfigKeys(): string[] {
  const readers: Record<(typeof LEMON_SQUEEZY_REQUIRED_ENV_KEYS)[number], () => unknown> = {
    LEMON_SQUEEZY_API_KEY: readApiKey,
    LEMON_SQUEEZY_STORE_ID: readStoreId,
    LEMON_SQUEEZY_WEBHOOK_SECRET: readWebhookSecret,
    LEMON_SQUEEZY_VARIANT_MAP: readVariantMap,
  };

  return LEMON_SQUEEZY_REQUIRED_ENV_KEYS.filter((key) => {
    try {
      readers[key]();
      return false;
    } catch {
      return true;
    }
  });
}

export function checkoutsEndpoint(config: LemonSqueezyConfig): string {
  return `${config.apiBaseUrl}${LEMON_SQUEEZY_CHECKOUTS_PATH}`;
}

function readApiKey(): string {
  const raw = process.env.LEMON_SQUEEZY_API_KEY?.trim();
  if (!raw) {
    throw new Error(
      'LEMON_SQUEEZY_API_KEY is required when PAYMENT_PROVIDER=lemon-squeezy-test. Set it in the ' +
        'deployment environment only — it must never reach the repository, an example file or a ' +
        'log line. Use a key issued for the sandbox store.',
    );
  }

  if (!API_KEY_PATTERN.test(raw)) {
    throw new Error(
      'LEMON_SQUEEZY_API_KEY does not have the shape of a Lemon Squeezy API key. The value itself ' +
        'is deliberately not shown.',
    );
  }

  return raw;
}

function readStoreId(): string {
  const raw = process.env.LEMON_SQUEEZY_STORE_ID?.trim();
  if (!raw) {
    throw new Error(
      'LEMON_SQUEEZY_STORE_ID is required when PAYMENT_PROVIDER=lemon-squeezy-test: a webhook that ' +
        'names another store must not be able to load credits here.',
    );
  }

  if (!NUMERIC_ID_PATTERN.test(raw)) {
    throw new Error('LEMON_SQUEEZY_STORE_ID must be the numeric store id.');
  }

  return raw;
}

function readWebhookSecret(): string {
  const raw = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!raw) {
    throw new Error(
      'LEMON_SQUEEZY_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=lemon-squeezy-test: it is ' +
        'the only thing separating a real settlement notice from anyone who can reach the ' +
        'webhook URL.',
    );
  }

  if (!WEBHOOK_SECRET_PATTERN.test(raw)) {
    throw new Error(
      'LEMON_SQUEEZY_WEBHOOK_SECRET must be 16-255 printable, non-space characters. The value ' +
        'itself is deliberately not shown.',
    );
  }

  return raw;
}

/**
 * `slug:variantId` pairs, comma separated.
 *
 * The mapping is by credit package **slug** rather than by database id so it
 * survives a reseed, and it is an allow-list in both directions: a package with
 * no entry cannot be checked out through Lemon Squeezy at all, and a variant id
 * may stand for exactly one package.
 */
function readVariantMap(): ReadonlyMap<string, string> {
  const raw = process.env.LEMON_SQUEEZY_VARIANT_MAP?.trim();
  if (!raw) {
    throw new Error(
      'LEMON_SQUEEZY_VARIANT_MAP is required when PAYMENT_PROVIDER=lemon-squeezy-test. Format: ' +
        '"paket-slug:variantId,other-slug:otherVariantId".',
    );
  }

  const bySlug = new Map<string, string>();
  const seenVariants = new Set<string>();

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.indexOf(':');
    const slug = separator === -1 ? '' : trimmed.slice(0, separator).trim();
    const variantId = separator === -1 ? '' : trimmed.slice(separator + 1).trim();

    if (!PACKAGE_SLUG_PATTERN.test(slug) || !NUMERIC_ID_PATTERN.test(variantId)) {
      throw new Error(
        'LEMON_SQUEEZY_VARIANT_MAP entries must be "credit-package-slug:numericVariantId". The ' +
          'offending entry is deliberately not shown.',
      );
    }

    if (bySlug.has(slug)) {
      throw new Error(`LEMON_SQUEEZY_VARIANT_MAP maps the package slug "${slug}" more than once.`);
    }

    if (seenVariants.has(variantId)) {
      throw new Error(
        'LEMON_SQUEEZY_VARIANT_MAP maps one variant to more than one credit package, which would ' +
          'make a paid order ambiguous.',
      );
    }

    bySlug.set(slug, variantId);
    seenVariants.add(variantId);
  }

  if (bySlug.size === 0) {
    throw new Error('LEMON_SQUEEZY_VARIANT_MAP is empty: no credit package could be checked out.');
  }

  return bySlug;
}

/**
 * Where the sandbox API lives.
 *
 * Overridable so the browser suite can point the adapter at a local stand-in
 * and never reach Lemon Squeezy at all. The override is https-only outside
 * loopback, and loopback is only accepted outside production — which is
 * belt-and-braces, since `lemon-squeezy-test` cannot run in production either.
 */
function readApiBaseUrl(): string {
  const raw = process.env.LEMON_SQUEEZY_API_BASE_URL?.trim();
  if (!raw) {
    return DEFAULT_LEMON_SQUEEZY_API_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('LEMON_SQUEEZY_API_BASE_URL must be a valid absolute URL.');
  }

  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'LEMON_SQUEEZY_API_BASE_URL is a test seam and must not be set in production.',
    );
  }

  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error('LEMON_SQUEEZY_API_BASE_URL must use https unless it points at loopback.');
  }

  return parsed.toString().replace(/\/+$/, '');
}

function readTimeoutMs(): number {
  const raw = process.env.LEMON_SQUEEZY_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_LEMON_SQUEEZY_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_LEMON_SQUEEZY_TIMEOUT_MS ||
    parsed > MAX_LEMON_SQUEEZY_TIMEOUT_MS
  ) {
    throw new Error(
      `LEMON_SQUEEZY_TIMEOUT_MS must be a whole number of milliseconds between ` +
        `${MIN_LEMON_SQUEEZY_TIMEOUT_MS} and ${MAX_LEMON_SQUEEZY_TIMEOUT_MS}.`,
    );
  }

  return parsed;
}
