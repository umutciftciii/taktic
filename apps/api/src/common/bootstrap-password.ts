/**
 * The rule for a password an operator hands to a bootstrap or recovery tool
 * through the environment (STG-003): the seed's first super admin
 * (`SEED_SUPER_ADMIN_PASSWORD`) and the super-admin recovery
 * (`SUPER_ADMIN_RECOVERY_PASSWORD`).
 *
 * Stricter than the product's sign-up policy on purpose. A person choosing
 * their own password at a form gets the length range and nothing else; a value
 * that opens the account with every capability there is, typed into a shell,
 * must be the output of a generator — `openssl rand -base64 24` passes — and
 * is refused when it looks like something a person made up.
 *
 * There is no fallback anywhere. An unset variable is a refusal, never a
 * default, and no message here ever repeats the value it judged.
 */

export const BOOTSTRAP_PASSWORD_MIN_LENGTH = 20;
/** The product's own ceiling (ConfirmPasswordResetDto, ChangePasswordDto). */
export const BOOTSTRAP_PASSWORD_MAX_LENGTH = 128;
const MIN_CHARACTER_CLASSES = 3;
const MIN_DISTINCT_CHARACTERS = 10;

/**
 * Words a generated value does not contain, and a made-up one usually does.
 * Matched case-insensitively anywhere in the value.
 */
const GUESSABLE_FRAGMENTS = ['password', 'passw0rd', 'changeme', 'admin', 'taktic', 'taktick', 'qwerty', '123456', 'letmein', 'welcome'];

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
  const folded = value.toLowerCase();
  if (GUESSABLE_FRAGMENTS.some((fragment) => folded.includes(fragment))) {
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
