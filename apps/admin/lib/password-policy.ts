import policy from '@taktic/shared/staff-password-policy.json';

/**
 * The staff password rule (ADMIN-AUTH-002), as the panel reads it.
 *
 * Every password this panel sets belongs to an ADMIN or SUPER_ADMIN account —
 * an accepted invite or a completed reset link — and the API judges each one by
 * the staff rule (apps/api/src/common/staff-password-policy.ts). Both sides read
 * `packages/shared/staff-password-policy.json`: the numbers, the word list and
 * the refusal sentences, so a criterion ticked here is one the server enforces
 * and an error shown here is worded as the server words it.
 *
 * The check here is advisory and runs before the request is sent; the API
 * decides on submit.
 *
 * A plain module rather than part of the client component that renders the
 * criteria: a Server Component importing a value out of a `'use client'` module
 * receives a client reference, not the number, and interpolating that into a
 * message prints the reference.
 */
export const PASSWORD_MIN_LENGTH: number = policy.minLength;
export const PASSWORD_MAX_LENGTH: number = policy.maxLength;
export const PASSWORD_MIN_DISTINCT_CHARACTERS: number = policy.minDistinctCharacters;
export const PASSWORD_GUESSABLE_FRAGMENTS: readonly string[] = policy.guessableFragments;

export type PasswordRule = 'minLength' | 'maxLength' | 'distinctCharacters' | 'guessable';

/** The API's `code` when it refuses a staff password by this rule. */
export const STAFF_PASSWORD_POLICY_CODE = 'STAFF_PASSWORD_POLICY';

export const PASSWORD_RULE_MESSAGES: Readonly<Record<PasswordRule, string>> = policy.messages;

export function isPasswordRule(value: unknown): value is PasswordRule {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PASSWORD_RULE_MESSAGES, value);
}

/** Same fold as the API: the default and the Turkish lower case, either matching. */
export function containsGuessableFragment(value: string): boolean {
  const folds = [value.toLowerCase(), value.toLocaleLowerCase('tr-TR')];
  return PASSWORD_GUESSABLE_FRAGMENTS.some((fragment) => folds.some((fold) => fold.includes(fragment)));
}

/** Every rule `value` breaks, in the order the API reports them. */
export function passwordViolations(value: string): PasswordRule[] {
  const violations: PasswordRule[] = [];
  if (value.length < PASSWORD_MIN_LENGTH) violations.push('minLength');
  if (value.length > PASSWORD_MAX_LENGTH) violations.push('maxLength');
  if (new Set(value).size < PASSWORD_MIN_DISTINCT_CHARACTERS) violations.push('distinctCharacters');
  if (containsGuessableFragment(value)) violations.push('guessable');
  return violations;
}

export type PasswordCriterion = {
  key: 'length' | 'distinct' | 'guessable' | 'match';
  label: string;
  met: boolean;
};

/** The criteria the form lists, ticked against what is in the two boxes. */
export function passwordCriteria(password: string, confirm: string): PasswordCriterion[] {
  const violations = new Set(passwordViolations(password));
  const typed = password.length > 0;
  return [
    {
      key: 'length',
      label: `En az ${PASSWORD_MIN_LENGTH}, en fazla ${PASSWORD_MAX_LENGTH} karakter`,
      met: !violations.has('minLength') && !violations.has('maxLength'),
    },
    {
      key: 'distinct',
      label: `En az ${PASSWORD_MIN_DISTINCT_CHARACTERS} farklı karakter`,
      met: !violations.has('distinctCharacters'),
    },
    {
      key: 'guessable',
      label: '"admin", "password", "123456" gibi tahmin edilebilir kelime yok',
      met: typed && !violations.has('guessable'),
    },
    {
      key: 'match',
      label: 'Şifreler eşleşiyor',
      met: typed && password === confirm,
    },
  ];
}

/** The sentence for the `?error=policy&rule=…` a form redirect carries. */
export function passwordRuleMessage(rule: string | undefined): string {
  return isPasswordRule(rule) ? PASSWORD_RULE_MESSAGES[rule] : PASSWORD_RULE_MESSAGES.minLength;
}

/**
 * The first rule the API named in a refusal, or null when the refusal was not
 * the staff rule's (a dead link, a server error).
 */
export async function readStaffPasswordRefusal(response: Response): Promise<PasswordRule | null> {
  if (response.status !== 400) return null;
  try {
    const body = (await response.clone().json()) as { code?: unknown; rules?: unknown };
    if (body?.code !== STAFF_PASSWORD_POLICY_CODE || !Array.isArray(body.rules)) return null;
    const first: unknown = body.rules[0];
    return isPasswordRule(first) ? first : null;
  } catch {
    return null;
  }
}
