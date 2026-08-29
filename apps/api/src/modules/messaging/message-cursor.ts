/**
 * The cursor messaging pages on.
 *
 * `(createdAt, id)` rather than `createdAt` alone: two messages written in the
 * same millisecond would otherwise have no defined order, and a page boundary
 * that lands between them would either repeat one or lose one. The id breaks
 * the tie, so the sequence is total and every page is reproducible.
 *
 * It is encoded rather than handed over raw so a client cannot build one by
 * arithmetic and go fishing — a cursor is something the server gave out, and a
 * malformed one is refused rather than guessed at. It is not a secret and
 * carries nothing but a timestamp and a message id the caller already has.
 */

export type MessageCursor = {
  createdAt: Date;
  id: string;
};

export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeMessageCursor(raw: string | undefined | null): MessageCursor | null {
  if (!raw) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf('|');
  if (separator <= 0) {
    return null;
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) {
    return null;
  }

  return { createdAt, id };
}
