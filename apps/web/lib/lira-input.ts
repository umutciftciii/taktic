/**
 * The Turkish-lira budget inputs on the public request form.
 *
 * Three pure functions and one rule between them: what the customer types is
 * read as lira, never as kuruş. `5000` is five thousand lira — the field grows
 * to `5.000,00`, it does not shrink to `50,00`. Kuruş are opt-in, written after
 * a comma the way they are written on a Turkish price tag.
 *
 * Separators follow from that. `,` is the decimal point, `.` groups thousands,
 * and because the field inserts the grouping itself the customer never has to
 * type a `.` — so a `.` arriving from the keyboard or a paste is read as the
 * grouping it looks like and dropped, leaving the digits around it intact.
 * Anything else — a `₺`, a space, a stray letter — is not part of a number and
 * is discarded before any of this is decided.
 *
 * Nothing here touches the wire format: {@link parseLiraToMinor} converts to
 * the minor-unit integer (kuruş) the API's DTO has always taken, which is why
 * the formatting is confined to the browser and the stored column is unchanged.
 */

/**
 * How many digits the lira part may carry.
 *
 * Twelve lira digits and two kuruş digits make a fourteen-digit integer, which
 * stays well inside `Number.MAX_SAFE_INTEGER` — so a pasted wall of digits
 * cannot turn the minor-unit amount into a value that has lost precision.
 */
const MAX_LIRA_DIGITS = 12;

/** The kuruş part is two digits, as the currency has always been written. */
const KURUS_DIGITS = 2;

type LiraDraft = {
  /** The lira digits, without grouping and without leading zeros. */
  lira: string;
  /** The kuruş digits typed so far, or null while no comma has been typed. */
  kurus: string | null;
};

/**
 * What the customer has actually entered, with the presentation stripped off.
 *
 * Returns null for anything carrying neither a digit nor a comma — an empty
 * field, or one holding only a currency sign — so "nothing entered" stays
 * distinguishable from "zero entered".
 */
function readDraft(raw: string): LiraDraft | null {
  // Grouping dots go with the letters, spaces and currency signs: none of them
  // carry information the field does not re-derive when it formats.
  const cleaned = raw.replace(/[^\d,]/g, '');
  const comma = cleaned.indexOf(',');

  let lira = (comma === -1 ? cleaned : cleaned.slice(0, comma))
    .replace(/^0+(?=\d)/, '')
    .slice(0, MAX_LIRA_DIGITS);

  // Only the first comma separates; later ones are the customer typing over a
  // decimal point that is already there.
  const kurus =
    comma === -1
      ? null
      : cleaned
          .slice(comma + 1)
          .replace(/,/g, '')
          .slice(0, KURUS_DIGITS);

  if (lira === '' && kurus === null) {
    return null;
  }

  // `,50` is half a lira, and reads as such the moment the comma is typed.
  if (lira === '') {
    lira = '0';
  }

  return { lira, kurus };
}

/** `5000` -> `5.000`. Operates on bare digits, so it never sees a separator. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * The field's value as the customer types, deletes and pastes.
 *
 * Grouping is applied on every keystroke, but the kuruş are left exactly as
 * typed: forcing `,00` onto a half-written number would put the caret behind
 * two digits the customer never asked for and make typing kuruş at all a
 * fight. {@link completeLiraAmount} does the padding once the field is left.
 */
export function formatLiraDraft(raw: string): string {
  const draft = readDraft(raw);
  if (!draft) {
    return '';
  }

  const lira = groupThousands(draft.lira);
  return draft.kurus === null ? lira : `${lira},${draft.kurus}`;
}

/**
 * The finished amount, as the field shows it once the customer moves on.
 *
 * `5000` becomes `5.000,00` and `5000,5` becomes `5.000,50`; an empty field
 * stays empty, because these two fields are optional and a customer who skipped
 * them has not entered zero.
 */
export function completeLiraAmount(raw: string): string {
  const draft = readDraft(raw);
  if (!draft) {
    return '';
  }

  return `${groupThousands(draft.lira)},${(draft.kurus ?? '').padEnd(KURUS_DIGITS, '0')}`;
}

/**
 * The amount in the minor unit the API stores — kuruş for TRY.
 *
 * `5.000,00` is 500000, not 5000: the digits before the comma are lira, and the
 * conversion is the only place the two units meet. An empty field is null,
 * which is what an optional budget has always posted.
 */
export function parseLiraToMinor(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const draft = readDraft(raw);
  if (!draft) {
    return null;
  }

  const minor = Number(`${draft.lira}${(draft.kurus ?? '').padEnd(KURUS_DIGITS, '0')}`);
  return Number.isSafeInteger(minor) ? minor : null;
}
