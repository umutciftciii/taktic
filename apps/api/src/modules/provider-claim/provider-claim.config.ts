import { ProviderStatus } from '@prisma/client';
import { isDeliveringEmailTransportConfigured } from '../notifications/email-transport';

/**
 * Configuration for taking ownership of a guest provider application.
 *
 * The feature is off unless PROVIDER_CLAIM_ENABLED says otherwise, and in
 * production it additionally requires a transport that can actually deliver
 * e-mail. There is no partial state and no silent fallback: a production
 * deployment that turns the flag on without a delivering transport fails to
 * boot.
 *
 * That strictness is the whole safety story of the feature. A claim is granted
 * on one piece of evidence — the applicant received a link at the address on
 * the application — so a process that cannot send that link would issue tokens
 * nobody can ever receive. The console adapter refuses to print an action URL
 * outside development and the file outbox cannot exist in production, so
 * neither counts (see notifications/email-transport.ts).
 */

/** Returned when a claim endpoint is reached while the feature is off. */
export const PROVIDER_CLAIM_DISABLED_CODE = 'PROVIDER_CLAIM_DISABLED';

/** How long a freshly issued claim link stays usable. */
export const PROVIDER_CLAIM_TOKEN_TTL_HOURS = 72;

/** Where the web app renders the claim screen. */
export const PROVIDER_CLAIM_PATH = '/claim-provider';

/** Claim invitations one application may receive per hour. */
export const PROVIDER_CLAIM_MAX_SENDS_PER_PROVIDER_PER_HOUR = 3;

/** Claim invitations one client address may trigger per hour. */
export const PROVIDER_CLAIM_MAX_SENDS_PER_IP_PER_HOUR = 10;

export const PROVIDER_CLAIM_RATE_WINDOW_MINUTES = 60;

/**
 * The application states a claim may act on.
 *
 * An allow-list, so a status added later stays unclaimable until somebody
 * decides otherwise. DRAFT is out because such an application was never
 * submitted; REJECTED and SUSPENDED are out because handing a moderation
 * decision to whoever holds a link is not this flow's job.
 */
export const CLAIMABLE_PROVIDER_STATUSES: ReadonlySet<ProviderStatus> = new Set([
  ProviderStatus.PENDING_REVIEW,
  ProviderStatus.APPROVED,
]);

export function isClaimableProviderStatus(status: ProviderStatus): boolean {
  return CLAIMABLE_PROVIDER_STATUSES.has(status);
}

/**
 * Read on every call rather than cached at import time, so a deployment (and a
 * test) sees the environment it actually has.
 */
export function isProviderClaimEnabled(): boolean {
  return readStrictBoolean('PROVIDER_CLAIM_ENABLED', false);
}

/**
 * Called once at boot so a misconfiguration is a startup failure rather than a
 * surprise on the first application.
 */
export function assertProviderClaimConfig(): void {
  if (!isProviderClaimEnabled()) {
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (!isDeliveringEmailTransportConfigured()) {
    throw new Error(
      'PROVIDER_CLAIM_ENABLED=true requires a real, configured e-mail transport in production: ' +
        'the claim link is the only proof of mailbox ownership the flow has, and neither the ' +
        'console adapter nor the file outbox delivers it. Wire an e-mail provider, or keep the ' +
        'flag off.',
    );
  }
}

/**
 * The base URL the claim link is built on. Mirrors the customer activation
 * resolver so both links land on the same deployment of the web app.
 */
export function getWebAppBaseUrl(): string {
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

function readStrictBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error(`${name} must be exactly "true" or "false" (received "${raw}")`);
}
