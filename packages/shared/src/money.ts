/**
 * Turkish-lira amounts at the two places they cross a boundary: read from an
 * operator's form field, and written back into one.
 *
 * The stored unit is the minor unit — kuruş — as an integer, everywhere in
 * this product. That is the right storage unit and the wrong language for a
 * form: an operator pricing a package thinks in lira, and a label that says
 * "(kuruş)" invites the off-by-a-hundred mistake this file exists to prevent.
 *
 * ## The rules, in the order they are applied
 *
 * - The comma is the decimal separator and the dot groups thousands, as on a
 *   Turkish price tag: `1.250,75` is one thousand two hundred and fifty lira
 *   and seventy-five kuruş.
 * - Grouping is optional and, when present, must be regular: `1.250` is fine,
 *   `12.50` is not a number (it would be read as twelve lira fifty by an
 *   operator expecting the dot to be a decimal point, and refusing it is the
 *   only way to make sure nobody stores 1250 lira by mistake).
 * - At most two decimal digits. A third has no representation in kuruş and
 *   is refused rather than rounded: a price is a decision, not an estimate.
 * - Zero and negative amounts are refused. Nothing this product sells is free
 *   and nothing costs less than nothing.
 * - Whitespace and a currency sign are ignored; any other character is a
 *   refusal.
 *
 * ## No floating point
 *
 * The digits are moved, never multiplied: `10,5` becomes the string `1050`
 * and then an integer. `10.5 * 100` is a number that happens to print as
 * `1050` today and as `1049.9999` under a different rounding mode, and money
 * is the one place that difference is a defect.
 */

const MAX_MAJOR_DIGITS = 12;
const MINOR_DIGITS = 2;

/**
 * `10` → 1000, `10,5` → 1050, `10,50` → 1050, `1.250,75` → 125075.
 *
 * Returns null for anything that is not a positive amount with at most two
 * decimals written the Turkish way. Null rather than a throw, because the
 * callers are form actions that turn it into a sentence for the operator.
 */
export function parseTurkishLiraToMinor(input: string | null | undefined): number | null {
  if (input === null || input === undefined) {
    return null;
  }

  const raw = input.replace(/[\s₺]/g, '');
  if (raw === '') {
    return null;
  }

  // Lira, optionally grouped in threes with dots; then an optional comma and
  // one or two kuruş digits. Nothing else.
  const match = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(raw);
  if (!match) {
    return null;
  }

  const major = match[1]!.replace(/\./g, '');
  const minor = (match[2] ?? '').padEnd(MINOR_DIGITS, '0');

  if (major.length > MAX_MAJOR_DIGITS) {
    return null;
  }

  const value = Number(`${major}${minor}`);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

/**
 * The stored integer, as the form should show it: `1000` → `10,00`,
 * `125075` → `1.250,75`.
 *
 * Always two decimals, because the field is going to be read back by
 * {@link parseTurkishLiraToMinor} and an amount that round-trips unchanged
 * is the whole point. Null and non-integers become an empty field.
 */
export function formatMinorAsTurkishLiraInput(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isInteger(amountMinor)) {
    return '';
  }

  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor)).padStart(MINOR_DIGITS + 1, '0');
  const major = digits.slice(0, -MINOR_DIGITS);
  const minor = digits.slice(-MINOR_DIGITS);

  return `${sign}${major.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${minor}`;
}

/**
 * The stored integer with its sign, for lists and detail screens:
 * `1000` → `₺10,00`, `125075` → `₺1.250,75`.
 *
 * Built from {@link formatMinorAsTurkishLiraInput} rather than from
 * `Intl.NumberFormat`, so a server rendering in one locale and a browser
 * hydrating in another cannot produce two spellings of one price. Only the
 * lira sign is known here; another currency is written after the amount as
 * its code.
 */
export function formatMinorAsTurkishLira(amountMinor: number, currency = 'TRY'): string {
  const amount = formatMinorAsTurkishLiraInput(amountMinor);
  return currency.toUpperCase() === 'TRY' ? `₺${amount}` : `${amount} ${currency.toUpperCase()}`;
}
