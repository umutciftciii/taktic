import patterns from '../contact-patterns.json';

/**
 * Marketplace requests now publish to providers without an operator reading
 * them first (see `SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH` for the sibling
 * limit that lives the same way). That removes the one human who used to
 * catch a customer trying to route around the platform — "call me on
 * 0532…", "mail me at…", a link to somewhere else — so the check has to run
 * before the text is ever stored.
 *
 * The patterns live in `packages/shared/contact-patterns.json` rather than
 * here, and that indirection is load-bearing for the same reason the
 * description limit's does: the API is compiled to CommonJS and started from
 * its own `dist`, so it cannot `require` this package — `@taktic/shared` is
 * `"type": "module"` and ships TypeScript source, which Node refuses to load
 * at runtime. It reads the JSON directly instead (see
 * `apps/api/src/common/contact-detection.ts`), which requires cleanly from
 * CommonJS. One set of patterns, two readers, no duplicated regex to drift
 * apart.
 */
export type ContactDetailKind = 'phone' | 'email' | 'url';
export type ContactDetection = { kind: ContactDetailKind; match: string };

/**
 * One number token per digit run. A thousands-grouped amount ("50.000",
 * "5.000.000") is captured in group 1 so the tokenizer can tell it apart from
 * a plain run; the lookahead stops "0532.1234567" from being read as the
 * amount "053.123" followed by "4567".
 */
const numberToken = new RegExp(`(${patterns.groupedAmount})(?!\\d)|${patterns.digitRun}`, 'g');
const currencyBefore = new RegExp(`${patterns.currencyMarker}\\s?$`, 'i');
const currencyAfter = new RegExp(`^\\s?${patterns.currencyMarker}`, 'i');
const separatorGap = new RegExp(`^${patterns.phoneSeparators}+$`);
const rangeDash = new RegExp(patterns.rangeDash);
const email = new RegExp(patterns.email, 'i');
const emailObfuscated = new RegExp(patterns.emailObfuscated, 'i');
const url = new RegExp(patterns.url, 'i');

type NumberToken = {
  start: number;
  end: number;
  digits: string;
  /**
   * A money amount, never part of a phone number: thousands-grouped with
   * dots, or sitting next to a currency marker (₺, TL, lira) on either side.
   * The marker is one signal among the token's own shape, not a rule that
   * whitelists the whole text.
   */
  amount: boolean;
};

type Span = [start: number, end: number];

function spanOf(match: RegExpMatchArray): Span {
  const start = match.index ?? 0;
  return [start, start + match[0].length];
}

/** Whether `inner` sits entirely inside `outer`'s matched span. */
function isContainedIn([innerStart, innerEnd]: Span, outer: RegExpMatchArray): boolean {
  const [outerStart, outerEnd] = spanOf(outer);
  return innerStart >= outerStart && innerEnd <= outerEnd;
}

function tokenize(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(numberToken)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const grouped = match[1] !== undefined;
    const amount =
      grouped || currencyBefore.test(text.slice(0, start)) || currencyAfter.test(text.slice(end));
    tokens.push({ start, end, digits: match[0], amount });
  }
  return tokens;
}

/**
 * Whether two neighbouring plain tokens belong to the same phone candidate.
 * Only phone separators may sit between them, and a dash between two groups
 * of four or more digits is a range ("50000-60000"), not a phone's grouping
 * ("0532-123-45-67" keeps its short groups together).
 */
function joinsPhoneRun(text: string, prev: NumberToken, next: NumberToken): boolean {
  const gap = text.slice(prev.end, next.start);
  if (!separatorGap.test(gap)) return false;
  if (
    rangeDash.test(gap) &&
    prev.digits.length >= patterns.rangeDigitsMin &&
    next.digits.length >= patterns.rangeDigitsMin
  ) {
    return false;
  }
  return true;
}

/**
 * Maximal runs of plain digit tokens joined by phone separators. Amount
 * tokens never join a run; they split one.
 */
function phoneRuns(text: string, tokens: NumberToken[]): NumberToken[][] {
  const runs: NumberToken[][] = [];
  let run: NumberToken[] = [];
  let prev: NumberToken | undefined;
  for (const token of tokens) {
    if (token.amount) {
      if (run.length > 0) runs.push(run);
      run = [];
      prev = undefined;
      continue;
    }
    if (prev && !joinsPhoneRun(text, prev, token)) {
      runs.push(run);
      run = [];
    }
    run.push(token);
    prev = token;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function isPhoneDigits(digits: string): boolean {
  if (digits.length < patterns.phoneDigitsMin || digits.length > patterns.phoneDigitsMax) return false;
  return patterns.phonePrefixes.some((prefix) => digits.startsWith(prefix));
}

/**
 * Finds the first thing in `text` that looks like a way to reach somebody
 * outside the platform. An obstacle, not a guarantee: a number spelled out in
 * words walks past it, and the provider's "Talebi bildir" is the second layer.
 *
 * The three patterns are checked together rather than strictly phone, then
 * email, then url, because a link can swallow a phone number
 * ("wa.me/905321234567") and an address can swallow a domain
 * ("ali@example.com" contains "example.com"). When one match's span sits
 * entirely inside another's, the wider, more specific match wins — a link or
 * an address, not the digit run or bare domain buried inside it.
 *
 * Phone numbers are judged token by token rather than by stripping every
 * separator out of a loose digit run: that used to fuse "50.000 - 60.000 TL"
 * into one 0-prefixed ten-digit "number". Each digit run is a token; grouped
 * amounts and currency-adjacent tokens are money and never join a candidate;
 * the rest join across phone separators, except a dash between two long
 * groups, which reads as a range. Every contiguous slice of a run is tried,
 * so a stray "Daire 7" in front of a real number does not hide it.
 */
export function detectContactDetails(text: string): ContactDetection | null {
  const urlMatch = text.match(url);
  const emailMatch = text.match(email) ?? text.match(emailObfuscated);

  if (emailMatch && (!urlMatch || isContainedIn(spanOf(urlMatch), emailMatch))) {
    return { kind: 'email', match: emailMatch[0] };
  }

  for (const run of phoneRuns(text, tokenize(text))) {
    for (let from = 0; from < run.length; from += 1) {
      for (let to = run.length; to > from; to -= 1) {
        const slice = run.slice(from, to);
        const [first] = slice;
        const last = slice[slice.length - 1];
        if (!first || !last) continue;
        const digits = slice.map((token) => token.digits).join('');
        if (!isPhoneDigits(digits)) continue;
        const start = text[first.start - 1] === '+' ? first.start - 1 : first.start;
        const end = last.end;
        if (urlMatch && isContainedIn([start, end], urlMatch)) continue;
        return { kind: 'phone', match: text.slice(start, end) };
      }
    }
  }

  if (urlMatch) return { kind: 'url', match: urlMatch[0] };

  return null;
}
