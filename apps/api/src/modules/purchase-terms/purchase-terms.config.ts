import { parseAppEnvironment } from '../../common/app-environment';
import {
  PURCHASE_TERMS_DOCUMENT_KEYS,
  PURCHASE_TERMS_DOCUMENT_SET,
  PURCHASE_TERMS_DOCUMENT_SET_KEY,
  type PurchaseTermsDocument,
  type PurchaseTermsDocumentSet,
} from './purchase-terms.documents';
import { buildPurchaseTermsSnapshot, sha256Hex } from './purchase-terms.snapshot';

/**
 * The purchase-terms release gate (CMP-006 PR-A).
 *
 * ## Default: closed, everywhere
 *
 * `PURCHASE_TERMS_GATE` unset, empty or `off` means the checkout behaves
 * exactly as it did before this module existed: no terms are served, none are
 * asked for, none are written. That is the answer on every environment —
 * local, staging and production alike — until somebody opens the gate on
 * purpose.
 *
 * ## Opening it: `PURCHASE_TERMS_GATE=on`
 *
 * Accepted only with a document set that is whole, and refused loudly
 * otherwise — the process does not boot (see PurchaseTermsService
 * .onModuleInit). "Whole" means:
 *
 *   - the set key, a version the database CHECK also accepts, and the three
 *     documents in their fixed order, each with a title and a real text (at
 *     least 200 characters once links are removed — a list of links is not a
 *     text);
 *   - a declared SHA-256 that equals the digest of the combined snapshot
 *     recomputed here, so an edited text with a stale digest is a corrupt set;
 *   - on staging, production or an undeclared environment: a legal review of
 *     `APPROVED` with a date and a reference (RG-1). A draft may be exercised
 *     only on a declared local stack or in a unit-test worker, where the web
 *     app labels it TASLAK.
 *
 * There is no lenient fallback: a set that fails any rule never reaches a
 * checkout, which is what fail-closed means here.
 *
 * Nothing here reads a request.
 */
export const PURCHASE_TERMS_GATE_VAR = 'PURCHASE_TERMS_GATE';

export type ValidatedPurchaseTerms = {
  documentKey: string;
  version: string;
  legalReviewStatus: 'PENDING' | 'APPROVED';
  documents: readonly PurchaseTermsDocument[];
  /** The combined text, exactly as it is stored on an acceptance row. */
  snapshot: string;
  sha256: string;
};

export type PurchaseTermsGate =
  | { enabled: false }
  | { enabled: true; terms: ValidatedPurchaseTerms };

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIN_TEXT_LENGTH = 200;

/**
 * Every reason a document set cannot be served, in a fixed order. Empty means
 * whole. Exported for the unit test, which proves each rule on its own.
 */
export function validatePurchaseTermsDocumentSet(set: PurchaseTermsDocumentSet): string[] {
  const problems: string[] = [];

  if (set.documentKey !== PURCHASE_TERMS_DOCUMENT_SET_KEY) {
    problems.push(`documentKey must be ${PURCHASE_TERMS_DOCUMENT_SET_KEY}`);
  }

  if (typeof set.version !== 'string' || !VERSION_PATTERN.test(set.version)) {
    problems.push('version must be 1–64 characters of [0-9A-Za-z._-], starting with a letter or digit');
  }

  const keys = set.documents.map((document) => document.key);
  if (
    keys.length !== PURCHASE_TERMS_DOCUMENT_KEYS.length ||
    keys.some((key, index) => key !== PURCHASE_TERMS_DOCUMENT_KEYS[index])
  ) {
    problems.push(`documents must be exactly ${PURCHASE_TERMS_DOCUMENT_KEYS.join(', ')}, in that order`);
  }

  for (const document of set.documents) {
    const title = typeof document.title === 'string' ? document.title.trim() : '';
    if (!title || /[\r\n]/.test(document.title) || document.title.includes('===')) {
      problems.push(`${document.key}: title must be one non-empty line without "==="`);
    }

    const text = typeof document.text === 'string' ? document.text : '';
    if (text.includes('\n=== ') || text.startsWith('=== ')) {
      problems.push(`${document.key}: text must not contain a section marker`);
    }

    const withoutLinks = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (withoutLinks.length < MIN_TEXT_LENGTH) {
      problems.push(
        `${document.key}: text must be the full document (at least ${MIN_TEXT_LENGTH} characters besides links)`,
      );
    }
  }

  if (!SHA256_PATTERN.test(set.sha256)) {
    problems.push('sha256 must be 64 lower-case hex characters');
  } else if (sha256Hex(buildPurchaseTermsSnapshot(set)) !== set.sha256) {
    problems.push('sha256 does not match the combined snapshot of the documents');
  }

  if (set.legalReview.status === 'APPROVED') {
    const approvedAt = Date.parse(set.legalReview.approvedAt);
    if (Number.isNaN(approvedAt)) {
      problems.push('legalReview.approvedAt must be an ISO date');
    }
    if (!set.legalReview.reference?.trim()) {
      problems.push('legalReview.reference must name the approval');
    }
  } else if (set.legalReview.status !== 'PENDING') {
    problems.push('legalReview.status must be PENDING or APPROVED');
  }

  return problems;
}

/**
 * Whether a document set still awaiting legal review may be served: only on a
 * declared local stack or in a unit-test worker. Staging is deliberately not
 * local — it is where the approved text is proved before production.
 */
export function isDraftPurchaseTermsPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') {
    return true;
  }
  return parseAppEnvironment(env.APP_ENVIRONMENT) === 'local';
}

/**
 * The whole contract, evaluated from the given environment. Throws — naming
 * the variable and every problem — rather than returning a lenient default.
 */
export function resolvePurchaseTermsGate(
  env: NodeJS.ProcessEnv = process.env,
  set: PurchaseTermsDocumentSet = PURCHASE_TERMS_DOCUMENT_SET,
): PurchaseTermsGate {
  const raw = env[PURCHASE_TERMS_GATE_VAR]?.trim() ?? '';
  if (raw === '' || raw === 'off') {
    return { enabled: false };
  }
  if (raw !== 'on') {
    throw new Error(`${PURCHASE_TERMS_GATE_VAR} must be "on" or "off" (received "${raw}")`);
  }

  const problems = validatePurchaseTermsDocumentSet(set);
  if (set.legalReview.status !== 'APPROVED' && !isDraftPurchaseTermsPermitted(env)) {
    problems.push(
      'legalReview.status is not APPROVED: a draft may only be served on APP_ENVIRONMENT=local ' +
        'or in tests (RG-1)',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `${PURCHASE_TERMS_GATE_VAR} is "on" but the purchase-terms document set cannot be served: ` +
        problems.join('; '),
    );
  }

  const snapshot = buildPurchaseTermsSnapshot(set);
  return {
    enabled: true,
    terms: {
      documentKey: set.documentKey,
      version: set.version,
      legalReviewStatus: set.legalReview.status,
      documents: set.documents,
      snapshot,
      sha256: set.sha256,
    },
  };
}
