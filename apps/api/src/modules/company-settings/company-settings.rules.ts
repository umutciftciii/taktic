/**
 * What a company settings value has to be before it may be saved, and what it
 * has to be before a real transport may build a footer out of it.
 *
 * Two different questions, deliberately kept apart.
 *
 * **Saving** rejects what is simply not a value: blank, malformed, or the
 * development placeholder spelled out by hand. That is all an operator's form
 * can honestly refuse — this platform has no way to know whether a company is
 * called what it says it is called.
 *
 * **Sending** is stricter, and only for the transport that actually delivers.
 * An address on a reserved or documentation domain cannot receive mail by
 * definition (RFC 6761, RFC 2606) and loopback cannot receive it from outside
 * the host, so a footer telling a customer to write there is a dead end printed
 * as a promise. Rather than reject those at save time — where an operator
 * mid-way through configuring a staging stack has a legitimate use for them —
 * they are refused at the one moment they would mislead somebody.
 */

/** The placeholder a console preview shows. Never saveable, never sendable. */
export const DEVELOPMENT_SUPPORT_EMAIL = 'destek@example.test';

/** The product name. A legal entity is a different fact, so this is not one. */
export const DEVELOPMENT_COMPANY_NAME = 'TakTick';

export const COMPANY_LEGAL_NAME_MAX_LENGTH = 200;
export const COMPANY_SUPPORT_EMAIL_MAX_LENGTH = 254;
export const COMPANY_POSTAL_ADDRESS_MAX_LENGTH = 500;

/**
 * Deliberately the same shape the rest of this codebase uses for an address:
 * one `@`, no angle brackets, no whitespace, a dot in the host. Anything
 * cleverer would start rejecting addresses that work.
 */
export const EMAIL_ADDRESS_PATTERN = /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/;

/** Hosts that exist precisely so that nothing real is ever named. RFC 6761. */
const RESERVED_TOP_LEVEL_DOMAINS = ['test', 'example', 'invalid', 'localhost'];

/** Documentation domains. RFC 2606: reserved, and never deliverable. */
const DOCUMENTATION_DOMAINS = ['example.com', 'example.net', 'example.org'];

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function isWellFormedEmail(value: string): boolean {
  return EMAIL_ADDRESS_PATTERN.test(value) && value.length <= COMPANY_SUPPORT_EMAIL_MAX_LENGTH;
}

/**
 * Whether an address could ever receive a customer's reply.
 *
 * False for the placeholder, for loopback, for a reserved TLD and for the
 * documentation domains. Used only on the delivering path — see the module
 * comment.
 */
export function isDeliverableSupportEmail(value: string): boolean {
  if (!isWellFormedEmail(value) || value === DEVELOPMENT_SUPPORT_EMAIL) {
    return false;
  }

  const host = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  if (LOOPBACK_HOSTS.includes(host) || DOCUMENTATION_DOMAINS.includes(host)) {
    return false;
  }

  const tld = host.slice(host.lastIndexOf('.') + 1);
  return !RESERVED_TOP_LEVEL_DOMAINS.includes(tld);
}

/** Whether a legal name says anything beyond "this is the product". */
export function isPublishableCompanyName(value: string): boolean {
  return value.trim().length > 0 && value.trim() !== DEVELOPMENT_COMPANY_NAME;
}
