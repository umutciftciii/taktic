import { describe, expect, it } from 'vitest';
import { contactVerification, VERIFIED_LABEL, UNVERIFIED_LABEL } from './contact-verification';

/**
 * One reading of "is this channel verified?" for every screen that shows a
 * badge — the operator's customer list and detail, the customer's own
 * settings. The input is the canonical column (`User.emailVerifiedAt` /
 * `User.phoneVerifiedAt`) and nothing else: a timestamp is proof, anything
 * else is not, and "not" is worded neutrally rather than as a failure.
 */
describe('contactVerification', () => {
  it('reads a timestamp as verified, with the moment kept', () => {
    expect(contactVerification('2026-09-12T09:30:00.000Z')).toEqual({
      verified: true,
      label: VERIFIED_LABEL,
      at: '2026-09-12T09:30:00.000Z',
    });
    expect(contactVerification(new Date('2026-09-12T09:30:00.000Z'))).toEqual({
      verified: true,
      label: VERIFIED_LABEL,
      at: '2026-09-12T09:30:00.000Z',
    });
  });

  it('reads null, undefined and rubbish as not verified — never as verified', () => {
    for (const input of [null, undefined, '', 'not-a-date', 0]) {
      expect(contactVerification(input as never), String(input)).toEqual({
        verified: false,
        label: UNVERIFIED_LABEL,
        at: null,
      });
    }
  });

  it('words the two states without a colour', () => {
    expect(VERIFIED_LABEL).toBe('Doğrulandı');
    expect(UNVERIFIED_LABEL).toBe('Doğrulanmadı');
  });
});
