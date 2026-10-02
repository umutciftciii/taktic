import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMATION_PROOF_FIELD,
  CONFIRMATION_PROOF_KEYS,
  CONFIRMATION_PROOF_REFUSAL_MESSAGE,
  CONFIRMATION_PROOF_TTL_MS,
  mintProof,
  verifyAndSpendProof,
  type ProofLedger,
} from '../lib/confirmation-proof';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — the confirmation proof.
 *
 * A `ConfirmDialog` trigger is a submit button. Clicked before hydration,
 * React 19 queues the submission and replays it after; with JavaScript off the
 * form posts as it is. Either way the dialog never opened. What stops that
 * reaching a write is this: the guarded actions demand a single-use,
 * session-bound proof the server mints only when "Evet" is pressed.
 *
 * Pinned here:
 * - the proof itself: what verifies, what does not, and that it verifies once;
 * - the guarded server actions, called the way a queued or JavaScript-less
 *   submission calls them — no proof, a made-up proof, a proof for another
 *   action, a replayed proof — and that each writes nothing (no API call);
 *   and with a real proof, that each does exactly what it did before;
 * - the coverage: every `ConfirmDialog` names a key, and every key is checked
 *   by the action its form posts to.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

/** Every file under `dir` (relative to the app root). */
function walk(dir: string): string[] {
  const root = resolve(__dirname, '..');
  return readdirSync(resolve(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(resolve(root, path)).isDirectory() ? walk(path) : [path];
  });
}

// ─────────────────────────── the proof itself ───────────────────────────

describe('a confirmation proof', () => {
  const secret = randomBytes(32);
  const session = 'session-cookie-value';
  const now = 1_000_000;

  function verify(token: unknown, overrides: Partial<Parameters<typeof verifyAndSpendProof>[0]> = {}) {
    return verifyAndSpendProof({
      token,
      key: 'credits.grant',
      sessionValue: session,
      secret,
      now,
      ledger: new Map(),
      ...overrides,
    });
  }

  it('verifies for the key, session and moment it was minted for', () => {
    const token = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    expect(verify(token)).toEqual({ ok: true });
  });

  it('is refused when it is missing, empty or not a proof at all', () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(verify(null)).toEqual({ ok: false, reason: 'missing' });
    expect(verify('')).toEqual({ ok: false, reason: 'missing' });
    expect(verify('yes')).toEqual({ ok: false, reason: 'malformed' });
    expect(verify('on')).toEqual({ ok: false, reason: 'malformed' });
    expect(verify('a.b.c')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is refused when somebody writes its payload by hand (no secret, no signature)', () => {
    const payload = Buffer.from(JSON.stringify({ k: 'credits.grant', s: 'x', n: 'n', e: now + 1000 })).toString(
      'base64url',
    );
    expect(verify(`${payload}.forged`)).toEqual({ ok: false, reason: 'signature' });
    const otherSecret = mintProof({ key: 'credits.grant', sessionValue: session, secret: randomBytes(32), now });
    expect(verify(otherSecret)).toEqual({ ok: false, reason: 'signature' });
  });

  it('is refused for another action, another session, or after its two minutes', () => {
    const token = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    expect(verify(token, { key: 'credits.deduct' })).toEqual({ ok: false, reason: 'scope' });
    expect(verify(token, { sessionValue: 'another-session' })).toEqual({ ok: false, reason: 'session' });
    expect(verify(token, { sessionValue: null })).toEqual({ ok: false, reason: 'session' });
    expect(verify(token, { now: now + CONFIRMATION_PROOF_TTL_MS })).toEqual({ ok: false, reason: 'expired' });
    expect(verify(token, { now: now + CONFIRMATION_PROOF_TTL_MS - 1 })).toEqual({ ok: true });
  });

  it('verifies once: a replay of the same proof is refused', () => {
    const ledger: ProofLedger = new Map();
    const token = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    expect(verify(token, { ledger })).toEqual({ ok: true });
    expect(verify(token, { ledger })).toEqual({ ok: false, reason: 'replayed' });
    expect(verify(token, { ledger, now: now + 1000 })).toEqual({ ok: false, reason: 'replayed' });
  });

  it('a refused attempt does not spend a good proof', () => {
    const ledger: ProofLedger = new Map();
    const token = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    expect(verify(token, { ledger, key: 'credits.deduct' }).ok).toBe(false);
    expect(verify(token, { ledger, sessionValue: 'other' }).ok).toBe(false);
    expect(ledger.size).toBe(0);
    expect(verify(token, { ledger })).toEqual({ ok: true });
  });

  it('forgets spent nonces once they would have expired anyway', () => {
    const ledger: ProofLedger = new Map();
    const first = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    verify(first, { ledger });
    expect(ledger.size).toBe(1);
    const later = now + CONFIRMATION_PROOF_TTL_MS + 1;
    const second = mintProof({ key: 'credits.grant', sessionValue: session, secret, now: later });
    expect(verify(second, { ledger, now: later })).toEqual({ ok: true });
    expect(ledger.size).toBe(1);
  });

  it('two proofs minted for the same confirmation are distinct (each press gets its own)', () => {
    const a = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    const b = mintProof({ key: 'credits.grant', sessionValue: session, secret, now });
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────── the guarded actions ───────────────────────────

let cookieValue: string | null = 'staff-session';
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'taktic_session' && cookieValue ? { name, value: cookieValue } : undefined),
    toString: () => '',
  }),
}));

class Redirect extends Error {
  readonly digest: string;
  constructor(readonly url: string) {
    super('NEXT_REDIRECT');
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const apiFetch = vi.fn();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  readConflict: () => null,
  readAdminAccess: async () => null,
}));

const { issueConfirmationProof } = await import('../lib/confirmation-proof-server');
const { mintConfirmationProof } = await import('../lib/confirmation-proof-actions');

/** What a queued/JavaScript-less submission looks like, and what a confirmed one adds. */
function form(fields: Record<string, string>, proof?: string | null): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  if (proof) data.set(CONFIRMATION_PROOF_FIELD, proof);
  return data;
}

/** Runs an action and answers where it went, or the value it returned. */
async function outcome(run: () => Promise<unknown>): Promise<{ redirect?: string; value?: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    if (error instanceof Redirect) return { redirect: error.url };
    throw error;
  }
}

/** The non-GET API calls an action made: the writes. */
function writes() {
  return apiFetch.mock.calls.filter(([, init]) => init && (init as { method?: string }).method && (init as { method: string }).method !== 'GET');
}

/** A one-time credit package as the form posts it, unchanged from STORED_CREDIT_PACKAGE. */
const CREDIT_PACKAGE_FIELDS = {
  name: 'Başlangıç',
  slug: 'baslangic',
  type: 'ONE_TIME_CREDITS',
  creditAmount: '50',
  priceAmount: '149,90',
  currency: 'TRY',
  sortOrder: '1',
  isActive: 'true',
};
const STORED_CREDIT_PACKAGE = {
  id: 'cp-1',
  name: 'Başlangıç',
  slug: 'baslangic',
  type: 'ONE_TIME_CREDITS',
  creditAmount: 50,
  quotaCredits: null,
  dailyOfferLimit: null,
  priceAmount: 14990,
  currency: 'TRY',
  sortOrder: 1,
  isActive: true,
  scopeCategories: [],
};

/** A vitrin package as the edit form posts it, unchanged from STORED_SHOWCASE_PACKAGE. */
const SHOWCASE_PACKAGE_FIELDS = {
  name: 'Vitrin 30',
  priceAmount: '499,90',
  durationDays: '30',
  activationWindowDays: '90',
  allowedCardKind: '',
  maxAreas: '',
  description: 'Açıklama',
  isActive: 'on',
  sortOrder: '0',
};
const STORED_SHOWCASE_PACKAGE = {
  id: 'sp-1',
  name: 'Vitrin 30',
  slug: 'vitrin-30',
  priceAmount: 49990,
  currency: 'TRY',
  durationDays: 30,
  activationWindowDays: 90,
  allowedCardKind: null,
  maxAreas: null,
  description: 'Açıklama',
  isActive: true,
  sortOrder: 0,
};

/** A live service as the category form posts it, unchanged from STORED_CATEGORY. */
const CATEGORY_FIELDS = {
  id: 'cat-1',
  name: 'Klima',
  slug: 'klima',
  kind: 'LEAF',
  status: 'ACTIVE',
  parentId: '',
  sortOrder: '0',
  offerCreditCost: '3',
  description: '',
};
const STORED_CATEGORY = {
  id: 'cat-1',
  name: 'Klima',
  slug: 'klima',
  kind: 'LEAF',
  status: 'ACTIVE',
  parentId: null,
  offerCreditCost: 3,
  unlimitedPackageEligible: false,
  providerEnrollmentOpen: false,
  sortOrder: 0,
};

const COMPANY_SETTINGS_FIELDS = {
  legalName: 'Örnek Teknoloji A.Ş.',
  supportEmail: 'destek@ornek.com.tr',
  postalAddress: '',
};
const STORED_COMPANY_SETTINGS = {
  legalName: 'Örnek Teknoloji A.Ş.',
  supportEmail: 'destek@ornek.com.tr',
  postalAddress: null,
};

type Case = {
  name: string;
  key: (typeof CONFIRMATION_PROOF_KEYS)[number];
  run: (proof: string | null) => Promise<unknown>;
  refused: (result: { redirect?: string; value?: unknown }) => void;
  /** What the API answers a read the action makes before deciding (GET), if any. */
  read?: unknown;
  /** What the API answers the write, when the action reads its answer. */
  write?: unknown;
};

const refusedRedirect = (fragment: string) => (result: { redirect?: string }) => {
  expect(result.redirect).toContain(fragment);
};
const refusedState = (result: { value?: unknown }) => {
  expect(JSON.stringify(result.value)).toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
};

const CASES: Case[] = [
  {
    name: 'credits: Kredi ekle',
    key: 'credits.grant',
    run: async (proof) => {
      const { submitCreditOperationAction } = await import('../app/providers/[id]/credits/actions');
      return submitCreditOperationAction(
        { kind: 'idle' } as never,
        form({ providerId: 'p-1', operationType: 'GRANT', amount: '10', reason: 'Telafi kaydı' }, proof),
      );
    },
    refused: refusedState,
  },
  {
    name: 'credits: Kredi düş',
    key: 'credits.deduct',
    run: async (proof) => {
      const { submitCreditOperationAction } = await import('../app/providers/[id]/credits/actions');
      return submitCreditOperationAction(
        { kind: 'idle' } as never,
        form({ providerId: 'p-1', operationType: 'DEDUCT', amount: '10', reason: 'Düzeltme kaydı' }, proof),
      );
    },
    refused: refusedState,
  },
  {
    name: 'users: Hesabı aktifleştir',
    key: 'user.status',
    run: async (proof) => {
      const { updateUserStatusAction } = await import('../app/users/actions');
      return updateUserStatusAction(form({ userId: 'u-1', isActive: 'true' }, proof));
    },
    refused: refusedRedirect('/users/u-1?statusError='),
  },
  {
    name: 'roles: Rol ata',
    key: 'role.assign',
    run: async (proof) => {
      const { assignAdminRoleAction } = await import('../app/roles/actions');
      return assignAdminRoleAction(form({ userId: 'u-1', roleId: 'r-1' }, proof));
    },
    refused: refusedRedirect('/users/u-1?error='),
  },
  {
    name: 'roles: Rolü aktifleştir',
    key: 'role.status',
    run: async (proof) => {
      const { setAdminRoleActiveAction } = await import('../app/roles/actions');
      return setAdminRoleActiveAction(form({ roleId: 'r-1', isActive: 'true', confirm: 'on' }, proof));
    },
    refused: refusedRedirect('/roles/r-1?error='),
  },
  {
    name: 'roles: İzinleri kaydet',
    key: 'role.permissions',
    run: async (proof) => {
      const { replaceAdminRolePermissionsAction } = await import('../app/roles/actions');
      return replaceAdminRolePermissionsAction(form({ roleId: 'r-1', permissions: 'SUPPORT_READ' }, proof));
    },
    refused: refusedRedirect('/roles/r-1?error='),
  },
  {
    name: 'showcase: ilk sürüm onayı',
    key: 'showcase.approve-first',
    read: { card: { liveVersion: null } },
    run: async (proof) => {
      const { approveShowcaseVersionAction } = await import('../app/showcase/reviews/[versionId]/actions');
      return approveShowcaseVersionAction(form({ versionId: 'v-1' }, proof));
    },
    refused: refusedRedirect('/showcase/reviews/v-1?error='),
  },
  {
    name: 'offers: müşteri adına kabul',
    key: 'offer.accept',
    run: async (proof) => {
      const { updateOfferStatusAction } = await import('../app/offers/actions');
      return updateOfferStatusAction(form({ id: 'o-1', status: 'ACCEPTED' }, proof));
    },
    refused: refusedRedirect('/offers/o-1?statusError=confirmationRequired'),
  },
  {
    name: 'offers: manuel kredi iadesi',
    key: 'offer.refund',
    run: async (proof) => {
      const { refundOfferCreditAction } = await import('../app/offers/actions');
      return refundOfferCreditAction(form({ id: 'o-1', reasonCode: 'INVALID_REQUEST' }, proof));
    },
    refused: refusedRedirect('refundError=confirmationRequired'),
  },
  {
    name: 'showcase: kalıcı yerleşim iptali',
    key: 'showcase.placement-cancel',
    run: async (proof) => {
      const { cancelShowcasePlacementAction } = await import('../app/showcase/placements/actions');
      return cancelShowcasePlacementAction(form({ placementId: 'pl-1', note: 'Müşteri şikâyeti üzerine' }, proof));
    },
    refused: refusedRedirect('/showcase/placements/pl-1?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'requests: talep iptali',
    key: 'request.cancel',
    run: async (proof) => {
      const { cancelRequestAction } = await import('../app/requests/actions');
      return cancelRequestAction(form({ id: 'rq-1', expectedMatchedOfferId: '' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?statusError=confirmationRequired'),
  },
  {
    name: 'requests: talep reddi',
    key: 'request.reject',
    run: async (proof) => {
      const { updateRequestStatusAction } = await import('../app/requests/actions');
      return updateRequestStatusAction(form({ id: 'rq-1', status: 'REJECTED', rejectionReason: 'Spam' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?statusError=confirmationRequired'),
  },
  {
    name: 'requests: şikayetle kaldırma',
    key: 'request.report-remove',
    run: async (proof) => {
      const { resolveReportsAction } = await import('../app/requests/actions');
      return resolveReportsAction(
        form({ id: 'rq-1', resolution: 'REQUEST_REMOVED', removalReason: 'FAKE_OR_TEST' }, proof),
      );
    },
    refused: refusedRedirect('reportError=confirmation'),
  },
  {
    name: 'refund scan: toplu iade',
    key: 'refund-scan.execute',
    run: async (proof) => {
      const { executeRefundScanAction } = await import('../app/refund-scan/actions');
      return executeRefundScanAction(50, proof);
    },
    refused: (result) => expect(result.value).toEqual({ ok: false, error: CONFIRMATION_PROOF_REFUSAL_MESSAGE }),
  },
  {
    name: 'operations: kampanya motoru',
    key: 'campaign-engine.toggle',
    run: async (proof) => {
      const { toggleCampaignEngineAction } = await import('../app/operations-settings/actions');
      // The old fixed `confirm=yes` is no longer proof of anything.
      return toggleCampaignEngineAction(form({ enabled: 'true', confirm: 'yes' }, proof));
    },
    refused: refusedRedirect('#kampanya-motoru'),
  },
  {
    name: 'package refunds: onay',
    key: 'package-refund.approve',
    run: async (proof) => {
      const { approvePackageRefundAction } = await import('../app/package-refunds/actions');
      return approvePackageRefundAction(form({ id: 'pr-1', kind: 'NORMAL' }, proof));
    },
    refused: refusedRedirect('/package-refunds/pr-1?error='),
  },
  {
    name: 'package refunds: ret',
    key: 'package-refund.reject',
    run: async (proof) => {
      const { rejectPackageRefundAction } = await import('../app/package-refunds/actions');
      return rejectPackageRefundAction(form({ id: 'pr-1', reason: 'Uygun değil gerekçesi' }, proof));
    },
    refused: refusedRedirect('/package-refunds/pr-1?error='),
  },
  {
    name: 'campaigns: sonlandır',
    key: 'campaign.end',
    run: async (proof) => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      return campaignLifecycleAction(
        { status: 'idle' } as never,
        form({ intent: 'end', campaignId: 'c-1', reason: 'Dönem bitti' }, proof),
      );
    },
    refused: refusedState,
  },
  // ── Faz 2: customer / provider / request lifecycle ──
  {
    name: 'customers: Hesabı etkinleştir',
    key: 'customer.activate',
    run: async (proof) => {
      const { updateCustomerStatusAction } = await import('../app/customers/actions');
      return updateCustomerStatusAction(form({ customerId: 'c-1', isActive: 'true' }, proof));
    },
    refused: refusedRedirect('/customers/c-1?statusError='),
  },
  {
    name: 'providers: Onayla (PENDING_REVIEW → APPROVED)',
    key: 'provider.approve',
    read: { status: 'PENDING_REVIEW' },
    run: async (proof) => {
      const { updateProviderStatusAction } = await import('../app/providers/actions');
      return updateProviderStatusAction(form({ id: 'p-1', status: 'APPROVED' }, proof));
    },
    refused: refusedRedirect('/providers/p-1?statusError=confirmation'),
  },
  {
    name: 'providers: Tekrar aktif et (SUSPENDED → APPROVED)',
    key: 'provider.approve',
    read: { status: 'SUSPENDED' },
    run: async (proof) => {
      const { updateProviderStatusAction } = await import('../app/providers/actions');
      return updateProviderStatusAction(form({ id: 'p-1', status: 'APPROVED' }, proof));
    },
    refused: refusedRedirect('/providers/p-1?statusError=confirmation'),
  },
  {
    name: 'providers: taslağa al (REJECTED → DRAFT)',
    key: 'provider.draft',
    read: { status: 'REJECTED' },
    run: async (proof) => {
      const { updateProviderStatusAction } = await import('../app/providers/actions');
      return updateProviderStatusAction(form({ id: 'p-1', status: 'DRAFT', rejectionReason: 'eski' }, proof));
    },
    refused: refusedRedirect('/providers/p-1?statusError=confirmation'),
  },
  {
    name: 'requests: Onayla (yayına al)',
    key: 'request.approve',
    run: async (proof) => {
      const { updateRequestStatusAction } = await import('../app/requests/actions');
      return updateRequestStatusAction(form({ id: 'rq-1', status: 'APPROVED' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?statusError=confirmationRequired'),
  },
  {
    name: 'requests: yayındaki talebi incelemeye al',
    key: 'request.unpublish',
    read: { status: 'APPROVED' },
    run: async (proof) => {
      const { updateRequestStatusAction } = await import('../app/requests/actions');
      return updateRequestStatusAction(form({ id: 'rq-1', status: 'IN_REVIEW' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?statusError=confirmationRequired'),
  },
  {
    name: 'requests: Hizmeti tamamlandı işaretle',
    key: 'request.complete',
    run: async (proof) => {
      const { completeRequestAction } = await import('../app/requests/actions');
      return completeRequestAction(form({ id: 'rq-1' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?statusError=confirmationRequired'),
  },
  {
    name: 'requests: Talebi geri aç',
    key: 'request.reopen',
    run: async (proof) => {
      const { reopenRequestAction } = await import('../app/requests/actions');
      return reopenRequestAction(form({ id: 'rq-1' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?tab=sikayet&reportError=confirmation'),
  },
  {
    name: 'requests: şikayet “Uygun bulundu”',
    key: 'request.report-dismiss',
    run: async (proof) => {
      const { resolveReportsAction } = await import('../app/requests/actions');
      return resolveReportsAction(form({ id: 'rq-1', resolution: 'DISMISSED', resolutionNote: 'Sorun yok' }, proof));
    },
    refused: refusedRedirect('/requests/rq-1?tab=sikayet&reportError=confirmation'),
  },
  // ── Paket A: campaign lifecycle ──
  {
    name: 'campaigns: duraklat',
    key: 'campaign.pause',
    run: async (proof) => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      return campaignLifecycleAction({ status: 'idle' } as never, form({ intent: 'pause', campaignId: 'c-1', reason: 'Bütçe kontrolü' }, proof));
    },
    refused: refusedState,
  },
  {
    name: 'campaigns: devam ettir',
    key: 'campaign.resume',
    run: async (proof) => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      return campaignLifecycleAction({ status: 'idle' } as never, form({ intent: 'resume', campaignId: 'c-1', reason: 'Kontrol bitti' }, proof));
    },
    refused: refusedState,
  },
  {
    name: 'campaigns: sürümü etkinleştir (DRAFT)',
    key: 'campaign.version-activate',
    read: { campaign: { status: 'DRAFT' } },
    run: async (proof) => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      return campaignLifecycleAction({ status: 'idle' } as never, form({ intent: 'activate', campaignId: 'c-1', versionNumber: '1' }, proof));
    },
    refused: refusedState,
  },
  {
    name: 'campaigns: başka sürüme geç (ACTIVE)',
    key: 'campaign.version-switch',
    read: { campaign: { status: 'ACTIVE' } },
    run: async (proof) => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      return campaignLifecycleAction({ status: 'idle' } as never, form({ intent: 'activate', campaignId: 'c-1', versionNumber: '2' }, proof));
    },
    refused: refusedState,
  },
  {
    name: 'campaigns: yeni sürümle devam ettir (PAUSED)',
    key: 'campaign.version-resume',
    read: { campaign: { status: 'PAUSED' } },
    run: async (proof) => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      return campaignLifecycleAction(
        { status: 'idle' } as never,
        form({ intent: 'activate', campaignId: 'c-1', versionNumber: '2', reason: 'Yeni kural ile' }, proof),
      );
    },
    refused: refusedState,
  },
  // ── Paket A: operations settings ──
  {
    name: 'operations: otomatik yayını aç',
    key: 'operations.auto-publish-enable',
    run: async (proof) => {
      const { toggleAutoPublishAction } = await import('../app/operations-settings/actions');
      return toggleAutoPublishAction(form({ enabled: 'true' }, proof));
    },
    refused: refusedRedirect('#otomatik-yayin'),
  },
  {
    name: 'operations: değerlendirmeleri aç',
    key: 'operations.reviews-enable',
    run: async (proof) => {
      const { toggleProviderReviewsAction } = await import('../app/operations-settings/actions');
      return toggleProviderReviewsAction(form({ enabled: 'true' }, proof));
    },
    refused: refusedRedirect('#degerlendirmeler'),
  },
  {
    name: 'operations: değerlendirmeleri kapat',
    key: 'operations.reviews-disable',
    run: async (proof) => {
      const { toggleProviderReviewsAction } = await import('../app/operations-settings/actions');
      return toggleProviderReviewsAction(form({ enabled: 'false' }, proof));
    },
    refused: refusedRedirect('#degerlendirmeler'),
  },
  {
    name: 'operations: paket yenilemeyi kapat',
    key: 'scheduler.disable',
    run: async (proof) => {
      const { toggleSchedulerAction } = await import('../app/operations-settings/actions');
      return toggleSchedulerAction(form({ job: 'entitlement-renewal', enabled: 'false' }, proof));
    },
    refused: refusedRedirect('#zamanlanmis-isler'),
  },
  {
    name: 'operations: görüntülenmeyen teklif iadesini kapat',
    key: 'scheduler.disable',
    run: async (proof) => {
      const { toggleSchedulerAction } = await import('../app/operations-settings/actions');
      return toggleSchedulerAction(form({ job: 'unviewed-offer-refund', enabled: 'false' }, proof));
    },
    refused: refusedRedirect('#zamanlanmis-isler'),
  },
  // ── Paket A: credit packages ──
  {
    name: 'credit packages: aktif oluştur',
    key: 'credit-package.create-active',
    run: async (proof) => {
      const { createCreditPackageAction } = await import('../app/credit-packages/actions');
      return createCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, isActive: 'true' }, proof));
    },
    refused: refusedRedirect('/credit-packages/new?error='),
  },
  {
    name: 'credit packages: aktifleştir (liste/detay)',
    key: 'credit-package.activate',
    run: async (proof) => {
      const { updateCreditPackageStatusAction } = await import('../app/credit-packages/actions');
      return updateCreditPackageStatusAction(form({ id: 'cp-1', isActive: 'true', redirectTo: '/credit-packages' }, proof));
    },
    refused: refusedRedirect('/credit-packages?error='),
  },
  {
    name: 'credit packages: pasifleştir (liste/detay)',
    key: 'credit-package.deactivate',
    run: async (proof) => {
      const { updateCreditPackageStatusAction } = await import('../app/credit-packages/actions');
      return updateCreditPackageStatusAction(form({ id: 'cp-1', isActive: 'false', redirectTo: '/credit-packages/cp-1' }, proof));
    },
    refused: refusedRedirect('/credit-packages/cp-1?error='),
  },
  {
    name: 'credit packages: fiyat değişikliği',
    key: 'credit-package.update-commercial',
    read: STORED_CREDIT_PACKAGE,
    run: async (proof) => {
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      return updateCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, id: 'cp-1', priceAmount: '199,90' }, proof));
    },
    refused: refusedRedirect('/credit-packages/cp-1?error='),
  },
  {
    name: 'credit packages: formdaki durum seçimiyle pasifleştirme',
    key: 'credit-package.deactivate',
    read: STORED_CREDIT_PACKAGE,
    run: async (proof) => {
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      return updateCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, id: 'cp-1', isActive: 'false' }, proof));
    },
    refused: refusedRedirect('/credit-packages/cp-1?error='),
  },
  // ── Paket A: vitrin packages ──
  {
    name: 'showcase packages: oluştur (hemen satışta)',
    key: 'showcase-package.create-active',
    run: async (proof) => {
      const { createShowcasePackageAction } = await import('../app/showcase/packages/actions');
      return createShowcasePackageAction(form({ ...SHOWCASE_PACKAGE_FIELDS, slug: 'vitrin-yeni-30' }, proof));
    },
    refused: refusedRedirect('error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'showcase packages: bedel değişikliği',
    key: 'showcase-package.update-commercial',
    read: STORED_SHOWCASE_PACKAGE,
    run: async (proof) => {
      const { updateShowcasePackageAction } = await import('../app/showcase/packages/actions');
      return updateShowcasePackageAction(form({ ...SHOWCASE_PACKAGE_FIELDS, packageId: 'sp-1', priceAmount: '600' }, proof));
    },
    refused: refusedRedirect('/showcase/packages/sp-1?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'showcase packages: satıştan kaldır',
    key: 'showcase-package.deactivate',
    run: async (proof) => {
      const { updateShowcasePackageStatusAction } = await import('../app/showcase/packages/actions');
      return updateShowcasePackageStatusAction(form({ packageId: 'sp-1', isActive: 'false' }, proof));
    },
    refused: refusedRedirect('/showcase/packages/sp-1?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'showcase packages: satışa aç',
    key: 'showcase-package.activate',
    run: async (proof) => {
      const { updateShowcasePackageStatusAction } = await import('../app/showcase/packages/actions');
      return updateShowcasePackageStatusAction(form({ packageId: 'sp-1', isActive: 'true' }, proof));
    },
    refused: refusedRedirect('/showcase/packages/sp-1?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'showcase packages: formdaki durumla satıştan kaldırma',
    key: 'showcase-package.deactivate',
    read: STORED_SHOWCASE_PACKAGE,
    run: async (proof) => {
      const { updateShowcasePackageAction } = await import('../app/showcase/packages/actions');
      return updateShowcasePackageAction(form({ ...SHOWCASE_PACKAGE_FIELDS, packageId: 'sp-1', isActive: 'off' }, proof));
    },
    refused: refusedRedirect('/showcase/packages/sp-1?error=CONFIRMATION_REQUIRED'),
  },
  // ── Paket B: vitrin, category, terminal R2, settings ──
  {
    name: 'showcase: revizyon onayı',
    key: 'showcase.revision-approve',
    read: { card: { liveVersion: { id: 'live' } } },
    run: async (proof) => {
      const { approveShowcaseVersionAction } = await import('../app/showcase/reviews/[versionId]/actions');
      return approveShowcaseVersionAction(form({ versionId: 'v-2' }, proof));
    },
    refused: refusedRedirect('/showcase/reviews/v-2?error='),
  },
  {
    name: 'showcase: yerleşimi durdur',
    key: 'showcase.placement-suspend',
    run: async (proof) => {
      const { suspendShowcasePlacementAction } = await import('../app/showcase/placements/actions');
      return suspendShowcasePlacementAction(form({ placementId: 'pl-1', note: 'Şikâyet incelemesi için' }, proof));
    },
    refused: refusedRedirect('/showcase/placements/pl-1?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: yayında oluştur',
    key: 'category.create-published',
    run: async (proof) => {
      const { createCategoryAction } = await import('../app/categories/actions');
      return createCategoryAction(form({ ...CATEGORY_FIELDS, status: 'ACTIVE' }, proof));
    },
    refused: refusedRedirect('/categories/new?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: kısa ad değişimi',
    key: 'category.structure-update',
    read: [STORED_CATEGORY],
    run: async (proof) => {
      const { updateCategoryAction } = await import('../app/categories/actions');
      return updateCategoryAction(form({ ...CATEGORY_FIELDS, slug: 'klima-servisi' }, proof));
    },
    refused: refusedRedirect('/categories/klima?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: teklif kredisi değişimi',
    key: 'category.offer-credit-update',
    read: [STORED_CATEGORY],
    run: async (proof) => {
      const { updateCategoryAction } = await import('../app/categories/actions');
      return updateCategoryAction(form({ ...CATEGORY_FIELDS, offerCreditCost: '5' }, proof));
    },
    refused: refusedRedirect('/categories/klima?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: limitsiz paket uygunluğunu açma',
    key: 'category.unlimited-enable',
    read: [STORED_CATEGORY],
    run: async (proof) => {
      const { updateCategoryAction } = await import('../app/categories/actions');
      return updateCategoryAction(form({ ...CATEGORY_FIELDS, unlimitedPackageEligible: 'on' }, proof));
    },
    refused: refusedRedirect('/categories/klima?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: formdan yayına alma',
    key: 'category.activate',
    read: [{ ...STORED_CATEGORY, status: 'DRAFT' }],
    run: async (proof) => {
      const { updateCategoryAction } = await import('../app/categories/actions');
      return updateCategoryAction(form({ ...CATEGORY_FIELDS, status: 'ACTIVE' }, proof));
    },
    refused: refusedRedirect('/categories/klima?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: durum kartından kapatma',
    key: 'category.deactivate',
    read: [STORED_CATEGORY],
    run: async (proof) => {
      const { updateCategoryStatusAction } = await import('../app/categories/actions');
      return updateCategoryStatusAction(form({ id: 'cat-1', slug: 'klima', status: 'INACTIVE' }, proof));
    },
    refused: refusedRedirect('/categories/klima?error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'categories: yönlendirme kuralları',
    key: 'category.router-rules-update',
    read: { ...STORED_CATEGORY, questions: [{ id: 'q-1', routerRules: [{ optionKey: 'a', targetCategorySlug: 'klima' }] }] },
    run: async (proof) => {
      const { replaceRouterRulesAction } = await import('../app/categories/actions');
      return replaceRouterRulesAction(
        form({ id: 'q-1', categorySlug: 'klima', routerOptionKey: 'a', routerTargetSlug: 'kombi' }, proof),
      );
    },
    refused: refusedRedirect('/categories/klima?tab=sorular&error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'questions: pasifleştir',
    key: 'question.deactivate',
    run: async (proof) => {
      const { updateQuestionStatusAction } = await import('../app/categories/actions');
      return updateQuestionStatusAction(form({ id: 'q-1', categorySlug: 'klima', isActive: 'false' }, proof));
    },
    refused: refusedRedirect('/categories/klima?tab=sorular&error=CONFIRMATION_REQUIRED'),
  },
  {
    name: 'provider invites: iptal et',
    key: 'provider-invite.revoke',
    write: { revoked: true },
    run: async (proof) => {
      const { providerInviteAction } = await import('../app/categories/actions');
      return providerInviteAction(
        { kind: 'idle' },
        form({ intent: 'revoke', categoryId: 'cat-1', categorySlug: 'klima', inviteId: 'inv-1' }, proof),
      );
    },
    refused: refusedState,
  },
  {
    name: 'support: çözüldü',
    key: 'support.resolve',
    run: async (proof) => {
      const { changeSupportTicketStatusAction } = await import('../app/support/actions');
      return changeSupportTicketStatusAction(form({ id: 't-1', status: 'RESOLVED' }, proof));
    },
    refused: refusedRedirect('/support/t-1?error='),
  },
  {
    name: 'provider reviews: bildirim uygun bulundu',
    key: 'provider-review.report-dismiss',
    write: { id: 'r-1', provider: { id: 'p-1' }, request: { id: 'rq-1' } },
    run: async (proof) => {
      const { dismissReviewReportAction } = await import('../app/provider-reviews/[reviewId]/actions');
      return dismissReviewReportAction(form({ reviewId: 'r-1' }, proof));
    },
    refused: refusedRedirect('/provider-reviews/r-1?error=confirmation'),
  },
  {
    name: 'support: iade isteği aç',
    key: 'package-refund.open',
    write: { id: 'pr-9' },
    run: async (proof) => {
      const { openPackageRefundRequestAction } = await import('../app/package-refunds/actions');
      return openPackageRefundRequestAction(form({ supportTicketId: 't-1', purchaseId: 'pu-1' }, proof));
    },
    refused: refusedRedirect('/support/t-1?error='),
  },
  {
    name: 'company settings: değer değişimi',
    key: 'company-settings.update',
    read: STORED_COMPANY_SETTINGS,
    run: async (proof) => {
      const { saveCompanySettingsAction } = await import('../app/company-settings/actions');
      return saveCompanySettingsAction(form({ ...COMPANY_SETTINGS_FIELDS, legalName: 'Yeni Unvan A.Ş.' }, proof));
    },
    refused: refusedRedirect('/company-settings?error='),
  },
  {
    name: 'operations: teklif iade süresi',
    key: 'operations.refund-window-update',
    read: { unviewedOfferRefundWindowHours: 24 },
    run: async (proof) => {
      const { saveOperationsSettingsAction } = await import('../app/operations-settings/actions');
      return saveOperationsSettingsAction(form({ unviewedOfferRefundWindowHours: '48' }, proof));
    },
    refused: refusedRedirect('/operations-settings?error='),
  },
  // ── Paket A: package refunds ──
  {
    name: 'package refunds: işleme al',
    key: 'package-refund.take',
    run: async (proof) => {
      const { takePackageRefundAction } = await import('../app/package-refunds/actions');
      return takePackageRefundAction(form({ id: 'pr-1' }, proof));
    },
    refused: refusedRedirect('/package-refunds/pr-1?error='),
  },
];

describe('guarded server actions refuse a submission without a good proof, and write nothing', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    cookieValue = 'staff-session';
  });

  function primeReads(read: unknown, write: unknown = { id: 'x', amount: 10, balanceAfter: 50 }) {
    apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) =>
      !init?.method || init.method === 'GET' ? read : write,
    );
  }

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('no proof — a click before hydration or a post with JavaScript off — is refused', async () => {
        primeReads(testCase.read, testCase.write);
        testCase.refused(await outcome(() => testCase.run(null)));
        expect(writes()).toEqual([]);
      });

      it('a made-up proof, or a static "confirm" value, is refused', async () => {
        primeReads(testCase.read, testCase.write);
        for (const forged of ['yes', 'on', 'eyJrIjoieCJ9.Zm9yZ2Vk']) {
          testCase.refused(await outcome(() => testCase.run(forged)));
        }
        expect(writes()).toEqual([]);
      });

      it('a proof minted for another confirmation, or in another session, is refused', async () => {
        primeReads(testCase.read, testCase.write);
        const otherKey = testCase.key === 'credits.grant' ? 'credits.deduct' : 'credits.grant';
        const wrongScope = await issueConfirmationProof(otherKey);
        testCase.refused(await outcome(() => testCase.run(wrongScope)));
        const theirs = await issueConfirmationProof(testCase.key);
        cookieValue = 'someone-else';
        testCase.refused(await outcome(() => testCase.run(theirs)));
        expect(writes()).toEqual([]);
      });

      it('a real proof goes through exactly as before — once; a replay of it is refused', async () => {
        primeReads(testCase.read, testCase.write);
        const proof = await issueConfirmationProof(testCase.key);
        const first = await outcome(() => testCase.run(proof));
        expect(JSON.stringify(first)).not.toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
        expect(first.redirect ?? '').not.toContain('confirmation');
        expect(first.redirect ?? '').not.toContain('CONFIRMATION_REQUIRED');
        expect(writes()).toHaveLength(1);

        testCase.refused(await outcome(() => testCase.run(proof)));
        expect(writes()).toHaveLength(1);
      });
    });
  }

  it('the actions\' direct branches are left alone: shortlisting, switching a job off', async () => {
    primeReads({ card: { liveVersion: { id: 'live' } } });
    const { updateOfferStatusAction } = await import('../app/offers/actions');
    await outcome(() => updateOfferStatusAction(form({ id: 'o-1', status: 'SHORTLISTED' })));
    const { toggleSchedulerAction } = await import('../app/operations-settings/actions');
    await outcome(() => toggleSchedulerAction(form({ job: 'request-expiry', enabled: 'false' })));
    expect(writes()).toHaveLength(2);
  });

  it('Paket B: a revision approval is no longer direct — it needs its own proof, not the first approval\'s', async () => {
    primeReads({ card: { liveVersion: { id: 'live' } } });
    const { approveShowcaseVersionAction } = await import('../app/showcase/reviews/[versionId]/actions');
    const first = await issueConfirmationProof('showcase.approve-first');
    expect((await outcome(() => approveShowcaseVersionAction(form({ versionId: 'v-2' }, first)))).redirect).toContain(
      'error=',
    );
    expect(writes()).toEqual([]);
  });

  describe('Paket B: the low-risk branches stay direct — no proof asked, one write each', () => {
    it('a category save of the name, description or order; a status card pressed on the current status', async () => {
      const { updateCategoryAction, updateCategoryStatusAction } = await import('../app/categories/actions');
      primeReads([STORED_CATEGORY]);
      const saved = await outcome(() =>
        updateCategoryAction(form({ ...CATEGORY_FIELDS, name: 'Klima bakımı', description: 'Yeni metin', sortOrder: '4' })),
      );
      expect(saved.redirect).toBe('/categories/klima');
      await outcome(() => updateCategoryStatusAction(form({ id: 'cat-1', slug: 'klima', status: 'ACTIVE' })));
      expect(writes()).toHaveLength(2);
    });

    it('switching unlimited eligibility off, and a save without the status permission', async () => {
      const { updateCategoryAction } = await import('../app/categories/actions');
      primeReads([{ ...STORED_CATEGORY, unlimitedPackageEligible: true }]);
      await outcome(() => updateCategoryAction(form({ ...CATEGORY_FIELDS })));
      // statusLocked: the status is not sent, so a stale echo cannot ask or move it.
      await outcome(() => updateCategoryAction(form({ ...CATEGORY_FIELDS, status: 'DRAFT', statusLocked: '1', unlimitedPackageEligible: 'on' })));
      expect(writes()).toHaveLength(2);
    });

    it('a DRAFT create, an invite issue, activating a question, IN_PROGRESS, resuming a hold, an unchanged map', async () => {
      const categories = await import('../app/categories/actions');
      primeReads({ ...STORED_CATEGORY, questions: [{ id: 'q-1', routerRules: [{ optionKey: 'a', targetCategorySlug: 'klima' }] }] }, {
        id: 'x',
        slug: 'yeni',
        url: 'https://example.test/davet',
        expiresAt: '2026-10-20T00:00:00.000Z',
      });
      await outcome(() => categories.createCategoryAction(form({ ...CATEGORY_FIELDS, status: 'DRAFT' })));
      await outcome(() =>
        categories.providerInviteAction({ kind: 'idle' }, form({ intent: 'issue', categoryId: 'cat-1', categorySlug: 'klima' })),
      );
      await outcome(() => categories.updateQuestionStatusAction(form({ id: 'q-1', categorySlug: 'klima', isActive: 'true' })));
      await outcome(() =>
        categories.replaceRouterRulesAction(
          form({ id: 'q-1', categorySlug: 'klima', routerOptionKey: 'a', routerTargetSlug: 'klima' }),
        ),
      );
      const { changeSupportTicketStatusAction } = await import('../app/support/actions');
      await outcome(() => changeSupportTicketStatusAction(form({ id: 't-1', status: 'IN_PROGRESS' })));
      const { resumeShowcasePlacementAction } = await import('../app/showcase/placements/actions');
      await outcome(() => resumeShowcasePlacementAction(form({ placementId: 'pl-1' })));
      expect(writes()).toHaveLength(6);
    });

    it('a settings save that changes nothing (company: case and spaces only; refund window: same hours)', async () => {
      const { saveCompanySettingsAction } = await import('../app/company-settings/actions');
      primeReads(STORED_COMPANY_SETTINGS);
      const company = await outcome(() =>
        saveCompanySettingsAction(form({ ...COMPANY_SETTINGS_FIELDS, supportEmail: ' DESTEK@ornek.com.tr ', postalAddress: '   ' })),
      );
      expect(company.redirect).toBe('/company-settings?ok=saved');
      const { saveOperationsSettingsAction } = await import('../app/operations-settings/actions');
      primeReads({ unviewedOfferRefundWindowHours: 24 });
      const hours = await outcome(() => saveOperationsSettingsAction(form({ unviewedOfferRefundWindowHours: '24' })));
      expect(hours.redirect).toBe('/operations-settings?ok=saved');
      expect(writes()).toHaveLength(2);
    });
  });

  describe('Paket B: the delta is the server\'s, never the form\'s', () => {
    it('a category save that moves the slug and the status needs both proofs; either alone is refused', async () => {
      const { updateCategoryAction } = await import('../app/categories/actions');
      primeReads([STORED_CATEGORY]);
      const fields = { ...CATEGORY_FIELDS, slug: 'klima-servisi', status: 'INACTIVE' };
      const structure = await issueConfirmationProof('category.structure-update');
      expect((await outcome(() => updateCategoryAction(form(fields, structure)))).redirect).toContain('CONFIRMATION_REQUIRED');
      const status = await issueConfirmationProof('category.deactivate');
      expect((await outcome(() => updateCategoryAction(form(fields, status)))).redirect).toContain('CONFIRMATION_REQUIRED');
      expect(writes()).toEqual([]);

      const both = form(fields);
      both.append(CONFIRMATION_PROOF_FIELD, (await issueConfirmationProof('category.structure-update'))!);
      both.append(CONFIRMATION_PROOF_FIELD, (await issueConfirmationProof('category.deactivate'))!);
      await outcome(() => updateCategoryAction(both));
      expect(writes()).toHaveLength(1);
    });

    it('the direction of a status move comes from the stored status: an activate proof does not close', async () => {
      const { updateCategoryStatusAction } = await import('../app/categories/actions');
      primeReads([STORED_CATEGORY]);
      const activate = await issueConfirmationProof('category.activate');
      const result = await outcome(() =>
        updateCategoryStatusAction(form({ id: 'cat-1', slug: 'klima', status: 'DRAFT' }, activate)),
      );
      expect(result.redirect).toContain('CONFIRMATION_REQUIRED');
      expect(writes()).toEqual([]);
    });

    it('a category, router or setting that cannot be read is treated as changed, and refused without a proof', async () => {
      apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
        if (!init?.method || init.method === 'GET') throw new Error('unreadable');
        return { id: 'x' };
      });
      const categories = await import('../app/categories/actions');
      expect((await outcome(() => categories.updateCategoryAction(form({ ...CATEGORY_FIELDS })))).redirect).toContain(
        'CONFIRMATION_REQUIRED',
      );
      expect((await outcome(() => categories.updateCategoryStatusAction(form({ id: 'cat-1', slug: 'klima', status: 'ACTIVE' })))).redirect).toContain(
        'CONFIRMATION_REQUIRED',
      );
      expect(
        (
          await outcome(() =>
            categories.replaceRouterRulesAction(form({ id: 'q-1', categorySlug: 'klima', routerOptionKey: 'a', routerTargetSlug: 'klima' })),
          )
        ).redirect,
      ).toContain('CONFIRMATION_REQUIRED');
      const { saveCompanySettingsAction } = await import('../app/company-settings/actions');
      expect((await outcome(() => saveCompanySettingsAction(form(COMPANY_SETTINGS_FIELDS)))).redirect).toContain('error=');
      const { saveOperationsSettingsAction } = await import('../app/operations-settings/actions');
      expect((await outcome(() => saveOperationsSettingsAction(form({ unviewedOfferRefundWindowHours: '24' })))).redirect).toContain(
        'error=',
      );
      expect(writes()).toEqual([]);
    });

    it('a router question named under another category is judged as a change', async () => {
      const { replaceRouterRulesAction } = await import('../app/categories/actions');
      primeReads({ ...STORED_CATEGORY, questions: [] });
      const result = await outcome(() =>
        replaceRouterRulesAction(form({ id: 'q-1', categorySlug: 'klima', routerOptionKey: 'a', routerTargetSlug: 'klima' })),
      );
      expect(result.redirect).toContain('CONFIRMATION_REQUIRED');
      expect(writes()).toEqual([]);
    });

    it('a suspension without a reason is refused before the proof is even looked at', async () => {
      const { suspendShowcasePlacementAction } = await import('../app/showcase/placements/actions');
      const proof = await issueConfirmationProof('showcase.placement-suspend');
      const result = await outcome(() => suspendShowcasePlacementAction(form({ placementId: 'pl-1', note: '  kısa  ' }, proof)));
      expect(result.redirect).toBe('/showcase/placements/pl-1?error=SHOWCASE_PLACEMENT_SUSPEND_NOTE_REQUIRED');
      expect(writes()).toEqual([]);
      // Not spent by the refusal: it still opens the real suspension once.
      await outcome(() => suspendShowcasePlacementAction(form({ placementId: 'pl-1', note: 'Şikâyet incelemesi için' }, proof)));
      expect(writes()).toHaveLength(1);
    });
  });

  it('Faz 2: the low-risk branches of the same actions stay direct — no proof asked, one write each', async () => {
    const { updateRequestStatusAction } = await import('../app/requests/actions');
    const { updateProviderStatusAction } = await import('../app/providers/actions');
    const { createCustomerActivationLinkAction } = await import('../app/customers/actions');

    // A new request into review: the queue's first step.
    primeReads({ status: 'SUBMITTED' });
    await outcome(() => updateRequestStatusAction(form({ id: 'rq-1', status: 'IN_REVIEW' })));
    expect(writes()).toHaveLength(1);

    // A provider out of DRAFT into review, and out of REJECTED/SUSPENDED into review.
    for (const from of ['DRAFT', 'REJECTED', 'SUSPENDED']) {
      primeReads({ status: from });
      const result = await outcome(() => updateProviderStatusAction(form({ id: 'p-1', status: 'PENDING_REVIEW' })));
      expect(result.redirect).toBe('/providers/p-1?statusSaved=1#durum-yonetimi');
    }
    expect(writes()).toHaveLength(4);

    // The first access link.
    primeReads(undefined);
    const issued = await outcome(() => createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1' })));
    expect(JSON.stringify(issued)).not.toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
    expect(writes()).toHaveLength(5);
  });

  it('Faz 2: a proof for the neighbouring move does not open this one', async () => {
    const { updateRequestStatusAction } = await import('../app/requests/actions');
    const { updateProviderStatusAction } = await import('../app/providers/actions');
    const { updateCustomerStatusAction } = await import('../app/customers/actions');

    primeReads({ status: 'APPROVED' });
    for (const key of ['request.approve', 'request.reject'] as const) {
      const result = await outcome(async () =>
        updateRequestStatusAction(form({ id: 'rq-1', status: 'IN_REVIEW' }, await issueConfirmationProof(key))),
      );
      expect(result.redirect).toContain('statusError=confirmationRequired');
    }
    primeReads({ status: 'PENDING_REVIEW' });
    for (const [status, key] of [
      ['APPROVED', 'provider.status'],
      ['APPROVED', 'provider.draft'],
      ['DRAFT', 'provider.approve'],
      ['SUSPENDED', 'provider.approve'],
    ] as const) {
      const result = await outcome(async () =>
        updateProviderStatusAction(form({ id: 'p-1', status }, await issueConfirmationProof(key))),
      );
      expect(result.redirect, `${status} with ${key}`).toContain('statusError=confirmation');
    }
    const activate = await outcome(async () =>
      updateCustomerStatusAction(form({ customerId: 'c-1', isActive: 'true' }, await issueConfirmationProof('customer.status'))),
    );
    expect(activate.redirect).toContain('statusError=');
    const passivate = await outcome(async () =>
      updateCustomerStatusAction(form({ customerId: 'c-1', isActive: 'false' }, await issueConfirmationProof('customer.activate'))),
    );
    expect(passivate.redirect).toContain('statusError=');
    expect(writes()).toEqual([]);
  });

  describe('Faz 2: the access link — the API decides "reissue", the proof only grants consent', () => {
    const bodies = () =>
      writes().map(([path, init]) => [path, JSON.parse((init as { body: string }).body) as unknown]);

    it('no proof: asks the API without consent to replace, whatever the form or the previous state claims', async () => {
      primeReads(undefined);
      const { createCustomerActivationLinkAction } = await import('../app/customers/actions');
      const issued = { kind: 'issued', activationUrl: 'https://x.test/a?token=t', expiresAt: '2026-10-05T00:00:00.000Z' } as const;
      await createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1' }));
      await createCustomerActivationLinkAction(issued, form({ customerId: 'c-1', replaces: '1' }));
      await createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1', replaces: '0', replaceExisting: 'true' }));
      expect(bodies()).toEqual([
        ['/customers/c-1/activation-link', { replaceExisting: false }],
        ['/customers/c-1/activation-link', { replaceExisting: false }],
        ['/customers/c-1/activation-link', { replaceExisting: false }],
      ]);
    });

    it('a made-up, foreign-key or other-session proof is refused before any request', async () => {
      primeReads(undefined);
      const { createCustomerActivationLinkAction } = await import('../app/customers/actions');
      const proofs = ['yes', 'eyJrIjoieCJ9.Zm9yZ2Vk', await issueConfirmationProof('customer.activate')];
      const theirs = await issueConfirmationProof('customer.activation-link-reissue');
      for (const proof of proofs) {
        expect(await createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1' }, proof))).toEqual({
          kind: 'error',
          message: CONFIRMATION_PROOF_REFUSAL_MESSAGE,
          reissue: true,
        });
      }
      cookieValue = 'someone-else';
      refusedState({ value: await createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1' }, theirs)) });
      expect(writes()).toEqual([]);
    });

    it('a real proof gives consent exactly once; its replay is refused', async () => {
      primeReads(undefined);
      const { createCustomerActivationLinkAction } = await import('../app/customers/actions');
      const proof = await issueConfirmationProof('customer.activation-link-reissue');
      const first = await createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1' }, proof));
      expect(JSON.stringify(first)).not.toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
      refusedState({ value: await createCustomerActivationLinkAction({ kind: 'idle' }, form({ customerId: 'c-1' }, proof)) });
      expect(bodies()).toEqual([['/customers/c-1/activation-link', { replaceExisting: true }]]);
    });
  });

  it('Faz 2: "İncelemeye al" carries the status it was decided against (compare-and-set)', async () => {
    const { updateRequestStatusAction } = await import('../app/requests/actions');
    const sent = () => writes().map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);

    // A new request: no proof, and the API is told it must still be SUBMITTED.
    primeReads({ status: 'SUBMITTED' });
    await outcome(() => updateRequestStatusAction(form({ id: 'rq-1', status: 'IN_REVIEW' })));
    // A live one: the proof, and the API is told it must still be APPROVED.
    primeReads({ status: 'APPROVED' });
    await outcome(async () =>
      updateRequestStatusAction(form({ id: 'rq-1', status: 'IN_REVIEW' }, await issueConfirmationProof('request.unpublish'))),
    );
    // Approve and reject are confirmed whatever the status: no compare-and-set needed.
    await outcome(async () =>
      updateRequestStatusAction(form({ id: 'rq-1', status: 'APPROVED' }, await issueConfirmationProof('request.approve'))),
    );
    expect(sent().map((body) => [body.status, body.expectedCurrentStatus])).toEqual([
      ['IN_REVIEW', 'SUBMITTED'],
      ['IN_REVIEW', 'APPROVED'],
      ['APPROVED', undefined],
    ]);
  });

  it('Faz 2: a provider or request that cannot be read is treated as needing the confirmation', async () => {
    apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (!init?.method || init.method === 'GET') throw new Error('unreadable');
      return {};
    });
    const { updateRequestStatusAction } = await import('../app/requests/actions');
    const { updateProviderStatusAction } = await import('../app/providers/actions');
    refusedRedirect('statusError=confirmationRequired')(
      await outcome(() => updateRequestStatusAction(form({ id: 'rq-1', status: 'IN_REVIEW' }))),
    );
    for (const status of ['APPROVED', 'DRAFT', 'SUSPENDED']) {
      refusedRedirect('statusError=confirmation')(
        await outcome(() => updateProviderStatusAction(form({ id: 'p-1', status }))),
      );
    }
    expect(writes()).toEqual([]);
  });

  it('a revision approval whose version cannot be read is treated as a first one, and refused without a proof', async () => {
    apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (!init?.method || init.method === 'GET') throw new Error('unreadable');
      return {};
    });
    const { approveShowcaseVersionAction } = await import('../app/showcase/reviews/[versionId]/actions');
    refusedRedirect('/showcase/reviews/v-3?error=')(await outcome(() => approveShowcaseVersionAction(form({ versionId: 'v-3' }))));
    expect(writes()).toEqual([]);
  });

  describe('Paket A: the campaign activation key comes from the status the API reports', () => {
    const sent = () => writes().map(([path, init]) => [path, JSON.parse((init as { body: string }).body) as unknown]);

    it('a neighbouring version key does not open this move, and the status confirmed is sent along', async () => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      primeReads({ campaign: { status: 'PAUSED' } });
      for (const key of ['campaign.version-switch', 'campaign.version-activate', 'campaign.resume'] as const) {
        refusedState({
          value: await campaignLifecycleAction(
            { status: 'idle' } as never,
            form({ intent: 'activate', campaignId: 'c-1', versionNumber: '2', reason: 'Yeni kural' }, await issueConfirmationProof(key)),
          ),
        });
      }
      expect(writes()).toEqual([]);

      primeReads({ campaign: { status: 'ACTIVE' } });
      await outcome(async () =>
        campaignLifecycleAction(
          { status: 'idle' } as never,
          form({ intent: 'activate', campaignId: 'c-1', versionNumber: '2' }, await issueConfirmationProof('campaign.version-switch')),
        ),
      );
      expect(sent()).toEqual([['/admin/campaigns/c-1/versions/2/activate', { expectedStatus: 'ACTIVE' }]]);
    });

    it('resuming with a version needs a reason, proof or not, and sends it', async () => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      primeReads({ campaign: { status: 'PAUSED' } });
      const refused = await campaignLifecycleAction(
        { status: 'idle' } as never,
        form({ intent: 'activate', campaignId: 'c-1', versionNumber: '2', reason: ' a ' }, await issueConfirmationProof('campaign.version-resume')),
      );
      expect(JSON.stringify(refused)).toContain('gerekçe en az 3 karakter');
      expect(writes()).toEqual([]);
      await outcome(async () =>
        campaignLifecycleAction(
          { status: 'idle' } as never,
          form(
            { intent: 'activate', campaignId: 'c-1', versionNumber: '2', reason: '  Yeni kural  ' },
            await issueConfirmationProof('campaign.version-resume'),
          ),
        ),
      );
      expect(sent()).toEqual([['/admin/campaigns/c-1/versions/2/activate', { expectedStatus: 'PAUSED', reason: 'Yeni kural' }]]);
    });

    it('a campaign that cannot be read, or has ended, is not activated', async () => {
      const { campaignLifecycleAction } = await import('../app/campaigns/actions');
      apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
        if (!init?.method || init.method === 'GET') throw new Error('unreadable');
        return {};
      });
      const unreadable = await campaignLifecycleAction(
        { status: 'idle' } as never,
        form({ intent: 'activate', campaignId: 'c-1', versionNumber: '1' }, await issueConfirmationProof('campaign.version-activate')),
      );
      expect(JSON.stringify(unreadable)).toContain('okunamadı');
      primeReads({ campaign: { status: 'ENDED' } });
      const ended = await campaignLifecycleAction(
        { status: 'idle' } as never,
        form({ intent: 'activate', campaignId: 'c-1', versionNumber: '1' }, await issueConfirmationProof('campaign.version-activate')),
      );
      expect(JSON.stringify(ended)).toContain('Sona ermiş');
      expect(writes()).toEqual([]);
    });
  });

  describe('Paket A: a package edit asks only for the risky delta, judged against the stored package', () => {
    it('a credit-package save of the name, slug, description or order needs no proof', async () => {
      primeReads(STORED_CREDIT_PACKAGE);
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      const result = await outcome(() =>
        updateCreditPackageAction(
          form({ ...CREDIT_PACKAGE_FIELDS, id: 'cp-1', name: 'Başlangıç+', slug: 'baslangic-2', description: 'Yeni metin', sortOrder: '5' }),
        ),
      );
      expect(result.redirect).toBe('/credit-packages/cp-1?ok=saved');
      expect(writes()).toHaveLength(1);
    });

    it('a form that only claims "nothing changed" is not believed: the price is compared to the stored one', async () => {
      primeReads(STORED_CREDIT_PACKAGE);
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      for (const fields of [{ priceAmount: '149,91' }, { creditAmount: '60' }, { currency: 'USD' }]) {
        refusedRedirect('/credit-packages/cp-1?error=')(
          await outcome(() => updateCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, id: 'cp-1', commercialChanged: '0', ...fields }))),
        );
      }
      expect(writes()).toEqual([]);
    });

    it('a price change and a status change together need both proofs; either alone is refused', async () => {
      primeReads(STORED_CREDIT_PACKAGE);
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      const fields = { ...CREDIT_PACKAGE_FIELDS, id: 'cp-1', priceAmount: '199,90', isActive: 'false' };
      for (const key of ['credit-package.update-commercial', 'credit-package.deactivate'] as const) {
        refusedRedirect('/credit-packages/cp-1?error=')(
          await outcome(async () => updateCreditPackageAction(form(fields, await issueConfirmationProof(key)))),
        );
      }
      expect(writes()).toEqual([]);
      const both = form(fields, await issueConfirmationProof('credit-package.update-commercial'));
      both.append(CONFIRMATION_PROOF_FIELD, (await issueConfirmationProof('credit-package.deactivate'))!);
      expect((await outcome(() => updateCreditPackageAction(both))).redirect).toBe('/credit-packages/cp-1?ok=saved');
      expect(writes()).toHaveLength(1);
    });

    it('without the status permission the status is not sent and not asked about', async () => {
      primeReads({ ...STORED_CREDIT_PACKAGE, isActive: true });
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      const result = await outcome(() =>
        updateCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, id: 'cp-1', isActive: '', statusLocked: '1', name: 'Yeni ad' })),
      );
      expect(result.redirect).toBe('/credit-packages/cp-1?ok=saved');
    });

    it('a package that cannot be read is refused without a proof', async () => {
      apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
        if (!init?.method || init.method === 'GET') throw new Error('unreadable');
        return {};
      });
      const { updateCreditPackageAction } = await import('../app/credit-packages/actions');
      const { updateShowcasePackageAction } = await import('../app/showcase/packages/actions');
      refusedRedirect('/credit-packages/cp-1?error=')(
        await outcome(() => updateCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, id: 'cp-1' }))),
      );
      refusedRedirect('error=CONFIRMATION_REQUIRED')(
        await outcome(() => updateShowcasePackageAction(form({ ...SHOWCASE_PACKAGE_FIELDS, packageId: 'sp-1' }))),
      );
      expect(writes()).toEqual([]);
    });

    it('an inactive credit package is created without a proof', async () => {
      primeReads(undefined);
      apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) =>
        !init?.method || init.method === 'GET' ? undefined : { id: 'cp-9' },
      );
      const { createCreditPackageAction } = await import('../app/credit-packages/actions');
      const result = await outcome(() => createCreditPackageAction(form({ ...CREDIT_PACKAGE_FIELDS, isActive: 'false' })));
      expect(result.redirect).toBe('/credit-packages/cp-9?ok=created');
      expect(writes()).toHaveLength(1);
    });

    it('a vitrin-package save of the name, description or order needs no proof; the run length does', async () => {
      primeReads(STORED_SHOWCASE_PACKAGE);
      const { updateShowcasePackageAction } = await import('../app/showcase/packages/actions');
      const cosmetic = await outcome(() =>
        updateShowcasePackageAction(form({ ...SHOWCASE_PACKAGE_FIELDS, packageId: 'sp-1', name: 'Vitrin 30+', description: 'Yeni', sortOrder: '3' })),
      );
      expect(cosmetic.redirect).toBe('/showcase/packages/sp-1?saved=1');
      expect(writes()).toHaveLength(1);
      for (const fields of [{ durationDays: '45' }, { activationWindowDays: '60' }, { allowedCardKind: 'SERVICE' }, { maxAreas: '3' }]) {
        refusedRedirect('error=CONFIRMATION_REQUIRED')(
          await outcome(() => updateShowcasePackageAction(form({ ...SHOWCASE_PACKAGE_FIELDS, packageId: 'sp-1', ...fields }))),
        );
      }
      expect(writes()).toHaveLength(1);
    });
  });

  it('Paket A: the off switches that stay one tap, and the reviews switch keys each direction', async () => {
    const { toggleAutoPublishAction, toggleProviderReviewsAction } = await import('../app/operations-settings/actions');
    await outcome(() => toggleAutoPublishAction(form({ enabled: 'false' })));
    expect(writes()).toHaveLength(1);
    refusedRedirect('#degerlendirmeler')(
      await outcome(async () => toggleProviderReviewsAction(form({ enabled: 'false' }, await issueConfirmationProof('operations.reviews-enable')))),
    );
    refusedRedirect('#degerlendirmeler')(
      await outcome(async () => toggleProviderReviewsAction(form({ enabled: 'true' }, await issueConfirmationProof('operations.reviews-disable')))),
    );
    expect(writes()).toHaveLength(1);
  });

  it('Paket A: a manual offer refund without a chosen reason is refused before anything else', async () => {
    const { refundOfferCreditAction } = await import('../app/offers/actions');
    const result = await outcome(async () =>
      refundOfferCreditAction(form({ id: 'o-1', reasonCode: '' }, await issueConfirmationProof('offer.refund'))),
    );
    expect(result.redirect).toBe('/offers/o-1?tab=kredi&refundError=reasonRequired');
    expect(writes()).toEqual([]);
  });

  it('several proofs: each covers one key, and one minted for another key is not spent by trying it', async () => {
    const { hasConfirmationProofs } = await import('../lib/confirmation-proof-server');
    const a = (await issueConfirmationProof('credit-package.activate'))!;
    const b = (await issueConfirmationProof('credit-package.update-commercial'))!;
    const data = new FormData();
    data.append(CONFIRMATION_PROOF_FIELD, a);
    data.append(CONFIRMATION_PROOF_FIELD, b);
    // Only one key asked: `a` is tried for it first, refused on scope, and stays good.
    expect(await hasConfirmationProofs(data, ['credit-package.update-commercial'])).toBe(true);
    const onlyA = new FormData();
    onlyA.append(CONFIRMATION_PROOF_FIELD, a);
    expect(await hasConfirmationProofs(onlyA, ['credit-package.activate'])).toBe(true);
    // One token cannot stand for two keys, and nothing asked is nothing needed.
    const one = new FormData();
    one.append(CONFIRMATION_PROOF_FIELD, (await issueConfirmationProof('credit-package.activate'))!);
    expect(await hasConfirmationProofs(one, ['credit-package.activate', 'credit-package.update-commercial'])).toBe(false);
    expect(await hasConfirmationProofs(new FormData(), [])).toBe(true);
  });

  it('the mint action hands out a proof only for a known key and a session', async () => {
    expect(await mintConfirmationProof('credits.grant')).toEqual(expect.stringMatching(/^[\w-]+\.[\w-]+$/));
    expect(await mintConfirmationProof('not-a-key')).toBeNull();
    cookieValue = null;
    expect(await mintConfirmationProof('credits.grant')).toBeNull();
  });
});

// ─────────────────────────── coverage ───────────────────────────

/** The app-local `.ts` modules a file imports with a relative path (one level, no packages). */
function localImports(path: string): string[] {
  const root = resolve(__dirname, '..');
  const dir = join(path, '..');
  return [...read(path).matchAll(/from '(\.{1,2}\/[^']+)'/g)].flatMap((match) => {
    const candidate = join(dir, `${match[1]}.ts`);
    try {
      return statSync(resolve(root, candidate)).isFile() ? [candidate] : [];
    } catch {
      return [];
    }
  });
}

describe('every ConfirmDialog is guarded on the server', () => {
  const tsx = walk('app').filter((path) => path.endsWith('.tsx'));
  const actions = walk('app')
    .filter((path) => path.endsWith('.ts'))
    .map((path) => read(path))
    .join('\n');

  it('names a known proof key on every dialog in the panel', () => {
    let dialogs = 0;
    for (const path of tsx) {
      const source = read(path);
      for (const match of source.matchAll(/<ConfirmDialog\b([\s\S]*?)\/>/g)) {
        dialogs += 1;
        const key = /proof="([^"]+)"/.exec(match[1]!)?.[1];
        expect(key, `${path}: a ConfirmDialog without proof`).toBeDefined();
        expect(CONFIRMATION_PROOF_KEYS as readonly string[], `${path}: ${key}`).toContain(key);
      }
    }
    expect(dialogs).toBeGreaterThanOrEqual(44);
  });

  it('every key is used by a dialog and checked by an action before it writes', () => {
    const dialogs = tsx.map((path) => read(path)).join('\n');
    // A ConfirmGate (Paket A) names its proofs in its `evaluate` decision, in a
    // client file that renders <ConfirmGate — or (Paket B) in a local module
    // that file imports to work the decision out (`category-changes.ts`).
    const gateFiles = tsx.filter((path) => read(path).includes('<ConfirmGate'));
    const gates = gateFiles
      .flatMap((path) => [read(path), ...localImports(path).map((imported) => read(imported))])
      .join('\n');
    for (const key of CONFIRMATION_PROOF_KEYS) {
      const asked = dialogs.includes(`proof="${key}"`) || gates.includes(`'${key}'`);
      expect(asked, `no dialog asks for ${key}`).toBe(true);
      expect(actions, `no action checks ${key}`).toContain(`'${key}'`);
    }
  });

  it('no action trusts a fixed confirmation value any more', () => {
    expect(actions).not.toMatch(/readString\(formData, 'confirm'\)/);
  });
});
