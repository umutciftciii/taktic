import { Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { isTestBehaviourPermitted, readAppEnvironment } from '../../common/app-environment';
import { OTP_CODE_LENGTH } from './phone-verification.constants';
import { normalizePhoneNumber } from './phone.util';

/**
 * A second code the verification screen accepts — for a short list of test
 * numbers, on a local or staging stack, for a stated period, and nowhere else.
 *
 * ## What it is for
 *
 * The vitrin lead flow proves a telephone number before it will address a
 * business, and no SMS provider is wired. A browser test on a laptop reads the
 * code from the recording transport; a person on the staging stack has no
 * transport to read. This lets that person finish the flow with a number the
 * team owns and a code the team set — and it changes nothing else about the
 * flow: the same screen, the same send, the same TTL, the same attempt budget,
 * the same lock, the same rate limits. The test code is simply a second answer
 * the row will accept, and only while every condition below holds.
 *
 * ## The contract, every clause of which fails closed
 *
 * 1. `PHONE_VERIFICATION_TEST_BYPASS_ENABLED` is exactly `true`.
 * 2. The process declares itself `local` or `staging` in `APP_ENVIRONMENT`,
 *    and is not running under `NODE_ENV=production`. Nothing about the
 *    request — no header, no address, no parameter — takes part in this.
 * 3. The number is on `PHONE_VERIFICATION_TEST_BYPASS_PHONES`, an explicit
 *    E.164 allow-list. Every other number goes through the ordinary flow and
 *    cannot be verified with the test code.
 * 4. The code equals `PHONE_VERIFICATION_TEST_BYPASS_CODE`, compared in
 *    constant time. There is no default and nothing is written into source.
 * 5. `PHONE_VERIFICATION_TEST_BYPASS_EXPIRES_AT` is a valid instant in the
 *    future. Missing, malformed or past, the whole thing is off — which is
 *    what makes a staging bypass a period rather than a state.
 *
 * ## What never leaves this file
 *
 * The code and the allow-list are read here and compared here. No method
 * returns them, no log line prints them, no audit row stores them and no
 * error message names them. The one thing recorded is a boolean on the
 * verification row: that this proof was a test proof.
 */

export const PHONE_VERIFICATION_TEST_BYPASS_VARS = {
  enabled: 'PHONE_VERIFICATION_TEST_BYPASS_ENABLED',
  phones: 'PHONE_VERIFICATION_TEST_BYPASS_PHONES',
  code: 'PHONE_VERIFICATION_TEST_BYPASS_CODE',
  expiresAt: 'PHONE_VERIFICATION_TEST_BYPASS_EXPIRES_AT',
} as const;

const VARS = PHONE_VERIFICATION_TEST_BYPASS_VARS;

/** Why the bypass is not in force. Names only — nothing about the values. */
export type PhoneVerificationTestBypassBlock =
  | 'DISABLED'
  | 'ENVIRONMENT_NOT_PERMITTED'
  | 'EXPIRY_MISSING'
  | 'EXPIRY_INVALID'
  | 'EXPIRED'
  | 'CODE_INVALID'
  | 'PHONES_MISSING';

type Resolved =
  | { active: true; code: string; phones: ReadonlySet<string> }
  | { active: false; block: PhoneVerificationTestBypassBlock };

/**
 * Whether the flag is on at all — the one clause that is a pure switch.
 *
 * Exactly `true`; `1`, `yes` and `TRUE` are not accepted, so a value that
 * was meant to be off cannot be read as on by a lenient parser.
 */
export function isPhoneVerificationTestBypassFlagged(): boolean {
  return process.env[VARS.enabled]?.trim() === 'true';
}

/**
 * Evaluates the whole contract, at the moment it is asked.
 *
 * Read per call rather than cached, because clause 5 is a clock: a bypass
 * that was valid at boot has to stop being valid at its end without a
 * restart. The cost is a handful of string reads per verification attempt.
 */
function resolve(now: Date): Resolved {
  if (!isPhoneVerificationTestBypassFlagged()) {
    return { active: false, block: 'DISABLED' };
  }

  if (!isTestBehaviourPermitted()) {
    return { active: false, block: 'ENVIRONMENT_NOT_PERMITTED' };
  }

  const rawExpiry = process.env[VARS.expiresAt]?.trim();
  if (!rawExpiry) {
    return { active: false, block: 'EXPIRY_MISSING' };
  }

  const expiresAt = new Date(rawExpiry);
  if (Number.isNaN(expiresAt.getTime())) {
    return { active: false, block: 'EXPIRY_INVALID' };
  }

  if (expiresAt.getTime() <= now.getTime()) {
    return { active: false, block: 'EXPIRED' };
  }

  const code = process.env[VARS.code]?.trim() ?? '';
  if (!new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`).test(code)) {
    return { active: false, block: 'CODE_INVALID' };
  }

  const phones = readAllowlist();
  if (phones.size === 0) {
    return { active: false, block: 'PHONES_MISSING' };
  }

  return { active: true, code, phones };
}

/**
 * The allow-list, normalised the way every stored number is, so `+90 555…`
 * and `0555…` in the variable name the same subscriber the flow will see.
 * An entry that cannot be normalised is dropped rather than matched loosely.
 */
function readAllowlist(): ReadonlySet<string> {
  const raw = process.env[VARS.phones]?.trim();
  if (!raw) {
    return new Set();
  }

  const phones = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    try {
      phones.add(normalizePhoneNumber(trimmed));
    } catch {
      // Not a number this product can address; it cannot be on the list.
    }
  }

  return phones;
}

/**
 * Whether this code is the test code for this number, right now.
 *
 * The only question the verification service asks. It answers false for
 * every reason the bypass could be off, for every number not on the list and
 * for every code that is not the one — and it does not say which. The
 * comparison is constant-time so the answer's timing says nothing either.
 */
export function isPhoneVerificationTestBypassMatch(
  normalizedPhone: string,
  code: string,
  now: Date = new Date(),
): boolean {
  const resolved = resolve(now);
  if (!resolved.active) {
    return false;
  }

  if (!resolved.phones.has(normalizedPhone)) {
    return false;
  }

  const expected = Buffer.from(resolved.code, 'utf8');
  const given = Buffer.from(code, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Called once at boot.
 *
 * A flag that is on where it can never act is a misconfiguration worth
 * stopping for: in production it is somebody having copied a staging
 * environment file, and the process refuses to start rather than run with a
 * setting that says "test mode" on a real deployment. The message names the
 * variables and never their values.
 *
 * A flag that is on where it may act, but with a broken clause — no expiry,
 * an unparseable one, a code of the wrong shape, an empty list — is also a
 * boot failure: the person who set it up is at the keyboard and should learn
 * now, not from a verification screen that silently fell back to SMS.
 *
 * An expiry in the *past* is the one clause that is not an error. It is the
 * intended way a staging bypass ends: the period lapsed and nothing needs to
 * be edited for the stack to be safe. It is logged as a warning so it is not
 * a mystery either.
 */
export function assertPhoneVerificationTestBypassConfig(now: Date = new Date()): void {
  if (!isPhoneVerificationTestBypassFlagged()) {
    return;
  }

  const environment = readAppEnvironment();

  if (!isTestBehaviourPermitted()) {
    throw new Error(
      `${VARS.enabled}=true is refused here: the phone-verification test bypass runs only when ` +
        `APP_ENVIRONMENT is "local" or "staging" and NODE_ENV is not "production" ` +
        `(APP_ENVIRONMENT is ${environment ? `"${environment}"` : 'not set'}, ` +
        `NODE_ENV is "${process.env.NODE_ENV ?? ''}"). Remove the flag from this deployment.`,
    );
  }

  const resolved = resolve(now);
  if (resolved.active) {
    return;
  }

  switch (resolved.block) {
    case 'EXPIRED':
      new Logger('PhoneVerificationTestBypass').warn(
        `${VARS.enabled}=true but ${VARS.expiresAt} is in the past: the test bypass is off. ` +
          'Set a new expiry to open a new test period, or remove the flag.',
      );
      return;
    case 'EXPIRY_MISSING':
      throw new Error(
        `${VARS.enabled}=true requires ${VARS.expiresAt}: a test bypass without an end is not accepted.`,
      );
    case 'EXPIRY_INVALID':
      throw new Error(`${VARS.expiresAt} is not a valid ISO-8601 instant.`);
    case 'CODE_INVALID':
      throw new Error(
        `${VARS.enabled}=true requires ${VARS.code} to be exactly ${OTP_CODE_LENGTH} digits.`,
      );
    case 'PHONES_MISSING':
      throw new Error(
        `${VARS.enabled}=true requires ${VARS.phones}: a comma-separated E.164 allow-list of test numbers.`,
      );
    default:
      // DISABLED and ENVIRONMENT_NOT_PERMITTED are answered above.
      return;
  }
}
