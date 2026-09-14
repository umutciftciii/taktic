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
const strictPhone = new RegExp(patterns.strictPhone);
const strictPhoneDashedPair = new RegExp(patterns.strictPhoneDashedPair);
const spacedRangeDash = new RegExp(`\\s${patterns.rangeDash}|${patterns.rangeDash}\\s`);
const phoneShapes = new Set(patterns.phoneShapes.map((shape) => shape.join(',')));
const phoneShapeMaxTokens = Math.max(...patterns.phoneShapes.map((shape) => shape.length));
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
type NumberToken = {
  start: number;
  end: number;
  digits: string;
  kind: NumberTokenKind;
  /**
   * Whether the token is a bare digit run by shape — not thousands-grouped,
   * not a date — whatever context later makes of it. The strict pass reads
   * this and ignores `kind`.
   */
  bare: boolean;
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
    const bare = match[1] === undefined && match[2] === undefined;
    tokens.push({ start: span[0], end: span[1], digits: match[0].replace(/\D/g, ''), kind, bare });
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
 * The slices of a run that may be a phone number.
 *
 * A short run — a number with a stray "Daire 7" or "0090" in front of it —
 * may drop leading tokens, so the number is found behind them. It may not
 * drop trailing tokens: a list of measurements ("90 100 110 120 130") would
 * otherwise yield a "90…" phone number from its first few entries.
 * `phoneRunSlackDigits` (3) is how much such a stray prefix may add on top
 * of the longest phone number before the run stops counting as short.
 *
 * A long run — an IBAN, a list, digit spam — is judged only at its two
 * ends: the windows anchored at its start and the windows anchored at its
 * end, so a number written after a list ("30 40 50 60 70 80 0532 123 45 67")
 * is still found, while a 0/5-prefixed stretch buried in the middle of an
 * IBAN does not turn it into one. Every token carries at least one digit,
 * so no window longer than phoneDigitsMax tokens can qualify; that bounds
 * the work per run to a couple of dozen slices whatever the run's length.
 */
function phoneSlices(run: NumberToken[]): NumberToken[][] {
  const total = run.reduce((sum, token) => sum + token.digits.length, 0);
  const slices: NumberToken[][] = [];
  if (total > patterns.phoneDigitsMax + patterns.phoneRunSlackDigits) {
    const window = Math.min(run.length, patterns.phoneDigitsMax);
    for (let to = window; to > 0; to -= 1) slices.push(run.slice(0, to));
    for (let from = run.length - window; from < run.length; from += 1) {
      if (from > 0) slices.push(run.slice(from));
    }
    return slices;
  }
  for (let from = 0; from < run.length; from += 1) slices.push(run.slice(from));
  return slices;
}

/**
 * The strict pass: a phone number written the way people write phone
 * numbers is a phone number, whatever sits next to it. It runs before any
 * amount, currency, range or date reasoning, on bare digit tokens joined by
 * phone separators — dashes never split here, currency neighbours are
 * ignored — and accepts a slice only when its group shape is on the
 * `phoneShapes` allow-list ("0532 123 45 67" is 4-3-2-2, "0212-5554433" is
 * 4-7) and its digits form a strict Turkish number: trunk 0 or country 90
 * then a 2xx–5xx area or mobile code and nine more digits, or a bare ten
 * digit 5xx mobile. Shape is what keeps money out: "50000-60000" is 5-5
 * and no allow-listed shape, however its digits read. The allow-list also
 * bounds the window, so a long run costs a handful of slices per token.
 *
 * Grouped amounts and dates are not bare tokens, so "50.000 - 60.000 TL"
 * can never be read as 2-3-2-3 here. The one shape money can still take is
 * two groups on a dash — "500 - 5000000 TL" is 3-7 like "212-5554433" —
 * so a two-group slice joined by a dash is held to more: a spaced dash is
 * a range, never a phone separator ("0212-5554433" stays, "0212 - 5554433"
 * is left to the contextual pass), and an unspaced one must carry a trunk
 * or country prefix (`strictPhoneDashedPair`), so "550-5500000 lira" is not
 * read as a bare mobile while "532-1234567" still is, by the contextual
 * pass. What this pass does not find falls through to that pass in
 * `detectContactDetails`.
 */
function findStrictPhone(text: string, tokens: NumberToken[], urlMatch: RegExpMatchArray | null): Span | null {
  const runs: NumberToken[][] = [];
  let run: NumberToken[] = [];
  for (const token of tokens) {
    if (!token.bare) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && !separatorGap.test(text.slice(prev.end, token.start))) {
      runs.push(run);
      run = [];
    }
    run.push(token);
  }
  if (run.length > 0) runs.push(run);

  for (const tokensOfRun of runs) {
    for (let from = 0; from < tokensOfRun.length; from += 1) {
      const toMax = Math.min(tokensOfRun.length, from + phoneShapeMaxTokens);
      for (let to = toMax; to > from; to -= 1) {
        const slice = tokensOfRun.slice(from, to);
        if (!phoneShapes.has(slice.map((token) => token.digits.length).join(','))) continue;
        const digits = slice.map((token) => token.digits).join('');
        if (!strictPhone.test(digits)) continue;
        if (slice.length === 2 && !isStrictDashedPair(text, slice, digits)) continue;
        const span = phoneSpan(text, slice);
        if (urlMatch && isContainedIn(span, urlMatch)) continue;
        return span;
      }
    }
  }
  return null;
}

/** The two-group dash rule described on `findStrictPhone`. */
function isStrictDashedPair(text: string, [first, second]: NumberToken[], digits: string): boolean {
  if (!first || !second) return false;
  const gap = text.slice(first.end, second.start);
  if (!rangeDash.test(gap)) return true;
  if (spacedRangeDash.test(gap)) return false;
  return strictPhoneDashedPair.test(digits);
}

/**
 * The text span a phone slice reports, a leading "+" included. It starts at
 * the first digit, so "(0532) 123 45 67" reports "0532) 123 45 67" —
 * informational only; the refusal carries the field and kind, not this.
 */
function phoneSpan(text: string, slice: NumberToken[]): Span {
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (!first || !last) return [0, 0];
  const start = text[first.start - 1] === '+' ? first.start - 1 : first.start;
  return [start, last.end];
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
 * into one 0-prefixed ten-digit "number". Two passes over the same tokens:
 * first the strict one (`findStrictPhone`) — well-formed numbers win over
 * every exception, so "0532 123 45 67 TL" is still a phone number — then
 * the contextual one, where amounts and dates never join a candidate, the
 * rest join across phone separators except a dash between two long groups,
 * which reads as a range, and `phoneSlices` decides which parts of a run
 * are tried.
 */
export function detectContactDetails(text: string): ContactDetection | null {
  const urlMatch = text.match(url);
  const emailMatch = text.match(email) ?? text.match(emailObfuscated);

  if (emailMatch && (!urlMatch || isContainedIn(spanOf(urlMatch), emailMatch))) {
    return { kind: 'email', match: emailMatch[0] };
  }

  const tokens = tokenize(text);

  const strict = findStrictPhone(text, tokens, urlMatch);
  if (strict) return { kind: 'phone', match: text.slice(strict[0], strict[1]) };

  for (const run of phoneRuns(text, tokens)) {
    for (const slice of phoneSlices(run)) {
      if (slice.length === 0) continue;
      const digits = slice.map((token) => token.digits).join('');
      if (!isPhoneDigits(digits)) continue;
      const span = phoneSpan(text, slice);
      if (urlMatch && isContainedIn(span, urlMatch)) continue;
      return { kind: 'phone', match: text.slice(span[0], span[1]) };
    }
  }

  if (urlMatch) return { kind: 'url', match: urlMatch[0] };

  return null;
}
