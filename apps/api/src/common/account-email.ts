import { ConflictException, HttpStatus } from '@nestjs/common';
import { CustomerOrigin, Prisma, UserRole } from '@prisma/client';

/**
 * One address, one kind of account — and the single place that says so.
 *
 * Three flows can create the second account under an address somebody already
 * uses: customer registration, provider registration, and the guest provider
 * application that a claim link later turns into a provider account. Each used
 * to answer differently — one leaked a raw Prisma unique violation as "Email
 * already registered", one said nothing at all and filed the application anyway
 * — so a visitor's experience of the same rule depended on which door they
 * walked through. Everything about the rule now lives here.
 *
 * What actually *enforces* it is the database, not this file. `User.email` is
 * unique and a `User` carries exactly one role, so two accounts of different
 * kinds cannot share an address; the migration alongside this module adds the
 * CHECK that makes the stored form the normalised one, which is what turns that
 * byte-exact index into the case- and whitespace-insensitive guarantee the rule
 * is written in. The functions here are the explanation, and the loser of a
 * race gets the same explanation from {@link crossRoleEmailConflictException}
 * by way of the constraint violation rather than by way of the pre-read.
 */

/** Machine-readable code every cross-role refusal carries. */
export const CROSS_ROLE_EMAIL_CONFLICT_CODE = 'EMAIL_ROLE_CONFLICT';

/**
 * The two kinds of account the rule keeps apart.
 *
 * SUPER_ADMIN is deliberately absent: an operator account is not one of the two
 * sides of the marketplace, and the ordinary duplicate answer already covers it.
 */
export type MarketplaceAccountKind = typeof UserRole.CUSTOMER | typeof UserRole.PROVIDER;

/**
 * The one normalisation an address goes through before it is stored, compared
 * or looked up.
 *
 * Trim then fold: the two variations a person actually produces are a stray
 * space from a copy-paste and a capital first letter from a phone keyboard, and
 * neither may buy a second account.
 */
export function normalizeAccountEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * Refusal for every cross-role collision, worded once.
 *
 * It says that the address is taken by a different kind of account and stops
 * there. It never echoes the address, never names the account holder and never
 * says which kind holds it — somebody probing the registration form learns only
 * that this address is not available to them, which is what they would learn
 * from any refusal anyway.
 */
export function crossRoleEmailConflictException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CROSS_ROLE_EMAIL_CONFLICT_CODE,
    message: 'Bu e-posta başka türde bir hesap için kullanılıyor.',
  });
}

/**
 * The account an address belongs to, in the only terms the rule cares about.
 *
 * `AUTO_CREATED_REQUEST` customers with no password are singled out because
 * they are not accounts anybody opened: the platform created them so a guest
 * service request would have somewhere to hang, and nobody has ever proved
 * control of the mailbox. They keep their own dedicated handling — the
 * activation link — instead of being reported as a conflicting account.
 */
export type ExistingAccount = {
  id: string;
  role: UserRole;
  passwordHash: string | null;
  customerOrigin: CustomerOrigin | null;
};

export function isAutoCreatedCustomer(account: ExistingAccount): boolean {
  return (
    account.role === UserRole.CUSTOMER &&
    account.passwordHash === null &&
    account.customerOrigin === CustomerOrigin.AUTO_CREATED_REQUEST
  );
}

/**
 * Whether `account` blocks opening an account of `wanted` kind under the same
 * address.
 *
 * Only the *cross*-role case is a conflict for this rule's purposes. Two
 * accounts of the same kind are an ordinary duplicate, and the callers keep
 * their own long-standing answers for that.
 */
export function conflictsWithAccountKind(
  account: ExistingAccount,
  wanted: MarketplaceAccountKind,
): boolean {
  if (account.role !== UserRole.CUSTOMER && account.role !== UserRole.PROVIDER) {
    return false;
  }

  if (account.role === wanted) {
    return false;
  }

  return !isAutoCreatedCustomer(account);
}

const accountSelect = {
  id: true,
  role: true,
  passwordHash: true,
  customerOrigin: true,
} satisfies Prisma.UserSelect;

/**
 * Reads the account behind a normalised address, on whatever client the caller
 * hands over so a check can share a transaction with the write it guards.
 */
export function findAccountByEmail(
  client: Pick<Prisma.TransactionClient, 'user'>,
  normalizedEmail: string,
): Promise<ExistingAccount | null> {
  return client.user.findUnique({
    where: { email: normalizedEmail },
    select: accountSelect,
  });
}

/**
 * Refuses before the write when the address already belongs to the other kind
 * of account.
 *
 * A pre-read cannot be the guarantee — two requests can both pass it — so this
 * is the friendly half of the answer only. The guarantee is the unique index,
 * and callers translate its violation through
 * {@link crossRoleEmailConflictException} so the loser of a race reads the same
 * sentence as the caller who was simply late.
 */
export async function assertEmailFreeForAccountKind(
  client: Pick<Prisma.TransactionClient, 'user'>,
  normalizedEmail: string,
  wanted: MarketplaceAccountKind,
): Promise<void> {
  const existing = await findAccountByEmail(client, normalizedEmail);

  if (existing && conflictsWithAccountKind(existing, wanted)) {
    throw crossRoleEmailConflictException();
  }
}
