import { publicAssetUrl } from '../../common/public-urls';
import {
  DEVELOPMENT_COMPANY_NAME,
  DEVELOPMENT_SUPPORT_EMAIL,
  isWellFormedEmail,
} from '../company-settings/company-settings.rules';

/**
 * The fixed parts of every transactional e-mail: who to write to for help, who
 * is sending, and where the logo lives.
 *
 * **The company half of this is no longer configuration.** The legal name, the
 * support address and the postal address are business facts an operator
 * maintains from the admin panel — see CompanySettings — because they change
 * when the company changes and fixing a typo in a footer should not need a
 * redeploy. This module keeps only what is left: the logo, the shape of the
 * value, and the deliberately-fake placeholders a local preview shows.
 *
 * The two environment variables below still work and are read when no settings
 * row exists yet, so a deployment that already set them keeps its footer while
 * an operator moves the values into the panel. They are deprecated: nothing
 * requires them, nothing fails to boot without them, and the panel wins
 * whenever a row exists.
 */

/** Where the logo lives under the asset base. Shipped in apps/web/public. */
export const EMAIL_LOGO_PATH = '/brand/logo-email.png';

/** The rendered width in the card. The file itself is 1459×360 (≈4× retina). */
export const EMAIL_LOGO_WIDTH = 140;

/**
 * Re-exported from the rules module so there is one definition of each
 * placeholder: the admin form refuses to save them and the delivering transport
 * refuses to send them, and those two must be talking about the same strings.
 */
export { DEVELOPMENT_COMPANY_NAME, DEVELOPMENT_SUPPORT_EMAIL };

export type EmailBranding = {
  supportEmail: string;
  companyName: string;
  /** Null when nothing true is on file; the footer line is dropped. */
  companyAddress: string | null;
  logoUrl: string;
};

/** The company half, before it is known whether it is complete. */
export type CompanyBrandingValues = {
  legalName: string | null;
  supportEmail: string | null;
  postalAddress: string | null;
};

/** The deployment's own logo URL. Built from WEB_APP_URL, which stays technical. */
export function emailLogoUrl(): string {
  return publicAssetUrl(EMAIL_LOGO_PATH);
}

/**
 * The obviously-fake footer a console preview or a recorded outbox shows.
 *
 * `example.test` is reserved and unroutable by RFC 6761, which is exactly the
 * point: a developer must be able to tell at a glance that this is not a real
 * inbox. A delivering transport never reaches this function.
 */
export function developmentBranding(): EmailBranding {
  return {
    supportEmail: DEVELOPMENT_SUPPORT_EMAIL,
    companyName: DEVELOPMENT_COMPANY_NAME,
    companyAddress: null,
    logoUrl: emailLogoUrl(),
  };
}

/**
 * The deprecated environment fallback, read only when no settings row exists.
 *
 * Absent values are null rather than an error: these variables are no longer
 * required, and a deployment that never set them is not misconfigured — it is
 * one whose operator has not opened the admin screen yet.
 */
export function readDeprecatedEnvBranding(): CompanyBrandingValues {
  return {
    legalName: nonEmptyEnv('COMPANY_LEGAL_NAME'),
    supportEmail: readDeprecatedEnvSupportEmail(),
    postalAddress: nonEmptyEnv('COMPANY_POSTAL_ADDRESS'),
  };
}

/**
 * Called once at boot.
 *
 * It no longer demands anything. A process with no company settings anywhere
 * starts perfectly well — refusing to boot over a footer would take an entire
 * marketplace offline for a value an operator can now type into a form, and the
 * send path already refuses to mail a half-filled footer.
 *
 * What it still refuses is a variable that is *set to nonsense*. Silently
 * ignoring `SUPPORT_EMAIL="destek sayfası"` would leave an operator convinced
 * they had configured something.
 */
export function assertEmailBrandingConfig(): void {
  readDeprecatedEnvSupportEmail();
}

function readDeprecatedEnvSupportEmail(): string | null {
  const raw = nonEmptyEnv('SUPPORT_EMAIL');
  if (raw === null) {
    return null;
  }

  if (!isWellFormedEmail(raw)) {
    throw new Error(
      `SUPPORT_EMAIL must be a plain e-mail address (received "${raw}"). It is deprecated — ` +
        'set the support address from the admin panel instead — but a value that is set must ' +
        'still be a value.',
    );
  }

  return raw.toLowerCase();
}

function nonEmptyEnv(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}
