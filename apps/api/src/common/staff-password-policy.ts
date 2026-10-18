import { BadRequestException, HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import policy from '@taktic/shared/staff-password-policy.json';

/**
 * ADMIN-AUTH-002: the rule for a password a staff account (ADMIN, SUPER_ADMIN)
 * is given — by accepting an invite, completing a reset link, or changing it
 * while signed in.
 *
 * The numbers, the word list and the refusal sentences live in `packages/shared/staff-password-policy.json`,
 * the file the admin panel's criteria read, so the screen cannot tick a rule
 * this server has stopped enforcing (or miss one it added). JSON import only —
 * see service-request-limits.ts for why the package's TS entry point cannot be
 * required from the compiled API.
 *
 * Length, variety and a short list of words a made-up password tends to carry.
 * No character-class rule: a person choosing a long passphrase at a form is
 * better served by length than by being made to add a digit and a symbol. The
 * bootstrap rule (bootstrap-password.ts) is this rule plus the composition and
 * whitespace checks a generator's output always passes.
 *
 * Applied to new passwords only. A staff password set before this rule existed
 * still signs in; it meets the rule the next time it is replaced.
 *
 * CUSTOMER and PROVIDER keep the product's own policy (8–128, nothing else).
 */
export const STAFF_PASSWORD_MIN_LENGTH: number = policy.minLength;
export const STAFF_PASSWORD_MAX_LENGTH: number = policy.maxLength;
export const STAFF_PASSWORD_MIN_DISTINCT_CHARACTERS: number = policy.minDistinctCharacters;
export const STAFF_PASSWORD_GUESSABLE_FRAGMENTS: readonly string[] = policy.guessableFragments;

export const STAFF_PASSWORD_POLICY_CODE = 'STAFF_PASSWORD_POLICY';

export type StaffPasswordRule = 'minLength' | 'maxLength' | 'distinctCharacters' | 'guessable';

const STAFF_ROLES: readonly UserRole[] = [UserRole.SUPER_ADMIN, UserRole.ADMIN];

export function isStaffPasswordRole(role: UserRole): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * Whether `value` contains one of the guessable fragments, ignoring case.
 *
 * Folded twice: the default lower-casing turns "ADMIN" into "admin", and the
 * Turkish one turns "ŞİFRE" into "şifre" (the default would leave a dotted
 * "i̇" that matches nothing).
 */
export function containsGuessableFragment(value: string): boolean {
  const folds = [value.toLowerCase(), value.toLocaleLowerCase('tr-TR')];
  return STAFF_PASSWORD_GUESSABLE_FRAGMENTS.some((fragment) => folds.some((fold) => fold.includes(fragment)));
}

/** Every rule `value` breaks, in the order the panel lists them. Never echoes it. */
export function staffPasswordViolations(value: string): StaffPasswordRule[] {
  const violations: StaffPasswordRule[] = [];
  if (value.length < STAFF_PASSWORD_MIN_LENGTH) violations.push('minLength');
  if (value.length > STAFF_PASSWORD_MAX_LENGTH) violations.push('maxLength');
  if (new Set(value).size < STAFF_PASSWORD_MIN_DISTINCT_CHARACTERS) violations.push('distinctCharacters');
  if (containsGuessableFragment(value)) violations.push('guessable');
  return violations;
}

/**
 * The sentence for each rule, from the same file the panel renders its errors
 * from — the screen and the API say the same thing in the same words.
 */
export const STAFF_PASSWORD_RULE_MESSAGES: Readonly<Record<StaffPasswordRule, string>> = policy.messages;

/**
 * Throws a 400 naming the first broken rule when `value` is refused.
 *
 * `rules` carries every broken rule's key so a client can mark each criterion;
 * `message` is the first one's sentence, for a client that shows only text.
 */
export function assertStaffPasswordPolicy(value: string): void {
  const violations = staffPasswordViolations(value);
  const first = violations[0];
  if (first === undefined) return;
  throw new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: STAFF_PASSWORD_POLICY_CODE,
    message: STAFF_PASSWORD_RULE_MESSAGES[first],
    rules: violations,
  });
}
