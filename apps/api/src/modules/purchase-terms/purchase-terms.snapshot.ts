import { createHash } from 'node:crypto';
import type { PurchaseTermsDocumentSet } from './purchase-terms.documents';

/**
 * The combined text a provider accepts, byte for byte.
 *
 * One string, not three links: the acceptance row stores exactly this and its
 * SHA-256, so "what did they accept" is answered by the row itself however the
 * published pages change later (CMP-006 D8a).
 *
 * The layout is part of the database contract — the CHECK
 * `PurchaseTermsAcceptance_snapshot_shape` reads the header line and the three
 * section markers — so it changes only together with a migration:
 *
 *   TAKTIC PACKAGE_PURCHASE_TERMS
 *   version: <version>
 *
 *   === <KEY>: <title> ===
 *   <text>
 *
 *   === <KEY>: <title> ===
 *   …
 *
 * Line endings are `\n` and each text is kept exactly as written: nothing is
 * trimmed or normalised here, because a digest over a normalised copy would
 * prove a text nobody was shown.
 */
export function buildPurchaseTermsSnapshot(set: PurchaseTermsDocumentSet): string {
  const header = `TAKTIC ${set.documentKey}\nversion: ${set.version}\n`;
  const sections = set.documents.map(
    (document) => `\n=== ${document.key}: ${document.title} ===\n${document.text}\n`,
  );
  return header + sections.join('');
}

/** Hex SHA-256 over the UTF-8 bytes — the same bytes the database CHECK hashes. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
