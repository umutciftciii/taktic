import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outboxDir } from './runtime';

/**
 * Reads back what the API's test SMS transport recorded.
 *
 * This is the whole reason the outbox adapter exists. The one-time code is
 * never returned over HTTP, never written to the database in plaintext, and the
 * production console adapter refuses to print it outside development — so a
 * browser test has no way to complete the verification screen without a
 * transport it can inspect. Parsing stdout would couple the suite to a log
 * format and race the process's own buffering; a structured file does not.
 */

export type SmsOutboxEntry = {
  template: string;
  to: string;
  code: string;
  expiresInMinutes: number;
  providerMessageId: string;
  sentAt: string;
};

/**
 * The e-mail twin, for the same reason.
 *
 * A claim link carries a single-use token that is never returned over HTTP,
 * never stored in plaintext and never printed by the console adapter outside
 * development — so a browser driving the real screens has no other way to reach
 * it.
 */
export type EmailOutboxEntry = {
  template: string;
  to: string;
  actionUrl: string | null;
  sentAt: string;
};

function readLines<T>(file: string): T[] {
  let raw: string;

  try {
    raw = readFileSync(join(outboxDir, file), 'utf8');
  } catch {
    // Nothing sent yet in this run.
    return [];
  }

  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function readEntries(): SmsOutboxEntry[] {
  return readLines<SmsOutboxEntry>('sms.jsonl');
}

/**
 * Compares a number the way the two sides of this test write it.
 *
 * The suite fills the form with the national form ("05557823633"); the API
 * normalises to E.164 before sending ("+905557823633"). Rather than importing
 * the API's normaliser — which would let a bug in it hide itself by matching
 * its own output — the comparison drops the prefixes and keeps the last ten
 * digits, which is the subscriber number in either form.
 */
function subscriberDigits(value: string): string {
  return value.replace(/\D/g, '').slice(-10);
}

export function smsEntriesFor(phone: string): SmsOutboxEntry[] {
  const wanted = subscriberDigits(phone);
  return readEntries().filter((entry) => subscriberDigits(entry.to) === wanted);
}

/**
 * Waits for the code the application sent to this number and returns the newest
 * one. Polling rather than a fixed wait: the send happens inside the server
 * action the click triggered, and how long that takes is not this test's
 * business.
 */
export async function waitForLatestSmsCode(phone: string): Promise<string> {
  let entries: SmsOutboxEntry[] = [];

  await expect
    .poll(
      () => {
        entries = smsEntriesFor(phone);
        return entries.length;
      },
      {
        message: `no verification SMS was recorded for ${phone}`,
        timeout: 20_000,
        intervals: [100, 200, 500],
      },
    )
    .toBeGreaterThan(0);

  const latest = entries[entries.length - 1];
  if (!latest) {
    throw new Error(`no verification SMS was recorded for ${phone}`);
  }

  expect(latest.template).toBe('phone-verification-code');
  expect(latest.code).toMatch(/^\d{6}$/);

  return latest.code;
}

export function emailEntriesFor(email: string): EmailOutboxEntry[] {
  const wanted = email.trim().toLowerCase();
  return readLines<EmailOutboxEntry>('email.jsonl').filter(
    (entry) => entry.to.trim().toLowerCase() === wanted,
  );
}

/**
 * Waits for the newest claim link the application mailed to this address.
 *
 * Polling rather than a fixed wait: the send happens inside the server action
 * the click triggered, and how long that takes is not this test's business.
 */
export async function waitForLatestClaimUrl(email: string): Promise<string> {
  let entries: EmailOutboxEntry[] = [];

  await expect
    .poll(
      () => {
        entries = emailEntriesFor(email).filter((entry) => entry.template === 'provider-claim');
        return entries.length;
      },
      {
        message: `no claim invitation was recorded for ${email}`,
        timeout: 20_000,
        intervals: [100, 200, 500],
      },
    )
    .toBeGreaterThan(0);

  const latest = entries[entries.length - 1];
  if (!latest?.actionUrl) {
    throw new Error(`no claim invitation was recorded for ${email}`);
  }

  return latest.actionUrl;
}

/** How many claim invitations this address has received so far in the run. */
export function claimInvitationCount(email: string): number {
  return emailEntriesFor(email).filter((entry) => entry.template === 'provider-claim').length;
}

/**
 * Waits for the newest activation link the application mailed to this address.
 *
 * Same reasoning as the claim link above: the token is single-use, never
 * returned over HTTP and never stored in plaintext, so the transport recording
 * is the only way a browser test can reach the screen a real customer reaches
 * from their inbox.
 */
export async function waitForLatestActivationUrl(email: string): Promise<string> {
  let entries: EmailOutboxEntry[] = [];

  await expect
    .poll(
      () => {
        entries = emailEntriesFor(email).filter((entry) => entry.template === 'customer-activation');
        return entries.length;
      },
      {
        message: `no activation link was recorded for ${email}`,
        timeout: 20_000,
        intervals: [100, 200, 500],
      },
    )
    .toBeGreaterThan(0);

  const latest = entries[entries.length - 1];
  if (!latest?.actionUrl) {
    throw new Error(`no activation link was recorded for ${email}`);
  }

  return latest.actionUrl;
}

/**
 * Waits for the newest link of a given template mailed to this address.
 *
 * The generalised form of the two helpers above, for the templates whose link
 * is the whole point of the message: a password reset and an e-mail
 * verification. Same reasoning as the claim link — the token is single use,
 * never returned over HTTP and never stored in plaintext, so the recording
 * transport is the only way a browser test can reach the URL a real recipient
 * clicks.
 */
async function waitForLatestActionUrl(email: string, template: string): Promise<string> {
  let entries: EmailOutboxEntry[] = [];

  await expect
    .poll(
      () => {
        entries = emailEntriesFor(email).filter((entry) => entry.template === template);
        return entries.length;
      },
      {
        message: `no ${template} e-mail was recorded for ${email}`,
        timeout: 20_000,
        intervals: [100, 200, 500],
      },
    )
    .toBeGreaterThan(0);

  const latest = entries[entries.length - 1];
  if (!latest?.actionUrl) {
    throw new Error(`no ${template} link was recorded for ${email}`);
  }

  return latest.actionUrl;
}

export function waitForLatestPasswordResetUrl(email: string): Promise<string> {
  return waitForLatestActionUrl(email, 'password-reset');
}

export function waitForLatestEmailVerificationUrl(email: string): Promise<string> {
  return waitForLatestActionUrl(email, 'email-verification');
}

/** How many messages of a template this address has received so far. */
export function emailCountFor(email: string, template: string): number {
  return emailEntriesFor(email).filter((entry) => entry.template === template).length;
}
