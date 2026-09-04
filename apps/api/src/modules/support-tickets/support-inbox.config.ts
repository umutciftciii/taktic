import { Logger } from '@nestjs/common';
import { isWellFormedEmail } from '../company-settings/company-settings.rules';

/**
 * The one place that knows where a support ticket is announced, and where a
 * customer's reply to a support e-mail comes back to.
 *
 * Two properties, and both are deliberate:
 *
 * 1. **One setting, both directions.** `SUPPORT_INBOX_EMAIL` names the mailbox
 *    a new ticket is announced to *and* the Reply-To a customer's mail client
 *    answers. A deployment that moved its inbox but left a Reply-To pointing at
 *    the old one would have moved nothing — the customer's answer would land
 *    where nobody looks, on a ticket the platform has already told them it is
 *    reading.
 * 2. **Nothing here stops the process.** The address is resolved on every call
 *    and every path ends in one. A support mailbox is not the kind of fact that
 *    should be able to take authentication, the admin panel and every request
 *    flow offline at boot, so a missing value is the ordinary case and a
 *    malformed one falls back with a warning rather than an exception.
 *
 * The default is a real deliverable address rather than a placeholder in a
 * reserved domain, which is the opposite of the choice
 * {@link import('../notifications/email-branding.config').developmentBranding}
 * makes for the footer — and for a reason. A wrong footer is a wrong sentence;
 * an undeliverable support inbox is a ticket nobody ever reads, after the
 * customer has already been told somebody is listening.
 */

/** The shipped mailbox. Used whenever SUPPORT_INBOX_EMAIL is absent or unusable. */
export const DEFAULT_SUPPORT_INBOX_EMAIL = 'destek@taktick.com.tr';

const logger = new Logger('SupportInbox');

/** Warned once per malformed value, so a bad setting is not a log flood. */
const warned = new Set<string>();

/**
 * Where a new ticket and a customer's reply are announced.
 *
 * Read on every call rather than cached, like every other configuration switch
 * in this codebase, so a deployment (and a test) sees the environment it
 * actually has.
 */
export function readSupportInboxEmail(): string {
  const raw = process.env.SUPPORT_INBOX_EMAIL?.trim();
  if (!raw) {
    return DEFAULT_SUPPORT_INBOX_EMAIL;
  }

  const normalized = raw.toLowerCase();
  if (!isWellFormedEmail(normalized)) {
    if (!warned.has(normalized)) {
      warned.add(normalized);
      // The value is not echoed: this variable sits next to API keys in a
      // deployment's environment, and a paste into the wrong one must not make
      // the log the place that secret is finally written down.
      logger.warn(
        'SUPPORT_INBOX_EMAIL is not a plain e-mail address; support notifications are going to ' +
          `${DEFAULT_SUPPORT_INBOX_EMAIL} instead.`,
      );
    }

    return DEFAULT_SUPPORT_INBOX_EMAIL;
  }

  return normalized;
}

/**
 * The Reply-To every support message to a customer carries.
 *
 * The same mailbox the ticket was announced to, by construction rather than by
 * convention — see the second rule above.
 */
export function supportReplyToEmail(): string {
  return readSupportInboxEmail();
}
