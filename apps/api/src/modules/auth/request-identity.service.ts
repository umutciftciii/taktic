import { Inject, Injectable } from '@nestjs/common';
import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { equivalentPhoneSpellings, normalizePhoneNumber } from '../phone-verification/phone.util';

export type RequestIdentityStatus =
  | 'new-customer'
  | 'login-required'
  | 'activation-required'
  | 'identity-conflict'
  | 'unavailable';

export type RequestIdentityResult = {
  status: RequestIdentityStatus;
  /** Server-side only. Never part of any response body. */
  matchedCustomerId: string | null;
};

type Row = {
  id: string;
  role: UserRole;
  isActive: boolean;
  passwordHash: string | null;
  customerOrigin: CustomerOrigin | null;
};

type RowKind = 'none' | 'active' | 'claimable' | 'blocked';

const rowSelect = {
  id: true,
  role: true,
  isActive: true,
  passwordHash: true,
  customerOrigin: true,
} as const;

/**
 * The same three kinds of account resolveCustomerForCreate meets, named before
 * the request exists. `claimable` mirrors CustomerActivationService's rule.
 */
function kindOf(row: Row | null): RowKind {
  if (!row) return 'none';
  if (row.role !== UserRole.CUSTOMER || !row.isActive) return 'blocked';
  if (row.passwordHash !== null) return 'active';
  if (row.customerOrigin === CustomerOrigin.AUTO_CREATED_REQUEST) return 'claimable';
  return 'blocked';
}

/**
 * Classifies a telephone number + e-mail pair against the accounts that exist.
 *
 * Both rows are read in one transaction and judged together; there is no
 * "first match wins". `User.phone` is not canonicalised on every write path —
 * `resolveCustomerForCreate` only strips non-digits, and self-registration is
 * trim-only — so the phone lookup widens to every spelling the platform is
 * known to store (see `equivalentPhoneSpellings`) rather than the one
 * `resolveCustomerForCreate` would produce for a fresh row. This is a
 * superset of what that function acts on at submit time, not an exact mirror
 * of it — the pre-check would rather over-match an existing account than tell
 * its owner they are new.
 */
@Injectable()
export class RequestIdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  normalize(input: { phone: string; email: string }) {
    return {
      // Canonical E.164 — the base spelling equivalentPhoneSpellings expands
      // to every other form a stored row might use.
      phone: normalizePhoneNumber(input.phone),
      email: input.email.trim().toLowerCase(),
    };
  }

  async classify(
    db: Prisma.TransactionClient | PrismaService,
    input: { phone: string; email: string },
  ): Promise<RequestIdentityResult> {
    const { phone, email } = this.normalize(input);

    const [byPhone, byEmail] = await Promise.all([
      db.user.findFirst({ where: { phone: { in: equivalentPhoneSpellings(phone) } }, select: rowSelect }),
      db.user.findUnique({ where: { email }, select: rowSelect }),
    ]);

    const phoneKind = kindOf(byPhone);
    const emailKind = kindOf(byEmail);

    if (phoneKind === 'none' && emailKind === 'none') {
      return { status: 'new-customer', matchedCustomerId: null };
    }

    if (phoneKind === 'blocked' || emailKind === 'blocked') {
      return { status: 'unavailable', matchedCustomerId: null };
    }

    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      return { status: 'identity-conflict', matchedCustomerId: null };
    }

    const matched = (byPhone ?? byEmail) as Row;
    const kind = byPhone ? phoneKind : emailKind;

    return {
      status: kind === 'active' ? 'login-required' : 'activation-required',
      matchedCustomerId: matched.id,
    };
  }

  /** Classifies with the service's own client, outside any transaction. */
  classifyNow(input: { phone: string; email: string }) {
    return this.classify(this.prisma, input);
  }
}
