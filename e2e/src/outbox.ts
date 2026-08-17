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

function readEntries(): SmsOutboxEntry[] {
  let raw: string;

  try {
    raw = readFileSync(join(outboxDir, 'sms.jsonl'), 'utf8');
  } catch {
    // Nothing sent yet in this run.
    return [];
  }

  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SmsOutboxEntry);
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
