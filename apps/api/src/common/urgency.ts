/**
 * The customer's stated timing, in the words a recipient reads.
 *
 * A mirror of `packages/shared/src/urgency.ts`, which is what the web and the
 * admin apps render from. It is copied rather than imported because this
 * package compiles with `rootDir: src` and the shared package ships no build
 * output — importing across would mean restructuring two build setups for one
 * lookup table. `urgency-label-parity.spec.ts` compares the two files on every
 * test run, so the copy cannot drift in silence.
 *
 * The rule that matters is the same on both sides: `ServiceRequest.urgency`
 * holds a storage code — `THIS_WEEK`, `FLEXIBLE` — and no code is ever shown to
 * anybody. A value this table does not know produces null, and the caller drops
 * the row rather than printing the constant. Echoing the raw value is precisely
 * how "29 Ağustos 2026 · THIS_WEEK" reached a customer's inbox.
 */
export const URGENCY_LABELS = {
  TODAY: 'Bugün',
  ASAP: 'En kısa zamanda',
  THIS_WEEK: 'Bu hafta',
  THIS_MONTH: 'Bu ay',
  WITHIN_DAYS: 'Birkaç gün içinde',
  WITHIN_WEEKS: 'Birkaç hafta içinde',
  FLEXIBLE: 'Esnek',
} as const;

export type UrgencyCode = keyof typeof URGENCY_LABELS;

/** The label for a stored code, or null when there is nothing true to say. */
export function urgencyLabel(urgency: string | null | undefined): string | null {
  const code = urgency?.trim();
  if (!code) {
    return null;
  }

  return isUrgencyCode(code) ? URGENCY_LABELS[code] : null;
}

export function isUrgencyCode(value: string): value is UrgencyCode {
  return Object.prototype.hasOwnProperty.call(URGENCY_LABELS, value);
}
