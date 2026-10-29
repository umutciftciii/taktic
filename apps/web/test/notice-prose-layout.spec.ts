import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A notice box (`pdash-notice`, `cdash-notice`) is a flex row for an icon
 * beside a message. A sentence with a link in it laid out that way splits at
 * every inline element — the words before the link, the link and the words
 * after it become three columns. These notices are such sentences, so each
 * carries `notice-prose` (block flow) on the box itself.
 */

const NOTICES = [
  ['app/providers/[id]/offers/[offerId]/page.tsx', 'offer-match-failed'],
  ['app/providers/[id]/vitrin/talepler/[leadId]/page.tsx', 'lead-offer-insufficient'],
  ['app/destek/[ticketId]/page.tsx', 'support-closed-notice'],
] as const;

describe('a notice that is a sentence with a link in it', () => {
  it.each(NOTICES)('%s [%s] is laid out as prose', (path, testId) => {
    const source = readFileSync(resolve(__dirname, '..', path), 'utf8');
    const tag = source.match(new RegExp(`<div className="([^"]*)"[^>]*data-testid="${testId}"`));
    expect(tag, `${testId} in ${path}`).not.toBeNull();
    expect(tag![1]!.split(/\s+/)).toContain('notice-prose');
  });
});
