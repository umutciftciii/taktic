/**
 * Configuration for the Resend transport.
 *
 * Everything here is read from the environment on every call and validated
 * eagerly at boot (see email-transport.ts). No value is ever echoed back in an
 * error message: the API key is a credential, and the sender address is the one
 * field an operator is most likely to paste a key into by mistake.
 */

/** The domain verified in Resend. Nothing else may appear in EMAIL_FROM. */
export const RESEND_VERIFIED_DOMAIN = 'notify.taktick.com.tr';

/**
 * The region the verified domain lives in. Recorded here because it is part of
 * the deployment's identity — the DNS records, the suppression list and the
 * delivery logs all belong to this region — not because the API endpoint
 * changes: Resend serves one host and routes by domain.
 */
export const RESEND_REGION = 'eu-west-1';

/** The only sender a production deployment may use. */
export const RESEND_PRODUCTION_SENDER_ADDRESS = `noreply@${RESEND_VERIFIED_DOMAIN}`;

/** The shipped sender, and the default outside production. */
export const DEFAULT_EMAIL_FROM = `Taktick <${RESEND_PRODUCTION_SENDER_ADDRESS}>`;

export const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';

export const DEFAULT_RESEND_TIMEOUT_MS = 10_000;
const MIN_RESEND_TIMEOUT_MS = 1_000;
const MAX_RESEND_TIMEOUT_MS = 60_000;

/**
 * Publicly documented shape of a Resend key. Checking it turns "the key is a
 * placeholder, or the whole .env line" into a boot failure instead of a 401 on
 * the first activation mail. It is a shape check only — the value never leaves
 * this process except as an Authorization header.
 */
const RESEND_API_KEY_PATTERN = /^re_[A-Za-z0-9_-]{8,}$/;

/** `Name <local@domain>` or a bare `local@domain`. */
const FROM_PATTERN = /^(?:(?<name>[^<>]*)<(?<angle>[^<>@\s]+@[^<>@\s]+)>|(?<bare>[^<>@\s]+@[^<>@\s]+))$/;

export type ResendConfig = {
  apiKey: string;
  from: string;
  timeoutMs: number;
};

export function readResendConfig(): ResendConfig {
  return {
    apiKey: readApiKey(),
    from: readFrom(),
    timeoutMs: readTimeoutMs(),
  };
}

function readApiKey(): string {
  const raw = process.env.RESEND_API_KEY?.trim();
  if (!raw) {
    throw new Error(
      'RESEND_API_KEY is required when EMAIL_TRANSPORT=resend. Set it in the deployment ' +
        'environment only — it must never reach the repository, an example file or a log line.',
    );
  }

  if (!RESEND_API_KEY_PATTERN.test(raw)) {
    throw new Error(
      'RESEND_API_KEY does not have the shape of a Resend API key (expected the "re_…" form). ' +
        'The value itself is deliberately not shown.',
    );
  }

  return raw;
}

/**
 * The sender.
 *
 * Outside production this defaults to the shipped value, so a developer who
 * opts into the real transport for a smoke test does not have to reconstruct
 * it. In production it is mandatory and pinned: an address on another domain
 * would not be signed by the verified domain's DKIM key, which is how a
 * transactional mail turns into a spam-folder mail.
 */
function readFrom(): string {
  const raw = process.env.EMAIL_FROM?.trim();

  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `EMAIL_FROM is required in production and must be "${DEFAULT_EMAIL_FROM}": only the ` +
          `verified domain ${RESEND_VERIFIED_DOMAIN} is signed for this deployment.`,
      );
    }

    return DEFAULT_EMAIL_FROM;
  }

  const address = parseFromAddress(raw);

  if (domainOf(address) !== RESEND_VERIFIED_DOMAIN) {
    throw new Error(
      `EMAIL_FROM must use an address on the verified Resend domain ${RESEND_VERIFIED_DOMAIN}.`,
    );
  }

  if (
    process.env.NODE_ENV === 'production' &&
    address.toLowerCase() !== RESEND_PRODUCTION_SENDER_ADDRESS
  ) {
    throw new Error(
      `EMAIL_FROM must send as ${RESEND_PRODUCTION_SENDER_ADDRESS} in production.`,
    );
  }

  return raw;
}

function parseFromAddress(raw: string): string {
  const match = FROM_PATTERN.exec(raw);
  const address = match?.groups?.angle ?? match?.groups?.bare;

  if (!address) {
    throw new Error(
      'EMAIL_FROM must be an e-mail address, optionally with a display name: ' +
        '"Taktick <noreply@example.com>".',
    );
  }

  return address;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * How long a single send may take before it is abandoned. A request that hangs
 * would otherwise hold the scheduler — or the HTTP request that triggered it —
 * for as long as the provider's own socket timeout allows.
 */
function readTimeoutMs(): number {
  const raw = process.env.RESEND_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_RESEND_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_RESEND_TIMEOUT_MS ||
    parsed > MAX_RESEND_TIMEOUT_MS
  ) {
    throw new Error(
      `RESEND_TIMEOUT_MS must be a whole number of milliseconds between ` +
        `${MIN_RESEND_TIMEOUT_MS} and ${MAX_RESEND_TIMEOUT_MS}.`,
    );
  }

  return parsed;
}
