/**
 * Status → tag class, shared by the customer screens.
 *
 * Lives in its own module because both server components and the client-side
 * board need it: exporting it from a `'use client'` file would turn it into a
 * client reference that the server cannot call.
 *
 * The colours are the design's: live requests carry the accent tag, a matched
 * request is the one state filled with ink, everything else stays neutral.
 */
export function statusPillClass(status: string): string {
  switch (status) {
    case 'APPROVED':
      return 'tag tag-accent';
    case 'MATCHED':
    case 'ACCEPTED':
      return 'tag tag-ink';
    default:
      return 'tag tag-neutral';
  }
}
