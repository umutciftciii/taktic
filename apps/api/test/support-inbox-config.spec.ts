import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPPORT_INBOX_EMAIL,
  readSupportInboxEmail,
  supportReplyToEmail,
} from '../src/modules/support-tickets/support-inbox.config';

/**
 * Where a support notification goes, and what a customer's reply comes back to.
 *
 * One setting decides both, and the rule this file pins down is that **nothing
 * here can stop the process.** An unset variable is the ordinary case — most
 * deployments never touch it — and a support address is not the kind of fact
 * that should be able to take a marketplace offline at boot. So every path
 * below ends in an address: the configured one when it is usable, the shipped
 * default when it is not.
 *
 * The default is deliberately a real, deliverable address rather than a
 * placeholder in a reserved domain. A ticket nobody reads is worse than a
 * footer nobody checks: the customer has already been told somebody is
 * listening.
 */

const ORIGINAL = process.env.SUPPORT_INBOX_EMAIL;

beforeEach(() => {
  delete process.env.SUPPORT_INBOX_EMAIL;
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.SUPPORT_INBOX_EMAIL;
  } else {
    process.env.SUPPORT_INBOX_EMAIL = ORIGINAL;
  }
});

describe('the support inbox address', () => {
  it('falls back to the shipped default when nothing is configured', () => {
    expect(readSupportInboxEmail()).toBe('destek@taktick.com.tr');
    expect(DEFAULT_SUPPORT_INBOX_EMAIL).toBe('destek@taktick.com.tr');
  });

  it('reads the configured address, trimmed and lowercased', () => {
    process.env.SUPPORT_INBOX_EMAIL = '  Destek@Taktick.Com.TR  ';

    expect(readSupportInboxEmail()).toBe('destek@taktick.com.tr');
  });

  it('takes an address in a different domain entirely', () => {
    process.env.SUPPORT_INBOX_EMAIL = 'help@partner.example.org';

    expect(readSupportInboxEmail()).toBe('help@partner.example.org');
  });

  it('falls back rather than throwing when the value is not an address', () => {
    // A boot that dies over a footer takes authentication, the admin panel and
    // every request flow with it. The value is unusable, so the default stands.
    for (const nonsense of ['destek sayfası', 'destek@', '@taktick.com.tr', 'destek@taktick']) {
      process.env.SUPPORT_INBOX_EMAIL = nonsense;

      expect(readSupportInboxEmail()).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    }
  });

  it('falls back on a blank value, which is how an unset variable reaches a container', () => {
    process.env.SUPPORT_INBOX_EMAIL = '   ';

    expect(readSupportInboxEmail()).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
  });

  it('answers a customer reply to the same mailbox the ticket was announced to', () => {
    // One configuration point, both directions. A deployment that moves its
    // inbox and keeps a Reply-To pointing at the old one has moved nothing.
    process.env.SUPPORT_INBOX_EMAIL = 'help@partner.example.org';

    expect(supportReplyToEmail()).toBe(readSupportInboxEmail());
  });
});
