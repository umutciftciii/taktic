import { describe, expect, it } from 'vitest';
import {
  isDraftPurchaseTermsPermitted,
  resolvePurchaseTermsGate,
  validatePurchaseTermsDocumentSet,
} from '../src/modules/purchase-terms/purchase-terms.config';
import {
  PURCHASE_TERMS_DOCUMENT_SET,
  type PurchaseTermsDocumentSet,
} from '../src/modules/purchase-terms/purchase-terms.documents';
import {
  buildPurchaseTermsSnapshot,
  sha256Hex,
} from '../src/modules/purchase-terms/purchase-terms.snapshot';

/**
 * CMP-006 PR-A — the purchase-terms release gate, without a database.
 *
 * The gate is closed by default everywhere, opens only on request, and opens
 * only onto a whole document set: three full texts, a version, a digest that
 * matches, and — anywhere but a local stack or a test worker — a legal review
 * that says APPROVED (RG-1). Every other combination refuses loudly.
 */

const LOCAL = { APP_ENVIRONMENT: 'local' } as NodeJS.ProcessEnv;
const STAGING = { APP_ENVIRONMENT: 'staging' } as NodeJS.ProcessEnv;
const PRODUCTION = { APP_ENVIRONMENT: 'production', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const UNDECLARED = {} as NodeJS.ProcessEnv;

function withDigest(set: PurchaseTermsDocumentSet): PurchaseTermsDocumentSet {
  return { ...set, sha256: sha256Hex(buildPurchaseTermsSnapshot(set)) };
}

function approved(set: PurchaseTermsDocumentSet = PURCHASE_TERMS_DOCUMENT_SET) {
  return withDigest({
    ...set,
    version: '2026-10-01.onayli-1',
    legalReview: { status: 'APPROVED', approvedAt: '2026-10-01', reference: 'Hukuk görüşü #1' },
  });
}

describe('the shipped document set', () => {
  it('is whole: its declared digest is the digest of its combined snapshot', () => {
    expect(validatePurchaseTermsDocumentSet(PURCHASE_TERMS_DOCUMENT_SET)).toEqual([]);
    expect(sha256Hex(buildPurchaseTermsSnapshot(PURCHASE_TERMS_DOCUMENT_SET))).toBe(
      PURCHASE_TERMS_DOCUMENT_SET.sha256,
    );
  });

  it('is a draft awaiting legal review, and labels every document as one (RG-1)', () => {
    expect(PURCHASE_TERMS_DOCUMENT_SET.legalReview.status).toBe('PENDING');
    for (const document of PURCHASE_TERMS_DOCUMENT_SET.documents) {
      expect(document.text).toContain('TASLAK — HUKUK ONAYI BEKLİYOR');
      expect(document.text).toContain('onaylanmış bir sözleşme değildir');
    }
  });

  it('carries the three documents as full text, in the snapshot layout the database checks', () => {
    const snapshot = buildPurchaseTermsSnapshot(PURCHASE_TERMS_DOCUMENT_SET);
    expect(
      snapshot.startsWith(
        `TAKTIC PACKAGE_PURCHASE_TERMS\nversion: ${PURCHASE_TERMS_DOCUMENT_SET.version}\n`,
      ),
    ).toBe(true);
    const markers = ['MESAFELI_SATIS_SOZLESMESI', 'ON_BILGILENDIRME_FORMU', 'PAKET_IADE_POLITIKASI'].map(
      (key) => snapshot.indexOf(`\n=== ${key}: `),
    );
    expect(markers.every((index) => index > 0)).toBe(true);
    expect([...markers].sort((a, b) => a - b)).toEqual(markers);
    for (const document of PURCHASE_TERMS_DOCUMENT_SET.documents) {
      expect(snapshot).toContain(document.text);
    }
  });

  it('states the package refund rules the eligibility evaluation enforces', () => {
    const policy = PURCHASE_TERMS_DOCUMENT_SET.documents.find(
      (document) => document.key === 'PAKET_IADE_POLITIKASI',
    )!;
    expect(policy.text).toContain('on dört (14) gün');
    expect(policy.text).toContain('herhangi bir teklif kredisi kullanılmışsa iade yapılmaz');
    expect(policy.text).toContain('tek bir kredinin dahi kullanılmış olması');
  });
});

describe('PURCHASE_TERMS_GATE', () => {
  it.each([
    ['unset', {}],
    ['empty', { PURCHASE_TERMS_GATE: '' }],
    ['off', { PURCHASE_TERMS_GATE: 'off' }],
  ])('is closed when %s, on every environment', (_label, gate) => {
    for (const env of [LOCAL, STAGING, PRODUCTION, UNDECLARED]) {
      expect(resolvePurchaseTermsGate({ ...env, ...gate })).toEqual({ enabled: false });
    }
  });

  it('refuses a value that is neither on nor off', () => {
    expect(() => resolvePurchaseTermsGate({ ...LOCAL, PURCHASE_TERMS_GATE: 'true' })).toThrow(
      /PURCHASE_TERMS_GATE must be "on" or "off"/,
    );
  });

  it('opens onto the draft only on a local stack or in a test worker', () => {
    const gate = resolvePurchaseTermsGate({ ...LOCAL, PURCHASE_TERMS_GATE: 'on' });
    expect(gate.enabled).toBe(true);
    if (gate.enabled) {
      expect(gate.terms.legalReviewStatus).toBe('PENDING');
      expect(gate.terms.sha256).toBe(sha256Hex(gate.terms.snapshot));
    }
    expect(resolvePurchaseTermsGate({ NODE_ENV: 'test', PURCHASE_TERMS_GATE: 'on' }).enabled).toBe(true);
    expect(isDraftPurchaseTermsPermitted(STAGING)).toBe(false);
    expect(isDraftPurchaseTermsPermitted(PRODUCTION)).toBe(false);
    expect(isDraftPurchaseTermsPermitted(UNDECLARED)).toBe(false);
  });

  it.each([
    ['staging', STAGING],
    ['production', PRODUCTION],
    ['an undeclared environment', UNDECLARED],
  ])('refuses to open onto an unapproved text on %s (RG-1)', (_label, env) => {
    expect(() => resolvePurchaseTermsGate({ ...env, PURCHASE_TERMS_GATE: 'on' })).toThrow(
      /legalReview\.status is not APPROVED/,
    );
  });

  it('opens on production only with an approved, whole set', () => {
    const gate = resolvePurchaseTermsGate({ ...PRODUCTION, PURCHASE_TERMS_GATE: 'on' }, approved());
    expect(gate.enabled && gate.terms.legalReviewStatus).toBe('APPROVED');
  });
});

describe('a corrupt or incomplete document set keeps the gate shut (fail-closed)', () => {
  const open = (set: PurchaseTermsDocumentSet) => () =>
    resolvePurchaseTermsGate({ ...PRODUCTION, PURCHASE_TERMS_GATE: 'on' }, set);

  it('an edited text with a stale digest', () => {
    const base = approved();
    const tampered: PurchaseTermsDocumentSet = {
      ...base,
      documents: base.documents.map((document, index) =>
        index === 2 ? { ...document, text: `${document.text}\nEk madde.` } : document,
      ),
    };
    expect(open(tampered)).toThrow(/sha256 does not match/);
  });

  it('a digest that is not a SHA-256', () => {
    expect(open({ ...approved(), sha256: 'abc' })).toThrow(/64 lower-case hex/);
  });

  it('a missing document', () => {
    const base = approved();
    expect(open(withDigest({ ...base, documents: base.documents.slice(0, 2) }))).toThrow(
      /documents must be exactly/,
    );
  });

  it('documents in the wrong order', () => {
    const base = approved();
    const [a, b, ...rest] = base.documents;
    expect(open(withDigest({ ...base, documents: [b!, a!, ...rest] }))).toThrow(/in that order/);
  });

  it('a document that is only a link', () => {
    const base = approved();
    const linkOnly = withDigest({
      ...base,
      documents: base.documents.map((document, index) =>
        index === 0 ? { ...document, text: 'Metin için: https://taktic.example/sozlesmeler/mesafeli-satis' } : document,
      ),
    });
    expect(open(linkOnly)).toThrow(/MESAFELI_SATIS_SOZLESMESI: text must be the full document/);
  });

  it('a text that smuggles in a section marker', () => {
    const base = approved();
    const smuggled = withDigest({
      ...base,
      documents: base.documents.map((document, index) =>
        index === 1 ? { ...document, text: `${document.text}\n=== SAHTE: Bölüm ===\nx` } : document,
      ),
    });
    expect(open(smuggled)).toThrow(/must not contain a section marker/);
  });

  it('an empty or malformed version', () => {
    expect(open(withDigest({ ...approved(), version: '' }))).toThrow(/version must be/);
    expect(open(withDigest({ ...approved(), version: 'sürüm 1' }))).toThrow(/version must be/);
  });

  it('an approval without a date or a reference', () => {
    expect(
      open(
        withDigest({
          ...approved(),
          legalReview: { status: 'APPROVED', approvedAt: 'dün', reference: ' ' },
        }),
      ),
    ).toThrow(/approvedAt must be an ISO date.*reference must name the approval/);
  });
});
