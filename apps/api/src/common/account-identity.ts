import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  equivalentPhoneSpellings,
  normalizePhoneNumber,
} from '../modules/phone-verification/phone.util';
import { type ExistingAccount } from './account-email';

/**
 * One telephone number, one account — the phone half of the rule
 * `account-email.ts` states for the address, and the single refusal every
 * creation path gives when either half is already taken.
 *
 * `User.phone` has been unique since the first migration, but the index is
 * byte-exact and the write paths did not agree on a spelling: self-registration
 * stored the number as typed, the guest request stripped it to digits, the
 * profile screen stored E.164. `0532…`, `+90532…` and `0532 123…` therefore
 * bought three accounts for one number, and the pre-reads that were supposed
 * to catch that each asked for their own spelling. What makes the rule hold is
 * storing exactly one form — the E.164 `normalizePhoneNumber` already produces
 * for the one-time-code path — so that the existing unique index is the
 * guarantee, race included, and the lookup below is the courtesy.
 *
 * The refusal is worded once, here, and never says which of the two collided:
 * a visitor learns that these contact details belong to an account and is
 * pointed at signing in or activating, which is what the identity gate in
 * front of the request forms already tells them. Naming the field would turn
 * every creation endpoint into a lookup for numbers and addresses.
 */
export const CUSTOMER_IDENTITY_CONFLICT_CODE = 'CUSTOMER_IDENTITY_CONFLICT';

export const CUSTOMER_IDENTITY_CONFLICT_MESSAGE =
  'Bu telefon numarası veya e-posta adresi kayıtlı bir hesapla eşleşiyor. ' +
  'Giriş yapın ya da daha önce talep oluşturduysanız hesabınızı etkinleştirin.';

export function customerIdentityConflictException(): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CUSTOMER_IDENTITY_CONFLICT_CODE,
    message: CUSTOMER_IDENTITY_CONFLICT_MESSAGE,
  });
}

/**
 * The number in the one form it is stored and compared in.
 *
 * `normalizePhoneNumber` is the product's existing canonicaliser; it is reused
 * rather than restated so no creation path can store a number the rest of the
 * platform would refuse to text. Its own refusal is aimed at an API caller, so
 * it is translated into the sentence a person in front of a form can act on.
 */
export function canonicalAccountPhone(value: string): string {
  try {
    return normalizePhoneNumber(value);
  } catch {
    throw new BadRequestException('Telefon numarası geçerli görünmüyor. Örnek: 0555 123 45 67');
  }
}

const accountSelect = {
  id: true,
  role: true,
  passwordHash: true,
  customerOrigin: true,
} satisfies Prisma.UserSelect;

/**
 * The account behind a canonical number, on whatever client the caller hands
 * over so the read can share a transaction with the write it guards.
 *
 * Widened to every spelling the platform is known to have stored (see
 * `equivalentPhoneSpellings`): every row written through a canonicalising
 * path is E.164, but rows predate that, and a lookup that only asked for
 * `+90555…` would hand a second account the `0555…` already on file.
 */
export function findAccountByPhone(
  client: Pick<Prisma.TransactionClient, 'user'>,
  canonicalPhone: string,
): Promise<ExistingAccount | null> {
  return client.user.findFirst({
    where: { phone: { in: equivalentPhoneSpellings(canonicalPhone) } },
    select: accountSelect,
  });
}

/** Which unique index a P2002 names, when it is one of the two this rule owns. */
export function uniqueViolationField(error: unknown): 'phone' | 'email' | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }

  const target = Array.isArray(error.meta?.target)
    ? error.meta.target.join(',')
    : String(error.meta?.target ?? '');

  if (target.includes('phone')) {
    return 'phone';
  }

  if (target.includes('email')) {
    return 'email';
  }

  return null;
}
