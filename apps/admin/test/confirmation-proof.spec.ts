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

type Case = {
  name: string;
  key: (typeof CONFIRMATION_PROOF_KEYS)[number];
  run: (proof: string | null) => Promise<unknown>;
  refused: (result: { redirect?: string; value?: unknown }) => void;
  /** What the API answers a read the action makes before deciding (GET), if any. */
  read?: unknown;
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
];

describe('guarded server actions refuse a submission without a good proof, and write nothing', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    cookieValue = 'staff-session';
  });

  function primeReads(read: unknown) {
    apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) =>
      !init?.method || init.method === 'GET' ? read : { id: 'x', amount: 10, balanceAfter: 50 },
    );
  }

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('no proof — a click before hydration or a post with JavaScript off — is refused', async () => {
        primeReads(testCase.read);
        testCase.refused(await outcome(() => testCase.run(null)));
        expect(writes()).toEqual([]);
      });

      it('a made-up proof, or a static "confirm" value, is refused', async () => {
        primeReads(testCase.read);
        for (const forged of ['yes', 'on', 'eyJrIjoieCJ9.Zm9yZ2Vk']) {
          testCase.refused(await outcome(() => testCase.run(forged)));
        }
        expect(writes()).toEqual([]);
      });

      it('a proof minted for another confirmation, or in another session, is refused', async () => {
        primeReads(testCase.read);
        const otherKey = testCase.key === 'credits.grant' ? 'credits.deduct' : 'credits.grant';
        const wrongScope = await issueConfirmationProof(otherKey);
        testCase.refused(await outcome(() => testCase.run(wrongScope)));
        const theirs = await issueConfirmationProof(testCase.key);
        cookieValue = 'someone-else';
        testCase.refused(await outcome(() => testCase.run(theirs)));
        expect(writes()).toEqual([]);
      });

      it('a real proof goes through exactly as before — once; a replay of it is refused', async () => {
        primeReads(testCase.read);
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

  it('the actions\' direct branches are left alone: shortlisting, a revision approval, switching a job off', async () => {
    primeReads({ card: { liveVersion: { id: 'live' } } });
    const { updateOfferStatusAction } = await import('../app/offers/actions');
    await outcome(() => updateOfferStatusAction(form({ id: 'o-1', status: 'SHORTLISTED' })));
    const { approveShowcaseVersionAction } = await import('../app/showcase/reviews/[versionId]/actions');
    await outcome(() => approveShowcaseVersionAction(form({ versionId: 'v-2' })));
    const { toggleSchedulerAction } = await import('../app/operations-settings/actions');
    await outcome(() => toggleSchedulerAction(form({ job: 'entitlement-renewal', enabled: 'false' })));
    expect(writes()).toHaveLength(3);
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

  it('the mint action hands out a proof only for a known key and a session', async () => {
    expect(await mintConfirmationProof('credits.grant')).toEqual(expect.stringMatching(/^[\w-]+\.[\w-]+$/));
    expect(await mintConfirmationProof('not-a-key')).toBeNull();
    cookieValue = null;
    expect(await mintConfirmationProof('credits.grant')).toBeNull();
  });
});

// ─────────────────────────── coverage ───────────────────────────

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
    expect(dialogs).toBeGreaterThanOrEqual(37);
  });

  it('every key is used by a dialog and checked by an action before it writes', () => {
    const dialogs = tsx.map((path) => read(path)).join('\n');
    for (const key of CONFIRMATION_PROOF_KEYS) {
      expect(dialogs, `no dialog asks for ${key}`).toContain(`proof="${key}"`);
      expect(actions, `no action checks ${key}`).toContain(`'${key}'`);
    }
  });

  it('no action trusts a fixed confirmation value any more', () => {
    expect(actions).not.toMatch(/readString\(formData, 'confirm'\)/);
  });
});
