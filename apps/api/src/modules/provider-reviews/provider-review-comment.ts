/**
 * The stored form of a review comment: every line ending normalised to LF,
 * the other control characters dropped, runs of blanks collapsed to one
 * space, blank lines capped at one, the whole trimmed, and an empty result
 * stored as NULL rather than "". The length limit is checked on the raw input
 * by the DTO, so normalising can only shorten.
 *
 * Order matters. Line endings come first, so a lone CR — what some mobile
 * keyboards and older browsers send for Enter — becomes a line break rather
 * than being deleted with the other controls and gluing two words together.
 * A tab is not stripped either: it falls to the blank-collapsing step and
 * becomes a space.
 */
export function normalizeComment(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}
