/**
 * The customer's stated timing, in the words a person reads.
 *
 * `ServiceRequest.urgency` is a short code the request form writes and the
 * database stores verbatim — `THIS_WEEK`, `FLEXIBLE`. It is a storage detail,
 * and it is never a thing to show anybody. Before this table existed the web
 * app and the admin app each carried their own copy of the mapping and the
 * e-mail templates carried none, which is exactly how a customer came to be
 * told their preferred time was "29 Ağustos 2026 · THIS_WEEK".
 *
 * One table, one rule: a code this file does not know produces nothing at all.
 * Echoing the raw value back — the `?? urgency` the two copies used to end with
 * — is what turned an unmapped option into a leak on screen, and a caller that
 * gets null can choose its own honest fallback ("-" in a definition list, a
 * dropped row in an e-mail) rather than printing a constant.
 */

/**
 * Every code the product has ever written to `urgency`, and what it means.
 *
 * The first three are what the request form offers today; the rest are earlier
 * spellings that still sit in rows created before the form settled, and they
 * are kept because a 2025 request is still opened and still mailed about.
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

/**
 * The label for a stored code, or null when there is nothing true to say.
 *
 * Null covers three cases that are the same to a reader: the customer chose
 * nothing, the column is blank, and the column holds something this build does
 * not recognise. None of them is worth printing a code for.
 */
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
