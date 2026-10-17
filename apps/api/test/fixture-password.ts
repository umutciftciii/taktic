import { randomBytes } from 'node:crypto';

/**
 * Passwords for accounts the tests create, never a value written in the source.
 *
 * A literal fixture password (the old shared one and its friends) is exactly
 * the kind of string that ends up as somebody's real password on a shared
 * database, and a repository that ships one teaches the habit. Each test process draws its
 * own instead: every account a test seeds and every sign-in it then attempts
 * read the same constant, so the value never needs to be known in advance.
 *
 * `TEST_FIXTURE_PASSWORD` may pin it, for a person reproducing a failure by
 * hand against the scratch database. It is never logged.
 */
export function generateFixturePassword(): string {
  return `Tt1-${randomBytes(18).toString('base64url')}`;
}

export const TEST_ACCOUNT_PASSWORD = process.env.TEST_FIXTURE_PASSWORD?.trim() || generateFixturePassword();
