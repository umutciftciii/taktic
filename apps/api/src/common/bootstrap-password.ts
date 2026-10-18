import {
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_PASSWORD_MIN_DISTINCT_CHARACTERS,
  STAFF_PASSWORD_MIN_LENGTH,
  containsGuessableFragment,
} from './staff-password-policy';

/**
 * The rule for a password an operator hands to a bootstrap or recovery tool
 * (STG-003): the seed's first super admin (`SEED_SUPER_ADMIN_PASSWORD`, from
 * the environment) and the super-admin transition's rename and recovery
 * (typed at a hidden terminal prompt, `scripts/terminal-secret.ts`).
 *
 * The staff rule (staff-password-policy.ts, ADMIN-AUTH-002) and then some. A
 * staff member choosing their own password at a form gets length, variety and
 * the guessable-word list; a value that opens the account with every
 * capability there is, typed into a shell, must also look like the output of a
 * generator — `openssl rand -base64 24` passes — so it adds the
 * character-class and whitespace checks. The shared parts read the same
 * numbers and the same word list, so the two cannot drift apart.
 *
 * There is no fallback anywhere. An unset variable is a refusal, never a
 * default, and no message here ever repeats the value it judged.
 */

export const BOOTSTRAP_PASSWORD_MIN_LENGTH = STAFF_PASSWORD_MIN_LENGTH;
export const BOOTSTRAP_PASSWORD_MAX_LENGTH = STAFF_PASSWORD_MAX_LENGTH;
const MIN_CHARACTER_CLASSES = 3;
const MIN_DISTINCT_CHARACTERS = STAFF_PASSWORD_MIN_DISTINCT_CHARACTERS;

export class BootstrapPasswordRefused extends Error {}

/** Why `value` would be refused, or null when it is acceptable. Never echoes it. */
export function bootstrapPasswordProblem(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'is not set';
  }
  if (value !== value.trim()) {
    return 'has leading or trailing whitespace';
  }
  if (value.length < BOOTSTRAP_PASSWORD_MIN_LENGTH) {
    return `is shorter than ${BOOTSTRAP_PASSWORD_MIN_LENGTH} characters`;
  }
  if (value.length > BOOTSTRAP_PASSWORD_MAX_LENGTH) {
    return `is longer than ${BOOTSTRAP_PASSWORD_MAX_LENGTH} characters`;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  if (classes < MIN_CHARACTER_CLASSES) {
    return `uses fewer than ${MIN_CHARACTER_CLASSES} of: lower case, upper case, digits, symbols`;
  }
  if (new Set(value).size < MIN_DISTINCT_CHARACTERS) {
    return `has fewer than ${MIN_DISTINCT_CHARACTERS} distinct characters`;
  }
  if (containsGuessableFragment(value)) {
    return 'contains a guessable word or sequence';
  }
  return null;
}

/**
 * Reads `name` from `env` and returns it, or throws naming the variable and
 * the reason — never the value.
 */
export function requireBootstrapPassword(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  const problem = bootstrapPasswordProblem(value);
  if (problem) {
    throw new BootstrapPasswordRefused(
      `${name} ${problem}. Generate one with: openssl rand -base64 24 — and keep it in a password manager.`,
    );
  }
  return value as string;
}
