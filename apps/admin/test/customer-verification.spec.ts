import { describe, expect, it } from 'vitest';
import {
  customerVerificationBadges,
  provenChannels,
  verificationBadgeClass,
} from '../lib/customer-verification';

/**
 * What the customer list and detail print about a customer's proofs.
 *
 * The two account columns are the whole input. A row carrying anything
 * else that sounds like a proof — a verified request, a one-time-code row —
 * is not a row this module can even see, so a badge can only ever come from
 * `emailVerifiedAt` / `phoneVerifiedAt` themselves.
 */

const EMAIL_AT = '2026-09-10T08:00:00.000Z';
const PHONE_AT = '2026-09-12T09:30:00.000Z';

describe('customerVerificationBadges', () => {
  it('reads both columns into two badges with their moments', () => {
    expect(customerVerificationBadges({ emailVerifiedAt: EMAIL_AT, phoneVerifiedAt: PHONE_AT })).toEqual([
      { channel: 'email', subject: 'E-posta', verified: true, label: 'Doğrulandı', at: EMAIL_AT, ariaLabel: 'E-posta doğrulandı' },
      { channel: 'phone', subject: 'Telefon', verified: true, label: 'Doğrulandı', at: PHONE_AT, ariaLabel: 'Telefon doğrulandı' },
    ]);
  });

  it('words an unproven channel neutrally and keeps no moment', () => {
    const [email, phone] = customerVerificationBadges({ emailVerifiedAt: null, phoneVerifiedAt: PHONE_AT });
    expect(email).toMatchObject({ verified: false, label: 'Doğrulanmadı', at: null, ariaLabel: 'E-posta doğrulanmadı' });
    expect(phone).toMatchObject({ verified: true, at: PHONE_AT });
  });

  it('reads a legacy row — no columns at all — as nothing proven', () => {
    for (const badge of customerVerificationBadges({})) {
      expect(badge.verified, badge.channel).toBe(false);
      expect(badge.at, badge.channel).toBeNull();
    }
  });

  it('ignores anything that is not one of the two columns', () => {
    const row = {
      phoneVerifiedAt: null,
      // Not an input: the module has no parameter for it, and it must not
      // be mistaken for one by a spread.
      requestPhoneVerifiedAt: PHONE_AT,
      lastPhoneVerificationConsumedAt: PHONE_AT,
    } as { phoneVerifiedAt: string | null };
    expect(customerVerificationBadges(row).find((badge) => badge.channel === 'phone')?.verified).toBe(false);
  });
});

describe('provenChannels', () => {
  it('lists only the proven ones, e-mail first', () => {
    expect(provenChannels({ emailVerifiedAt: EMAIL_AT, phoneVerifiedAt: PHONE_AT }).map((b) => b.subject)).toEqual([
      'E-posta',
      'Telefon',
    ]);
    expect(provenChannels({ phoneVerifiedAt: PHONE_AT }).map((b) => b.subject)).toEqual(['Telefon']);
    expect(provenChannels({})).toEqual([]);
  });
});

describe('verificationBadgeClass', () => {
  it('is ink for proven and muted — never the failure red — for not', () => {
    expect(verificationBadgeClass({ verified: true, label: 'Doğrulandı', at: EMAIL_AT })).toBe('badge badge-good');
    expect(verificationBadgeClass({ verified: false, label: 'Doğrulanmadı', at: null })).toBe('badge badge-muted');
    expect(verificationBadgeClass({ verified: false, label: 'Doğrulanmadı', at: null })).not.toMatch(/badge-(bad|error|warn)/);
  });
});
