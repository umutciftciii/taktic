import { parseAppEnvironment } from '../../common/app-environment';
import {
  PURCHASE_TERMS_DOCUMENT_KEYS,
  PURCHASE_TERMS_DOCUMENT_SET,
  PURCHASE_TERMS_DOCUMENT_SET_KEY,
  type PurchaseTermsDocument,
  type PurchaseTermsDocumentSet,
} from './purchase-terms.documents';
import { buildPurchaseTermsSnapshot, sha256Hex } from './purchase-terms.snapshot';
import {
  PURCHASE_TERMS_TEST_DOCUMENT_SET,
  PURCHASE_TERMS_TEST_NOTICE,
} from './purchase-terms.test-documents';

/**
 * The purchase-terms release gate (CMP-006 PR-A, `test` mode PR-B.1).
 *
 * ## Default: closed, everywhere
 *
 * `PURCHASE_TERMS_GATE` unset, empty or `off` means the checkout behaves
 * exactly as it did before this module existed: no terms are served, none are
 * asked for, none are written. That is the answer on every environment —
 * local, staging and production alike — until somebody opens the gate on
 * purpose.
 *
 * ## Opening it for real: `PURCHASE_TERMS_GATE=on`
 *
 * Serves the PRODUCTION document set. Accepted only with a set that is whole,
 * and refused loudly otherwise — the process does not boot (see
 * PurchaseTermsService.onModuleInit). "Whole" means:
 *
 *   - the set key, a version the database CHECK also accepts, and the three
 *     documents in their fixed order, each with a title and a real text (at
 *     least 200 characters once links are removed — a list of links is not a
 *     text);
 *   - a declared SHA-256 that equals the digest of the combined snapshot
 *     recomputed here, so an edited text with a stale digest is a corrupt set;
 *   - purpose `PRODUCTION`, and no test notice in any document;
 *   - on staging, production or an undeclared environment: a legal review of
 *     `APPROVED` with a date and a reference (RG-1). A draft may be exercised
 *     only on a declared local stack or in a unit-test worker, where the web
 *     app labels it TASLAK.
 *
 * ## Opening it for testing: `PURCHASE_TERMS_GATE=test`
 *
 * Serves the TEST document set (purchase-terms.test-documents.ts) — a text
 * that says in every document that it is not a contract — so the checkout
 * consent and the package refund flow can be exercised end to end on a local
 * stack, in the test suite and on staging, where `on` stays refused until
 * RG-1. The evidence written is the real one (snapshot, digest, time, address,
 * user agent, channel); only the text and its `test-…` version differ.
 *
 * `test` is refused — the process does not boot — anywhere production could
 * be: `APP_ENVIRONMENT=production`, `NODE_ENV=production`, or an undeclared
 * environment outside a unit-test worker. It never falls back to `on`.
 *
 * There is no lenient fallback: a set that fails any rule never reaches a
 * checkout, which is what fail-closed means here.
 *
 * Nothing here reads a request.
 */
export const PURCHASE_TERMS_GATE_VAR = 'PURCHASE_TERMS_GATE';

/** Which of the two open values served these terms. */
export type PurchaseTermsGateMode = 'on' | 'test';

export type ValidatedPurchaseTerms = {
  mode: PurchaseTermsGateMode;
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

  // A TEST set says so in every document, and a PRODUCTION set never does:
  // the two can then never be mistaken for each other on a screen or on an
  // acceptance row.
  if (set.purpose === 'TEST') {
    for (const document of set.documents) {
      if (typeof document.text !== 'string' || !document.text.startsWith(PURCHASE_TERMS_TEST_NOTICE)) {
        problems.push(`${document.key}: a TEST document must start with the test notice`);
      }
    }
  } else if (set.purpose === 'PRODUCTION') {
    if (set.documents.some((document) => document.text?.includes(PURCHASE_TERMS_TEST_NOTICE))) {
      problems.push('a PRODUCTION document set must not carry the test notice');
    }
  } else {
    problems.push('purpose must be PRODUCTION or TEST');
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
 * Whether `PURCHASE_TERMS_GATE=test` may be served: on a declared local or
 * staging stack, or in a unit-test worker that declared nothing — and never
 * under `NODE_ENV=production` or `APP_ENVIRONMENT=production`, whatever else
 * is set. An undeclared environment outside tests is unknown, and unknown is
 * closed.
 */
export function isTestPurchaseTermsPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') {
    return false;
  }
  const environment = parseAppEnvironment(env.APP_ENVIRONMENT);
  if (environment === 'production') {
    return false;
  }
  if (environment === 'local' || environment === 'staging') {
    return true;
  }
  return env.NODE_ENV === 'test';
}

/**
 * The whole contract, evaluated from the given environment. Throws — naming
 * the variable and every problem — rather than returning a lenient default.
 */
export function resolvePurchaseTermsGate(
  env: NodeJS.ProcessEnv = process.env,
  set: PurchaseTermsDocumentSet = PURCHASE_TERMS_DOCUMENT_SET,
  testSet: PurchaseTermsDocumentSet = PURCHASE_TERMS_TEST_DOCUMENT_SET,
): PurchaseTermsGate {
  const raw = env[PURCHASE_TERMS_GATE_VAR]?.trim() ?? '';
  if (raw === '' || raw === 'off') {
    return { enabled: false };
  }
  if (raw === 'on') {
    return open('on', set, onProblems(env, set));
  }
  if (raw === 'test') {
    return open('test', testSet, testProblems(env, testSet));
  }
  throw new Error(`${PURCHASE_TERMS_GATE_VAR} must be "on", "test" or "off" (received "${raw}")`);
}

function onProblems(env: NodeJS.ProcessEnv, set: PurchaseTermsDocumentSet): string[] {
  const problems = validatePurchaseTermsDocumentSet(set);
  if (set.purpose !== 'PRODUCTION') {
    problems.push('"on" serves only a PRODUCTION document set; a TEST set needs "test"');
  }
  if (set.legalReview.status !== 'APPROVED' && !isDraftPurchaseTermsPermitted(env)) {
    problems.push(
      'legalReview.status is not APPROVED: a draft may only be served on APP_ENVIRONMENT=local ' +
        'or in tests (RG-1)',
    );
  }
  return problems;
}

function testProblems(env: NodeJS.ProcessEnv, set: PurchaseTermsDocumentSet): string[] {
  if (!isTestPurchaseTermsPermitted(env)) {
    return [
      'the test document set may only be served on APP_ENVIRONMENT=local or staging, or in tests — ' +
        'never on production or an undeclared environment',
    ];
  }
  const problems = validatePurchaseTermsDocumentSet(set);
  if (set.purpose !== 'TEST') {
    problems.push('"test" serves only a TEST document set');
  }
  if (set.legalReview.status === 'APPROVED') {
    problems.push('a TEST document set is never legally approved');
  }
  return problems;
}

function open(
  mode: PurchaseTermsGateMode,
  set: PurchaseTermsDocumentSet,
  problems: string[],
): PurchaseTermsGate {
  if (problems.length > 0) {
    throw new Error(
      `${PURCHASE_TERMS_GATE_VAR} is "${mode}" but the purchase-terms document set cannot be served: ` +
        problems.join('; '),
    );
  }

  const snapshot = buildPurchaseTermsSnapshot(set);
  return {
    enabled: true,
    terms: {
      mode,
      documentKey: set.documentKey,
      version: set.version,
      legalReviewStatus: set.legalReview.status,
      documents: set.documents,
      snapshot,
      sha256: set.sha256,
    },
  };
}
