import { contactVerification, type ContactVerification } from '@taktic/shared';

/**
 * The operator's reading of a customer's two proofs.
 *
 * Built from the two account columns the customer projections carry
 * (`emailVerifiedAt`, `phoneVerifiedAt`) and from nothing else: not from a
 * request of theirs that was verified by code, not from a consumed
 * one-time-code row, not from the account's age. An answer without the
 * fields — an older API — reads as "not proven", never as proven.
 *
 * Client-safe: no next/headers, so a Client Component may read it too.
 */

export type CustomerVerificationChannel = 'email' | 'phone';

export type CustomerVerificationBadge = ContactVerification & {
  channel: CustomerVerificationChannel;
  /** The badge's own word: "E-posta" / "Telefon". */
  subject: string;
  /** What a screen reader hears: "E-posta doğrulandı". */
  ariaLabel: string;
};

export const VERIFICATION_SUBJECTS: Record<CustomerVerificationChannel, string> = {
  email: 'E-posta',
  phone: 'Telefon',
};

export function customerVerificationBadges(customer: {
  emailVerifiedAt?: string | null;
  phoneVerifiedAt?: string | null;
}): [CustomerVerificationBadge, CustomerVerificationBadge] {
  return (['email', 'phone'] as const).map((channel) => {
    const proof = contactVerification(
      channel === 'email' ? customer.emailVerifiedAt : customer.phoneVerifiedAt,
    );
    const subject = VERIFICATION_SUBJECTS[channel];
    return {
      ...proof,
      channel,
      subject,
      ariaLabel: `${subject} ${proof.label.toLocaleLowerCase('tr-TR')}`,
    };
  }) as [CustomerVerificationBadge, CustomerVerificationBadge];
}

/** The list's compact form: only the proven channels, for a scannable cell. */
export function provenChannels(customer: {
  emailVerifiedAt?: string | null;
  phoneVerifiedAt?: string | null;
}): CustomerVerificationBadge[] {
  return customerVerificationBadges(customer).filter((badge) => badge.verified);
}

/** The pill's class: ink for proven, muted for not — never the failure red. */
export function verificationBadgeClass(badge: ContactVerification): string {
  return badge.verified ? 'badge badge-good' : 'badge badge-muted';
}
