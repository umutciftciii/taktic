import { Inject, Injectable } from '@nestjs/common';
import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhoneNumber } from '../phone-verification/phone.util';

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
 * "first match wins". The result set is exactly the one
 * resolveCustomerForCreate acts on at submit time — this only moves the answer
 * to the moment the two fields are typed.
 */
@Injectable()
export class RequestIdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  normalize(input: { phone: string; email: string }) {
    return {
      // The same spelling the request service stores and matches on.
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
      db.user.findFirst({ where: { phone: { in: [phone, denormalizedPhone(phone)] } }, select: rowSelect }),
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

/**
 * User.phone is stored the way ServiceRequestsService.normalizePhone leaves it
 * (digits, national trunk zero kept: "05551234567") while
 * normalizePhoneNumber yields E.164 ("+905551234567"). Both spellings are
 * looked up so the pre-check sees the same account the request service will.
 */
function denormalizedPhone(e164: string): string {
  return e164.startsWith('+90') ? `0${e164.slice(3)}` : e164;
}
