import { publicAssetUrl } from '../../common/public-urls';
import { isDeliveringEmailTransportConfigured } from './email-transport';

/**
 * The fixed parts of every transactional e-mail: who to write to for help, who
 * is sending, and where the logo lives.
 *
 * None of it is hard-coded to a real host. The support address and the postal
 * address are facts about a company, not about this codebase, so they are
 * configuration — and configuration a deployment that actually delivers mail
 * has to supply, because a footer that names the wrong company is worse than
 * one that names none.
 *
 * **What "has to supply" keys on is the transport, not NODE_ENV.** This module
 * used to demand real values only under `NODE_ENV=production`, and the result
 * was a real, DKIM-signed message — sent through Resend from a process that
 * happened to say `development` — telling a customer to write to
 * `destek@example.test`. NODE_ENV describes how the process was started;
 * `EMAIL_TRANSPORT=resend` describes whether a stranger receives what it
 * composes, and that is the only question the footer cares about. Production
 * stays a trigger too, because a production process is required to deliver
 * anyway and failing earlier is never worse.
 *
 * With no delivering transport the fallbacks stand, and they are deliberately
 * obviously fake: `example.test` is reserved and unroutable, which is exactly
 * what a developer wants a console preview or a recorded outbox to show. The
 * postal address has no fallback at all — an invented street would look real,
 * and the footer simply omits the line when there is nothing true to put there.
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
 * Called once at boot, alongside the transport check, so a deployment that
 * forgot its support address fails to start rather than mailing a footer that
 * tells customers to write to `destek@example.test`.
 */
export function assertEmailBrandingConfig(): void {
  readEmailBranding();
}

/**
 * Whether this process may only use published branding.
 *
 * True as soon as anything it composes can reach a stranger's inbox. The
 * transport is the authority; production is kept as a second trigger so the
 * rule cannot be weakened by a deployment that has not chosen its transport
 * yet.
 */
function requiresPublishedBranding(): boolean {
  return isProduction() || isDeliveringEmailTransportConfigured();
}

function readSupportEmail(): string {
  const raw = process.env.SUPPORT_EMAIL?.trim();

  if (!raw) {
    if (requiresPublishedBranding()) {
      throw new Error(
        'SUPPORT_EMAIL is required once e-mail is actually delivered (EMAIL_TRANSPORT=resend, or ' +
          'NODE_ENV=production): every transactional e-mail footer points customers at it, and ' +
          'the development fallback is an unroutable example address.',
      );
    }

    return DEVELOPMENT_SUPPORT_EMAIL;
  }

  if (!EMAIL_ADDRESS_PATTERN.test(raw)) {
    throw new Error(`SUPPORT_EMAIL must be a plain e-mail address (received "${raw}")`);
  }

  // Spelling the fallback out by hand is not a way round the rule above. The
  // placeholder exists so a console preview shows something obviously fake; a
  // process that delivers must not be able to opt back into it.
  if (raw === DEVELOPMENT_SUPPORT_EMAIL && requiresPublishedBranding()) {
    throw new Error(
      `SUPPORT_EMAIL must not be the development placeholder ("${DEVELOPMENT_SUPPORT_EMAIL}") ` +
        'once e-mail is actually delivered: it is an unroutable address, and the footer tells ' +
        'customers to write to it.',
    );
  }

  return raw;
}

function readCompanyName(): string {
  const raw = process.env.COMPANY_LEGAL_NAME?.trim();

  if (!raw) {
    if (requiresPublishedBranding()) {
      throw new Error(
        'COMPANY_LEGAL_NAME is required once e-mail is actually delivered ' +
          '(EMAIL_TRANSPORT=resend, or NODE_ENV=production): the footer names the sender, and ' +
          'the development fallback is the product name rather than a legal entity.',
      );
    }

    return DEVELOPMENT_COMPANY_NAME;
  }

  // Same rule, one field over: the product name is not a legal entity, and a
  // footer that names one is the point of the field.
  if (raw === DEVELOPMENT_COMPANY_NAME && requiresPublishedBranding()) {
    throw new Error(
      `COMPANY_LEGAL_NAME must not be the development placeholder ("${DEVELOPMENT_COMPANY_NAME}") ` +
        'once e-mail is actually delivered: it is the product name, not the sender’s legal name.',
    );
  }

  return raw;
}

/**
 * The postal address, or nothing.
 *
 * Deliberately optional even when the mail really goes out. A wrong address is
 * worse than an absent one, and this codebase has no way to know the right one
 * — so the only honest default is to leave the line out.
 */
function readCompanyAddress(): string | null {
  const raw = process.env.COMPANY_POSTAL_ADDRESS?.trim();
  return raw ? raw : null;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
