import { publicAssetUrl } from '../../common/public-urls';

/**
 * The fixed parts of every transactional e-mail: who to write to for help, who
 * is sending, and where the logo lives.
 *
 * None of it is hard-coded to a real host. The support address and the postal
 * address are facts about a company, not about this codebase, so they are
 * configuration — and configuration a production deployment has to supply,
 * because a footer that names the wrong company is worse than one that names
 * none.
 *
 * Outside production there are fallbacks, and they are deliberately obviously
 * fake: `example.test` is reserved and unroutable, which is exactly what a
 * developer wants a preview to show. The postal address has no fallback at all
 * — an invented street would look real, and the footer simply omits the line
 * when there is nothing true to put there.
 */

/** Where the logo lives under the asset base. Shipped in apps/web/public. */
export const EMAIL_LOGO_PATH = '/brand/logo-email.png';

/** The rendered width in the card. The file itself is 1459×360 (≈4× retina). */
export const EMAIL_LOGO_WIDTH = 140;

/** Development fallback. Unroutable by RFC 6761, and visibly not a real inbox. */
export const DEVELOPMENT_SUPPORT_EMAIL = 'destek@example.test';

/** Development fallback. The product name, which is not a claim about a legal entity. */
export const DEVELOPMENT_COMPANY_NAME = 'TakTick';

export type EmailBranding = {
  supportEmail: string;
  companyName: string;
  /** Null when the deployment has not declared one; the footer line is dropped. */
  companyAddress: string | null;
  logoUrl: string;
};

const EMAIL_ADDRESS_PATTERN = /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/;

export function readEmailBranding(): EmailBranding {
  return {
    supportEmail: readSupportEmail(),
    companyName: readCompanyName(),
    companyAddress: readCompanyAddress(),
    logoUrl: publicAssetUrl(EMAIL_LOGO_PATH),
  };
}

/**
 * Called once at boot, alongside the transport check, so a production
 * deployment that forgot its support address fails to start rather than mailing
 * a footer that tells customers to write to `destek@example.test`.
 */
export function assertEmailBrandingConfig(): void {
  readEmailBranding();
}

function readSupportEmail(): string {
  const raw = process.env.SUPPORT_EMAIL?.trim();

  if (!raw) {
    if (isProduction()) {
      throw new Error(
        'SUPPORT_EMAIL is required in production: every transactional e-mail footer points ' +
          'customers at it, and the development fallback is an unroutable example address.',
      );
    }

    return DEVELOPMENT_SUPPORT_EMAIL;
  }

  if (!EMAIL_ADDRESS_PATTERN.test(raw)) {
    throw new Error(`SUPPORT_EMAIL must be a plain e-mail address (received "${raw}")`);
  }

  return raw;
}

function readCompanyName(): string {
  const raw = process.env.COMPANY_LEGAL_NAME?.trim();

  if (!raw) {
    if (isProduction()) {
      throw new Error(
        'COMPANY_LEGAL_NAME is required in production: the footer names the sender, and the ' +
          'development fallback is the product name rather than a legal entity.',
      );
    }

    return DEVELOPMENT_COMPANY_NAME;
  }

  return raw;
}

/**
 * The postal address, or nothing.
 *
 * Deliberately optional even in production. A wrong address is worse than an
 * absent one, and this codebase has no way to know the right one — so the only
 * honest default is to leave the line out.
 */
function readCompanyAddress(): string | null {
  const raw = process.env.COMPANY_POSTAL_ADDRESS?.trim();
  return raw ? raw : null;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
