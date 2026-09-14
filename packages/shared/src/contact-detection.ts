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
 * "5.000.000") is captured in group 1 and a date ("15.09.2026") in group 2
 * so the tokenizer can tell them from a plain run; the lookaheads stop
 * "0532.1234567" from being read as the amount "053.123" followed by "4567".
 */
const numberToken = new RegExp(
  `(${patterns.groupedAmount})(?!\\d)|(${patterns.dateToken})(?!\\d)|${patterns.digitRun}`,
  'g',
);
const spaceGroupedAmount = new RegExp(`${patterns.spaceGroupedAmount}(?!\\d)`, 'g');
const currencyBefore = new RegExp(`${patterns.currencyBefore}\\s?$`, 'i');
const currencyAfter = new RegExp(`^\\s?${patterns.currencyAfter}`, 'i');
const separatorGap = new RegExp(`^${patterns.phoneSeparators}+$`);
const rangeDash = new RegExp(patterns.rangeDash);
const rangeGap = new RegExp(`^\\s*${patterns.rangeDash}\\s*$`);
const email = new RegExp(patterns.email, 'i');
const emailObfuscated = new RegExp(patterns.emailObfuscated, 'i');
const url = new RegExp(patterns.url, 'i');

/**
 * What a digit run is. Only `plain` tokens can be part of a phone number;
 * the other two never join a candidate and split one where they sit.
 *
 * - `amount`: money — thousands-grouped with dots, next to a currency marker
 *   (₺ before; ₺, TL, lira after), or a space-grouped figure with that
 *   context (see `markSpaceGroupedAmounts`). The marker is one signal beside
 *   the token's own shape, not a rule that whitelists the whole text. Only
 *   the symbol counts in front: Turkish writes "50.000 TL", not "TL 50.000",
 *   and reading "TL" backwards would hide the number in
 *   "Bütçe 50.000 TL 0532 123 45 67".
 * - `date`: "15.09.2026", so a date range does not read as digits.
 */
type NumberTokenKind = 'plain' | 'amount' | 'date';
type NumberToken = { start: number; end: number; digits: string; kind: NumberTokenKind };

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

/**
 * A currency marker directly before or after `[start, end)`, one space
 * allowed. Only a short window around the span is inspected — long enough
 * to hold any marker, its space and the character that decides its word
 * boundary — so a text full of numbers is not re-sliced from its start for
 * every token.
 */
function isCurrencyAdjacent(text: string, [start, end]: Span): boolean {
  const window = patterns.currencyWindow;
  return (
    currencyBefore.test(text.slice(Math.max(0, start - window), start)) ||
    currencyAfter.test(text.slice(end, end + window))
  );
}

function tokenize(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(numberToken)) {
    const span = spanOf(match);
    // "+90.532.123.45.67": a grouped figure right behind a plus is a dialling
    // code with dotted groups, not money.
    const grouped = match[1] !== undefined && text[span[0] - 1] !== '+';
    const kind: NumberTokenKind =
      match[2] !== undefined ? 'date' : grouped || isCurrencyAdjacent(text, span) ? 'amount' : 'plain';
    tokens.push({ start: span[0], end: span[1], digits: match[0].replace(/\D/g, ''), kind });
  }
  markSpaceGroupedAmounts(text, tokens);
  return tokens;
}

/**
 * "5 000 000" is shaped exactly like a phone number's groups, so the shape
 * alone proves nothing and the tokenizer leaves it as plain tokens. It is
 * money only with context: a currency marker on either side of the whole
 * group, or a range dash tying it to something already known to be an
 * amount ("5 000 000 - 6 000 000 TL", "5 000 - 6.000"). Then every token
 * inside the group becomes an amount and cannot join a phone candidate.
 */
function markSpaceGroupedAmounts(text: string, tokens: NumberToken[]): void {
  const groups: Array<{ span: Span; amount: boolean }> = [];
  for (const match of text.matchAll(spaceGroupedAmount)) {
    const span = spanOf(match);
    // Not preceded by a digit: "532 123" inside "0532 123 45 67" is not a group.
    if (span[0] > 0 && /\d/.test(text[span[0] - 1] ?? '')) continue;
    groups.push({ span, amount: isCurrencyAdjacent(text, span) });
  }
  if (groups.length === 0) return;

  const known = tokens
    .filter((token) => token.kind === 'amount')
    .map((token) => ({ span: [token.start, token.end] as Span, amount: true }));
  const items = [...groups, ...known].sort((a, b) => a.span[0] - b.span[0]);

  // A dash between two neighbours spreads "amount" across it; repeat until
  // a chain like "1 000 - 2 000 - 3 000 TL" has settled.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < items.length; i += 1) {
      const a = items[i];
      const b = items[i + 1];
      if (!a || !b || a.amount === b.amount) continue;
      if (!rangeGap.test(text.slice(a.span[1], b.span[0]))) continue;
      a.amount = true;
      b.amount = true;
      changed = true;
    }
  }

  for (const group of groups) {
    if (!group.amount) continue;
    for (const token of tokens) {
      if (token.start >= group.span[0] && token.end <= group.span[1]) token.kind = 'amount';
    }
  }
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
 * Maximal runs of plain digit tokens joined by phone separators. Amount and
 * date tokens never join a run; they split one.
 */
function phoneRuns(text: string, tokens: NumberToken[]): NumberToken[][] {
  const runs: NumberToken[][] = [];
  let run: NumberToken[] = [];
  let prev: NumberToken | undefined;
  for (const token of tokens) {
    if (token.kind !== 'plain') {
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

/**
 * The slices of a run that may be a phone number, longest first.
 *
 * A short run — a number with a stray "Daire 7" or "0090" in front of it —
 * may drop leading tokens, so the number is found behind them. It may not
 * drop trailing tokens: a list of measurements ("90 100 110 120 130") would
 * otherwise yield a "90…" phone number from its first few entries.
 *
 * A long run — an IBAN, a list, digit spam — is judged from its start only,
 * so a 0/5-prefixed stretch buried in the middle does not turn it into a
 * phone number. Every token carries at least one digit, so no slice longer
 * than phoneDigitsMax tokens can qualify; that bounds the work per run.
 */
function phoneSlices(run: NumberToken[]): NumberToken[][] {
  const total = run.reduce((sum, token) => sum + token.digits.length, 0);
  const slices: NumberToken[][] = [];
  if (total > patterns.phoneDigitsMax + patterns.phoneRunSlackDigits) {
    for (let to = Math.min(run.length, patterns.phoneDigitsMax); to > 0; to -= 1) {
      slices.push(run.slice(0, to));
    }
    return slices;
  }
  for (let from = 0; from < run.length; from += 1) slices.push(run.slice(from));
  return slices;
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
 * into one 0-prefixed ten-digit "number". Each digit run is a token; amounts
 * and dates never join a candidate; the rest join across phone separators,
 * except a dash between two long groups, which reads as a range. See
 * `phoneSlices` for which parts of a run are then tried.
 */
export function detectContactDetails(text: string): ContactDetection | null {
  const urlMatch = text.match(url);
  const emailMatch = text.match(email) ?? text.match(emailObfuscated);

  if (emailMatch && (!urlMatch || isContainedIn(spanOf(urlMatch), emailMatch))) {
    return { kind: 'email', match: emailMatch[0] };
  }

  for (const run of phoneRuns(text, tokenize(text))) {
    for (const slice of phoneSlices(run)) {
      const [first] = slice;
      const last = slice[slice.length - 1];
      if (!first || !last) continue;
      const digits = slice.map((token) => token.digits).join('');
      // Slices come longest first; once one is too short, the rest are too.
      if (digits.length < patterns.phoneDigitsMin) break;
      if (!isPhoneDigits(digits)) continue;
      // The match starts at the first digit (a leading "+" included), so
      // "(0532) 123 45 67" reports "0532) 123 45 67" — informational only,
      // the refusal carries the field and kind, not this string.
      const start = text[first.start - 1] === '+' ? first.start - 1 : first.start;
      const end = last.end;
      if (urlMatch && isContainedIn([start, end], urlMatch)) continue;
      return { kind: 'phone', match: text.slice(start, end) };
    }
  }

  if (urlMatch) return { kind: 'url', match: urlMatch[0] };

  return null;
}
