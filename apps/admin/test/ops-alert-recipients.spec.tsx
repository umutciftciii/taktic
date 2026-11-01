import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class Redirect extends Error {
  readonly digest: string;
  constructor(readonly url: string) {
    super('NEXT_REDIRECT');
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

// A signed-in staff session, so the real confirmation proofs mint and verify;
// `set` is watched so a reveal is shown never to write a cookie.
const session = vi.hoisted(() => ({ cookieSet: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    toString: () => '',
    get: (name: string) => (name === 'taktic_session' ? { name, value: 'staff-session' } : undefined),
    set: session.cookieSet,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  useRouter: () => ({ replace: () => undefined, push: () => undefined, refresh: () => undefined }),
  usePathname: () => '/system-health/notification-settings',
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: cache.revalidatePath }));

const api = vi.hoisted(() => ({
  held: new Set<string>(),
  isSuperAdmin: false,
  listOpsAlertRecipients: vi.fn(),
  getOpsAlertRouting: vi.fn(),
  getOpsAlertRecipientsAudit: vi.fn(),
  createOpsAlertRecipient: vi.fn(),
  updateOpsAlertRecipient: vi.fn(),
  pauseOpsAlertRecipient: vi.fn(),
  resumeOpsAlertRecipient: vi.fn(),
  deleteOpsAlertRecipient: vi.fn(),
  replaceOpsAlertRecipientAddress: vi.fn(),
  revealOpsAlertRecipient: vi.fn(),
  testOpsAlertRecipient: vi.fn(),
  importOpsAlertEnvRecipient: vi.fn(),
  previewOpsAlertCutover: vi.fn(),
  applyOpsAlertCutover: vi.fn(),
  previewOpsAlertRevert: vi.fn(),
  applyOpsAlertRevert: vi.fn(),
  rewrapOpsAlertRecipients: vi.fn(),
  rehashOpsAlertRecipients: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  requireAdmin: async (...required: string[]) => {
    const can = (...names: string[]) => api.isSuperAdmin || names.every((name) => api.held.has(name));
    if (required.length > 0 && !can(...required)) throw new Redirect('/yetkisiz');
    return { user: { id: 'u-1' }, isSuperAdmin: api.isSuperAdmin, permissions: [...api.held], can };
  },
  listOpsAlertRecipients: api.listOpsAlertRecipients,
  getOpsAlertRouting: api.getOpsAlertRouting,
  getOpsAlertRecipientsAudit: api.getOpsAlertRecipientsAudit,
  createOpsAlertRecipient: api.createOpsAlertRecipient,
  updateOpsAlertRecipient: api.updateOpsAlertRecipient,
  pauseOpsAlertRecipient: api.pauseOpsAlertRecipient,
  resumeOpsAlertRecipient: api.resumeOpsAlertRecipient,
  deleteOpsAlertRecipient: api.deleteOpsAlertRecipient,
  replaceOpsAlertRecipientAddress: api.replaceOpsAlertRecipientAddress,
  revealOpsAlertRecipient: api.revealOpsAlertRecipient,
  testOpsAlertRecipient: api.testOpsAlertRecipient,
  importOpsAlertEnvRecipient: api.importOpsAlertEnvRecipient,
  previewOpsAlertCutover: api.previewOpsAlertCutover,
  applyOpsAlertCutover: api.applyOpsAlertCutover,
  previewOpsAlertRevert: api.previewOpsAlertRevert,
  applyOpsAlertRevert: api.applyOpsAlertRevert,
  rewrapOpsAlertRecipients: api.rewrapOpsAlertRecipients,
  rehashOpsAlertRecipients: api.rehashOpsAlertRecipients,
}));

import { ApiError, adminPermissionLabel } from '../lib/api';
import {
  CONFIRMATION_PROOF_KEYS,
  OPS_ALERT_RECIPIENT_DELETE,
  OPS_ALERT_RECIPIENT_LAST_CRITICAL,
  OPS_ALERT_RECIPIENT_PAUSE,
  OPS_ALERT_RECIPIENT_REPLACE,
  OPS_ALERT_RECIPIENT_REVEAL,
  OPS_ALERT_ROUTING_CUTOVER,
  OPS_ALERT_ROUTING_REVERT,
  OPS_ALERT_ROUTING_REWRAP,
  isConfirmationProofKey,
} from '../lib/confirmation-proof-keys';
import { groupPermissions } from '../lib/permission-groups';
import {
  RECIPIENT_ERROR_TEXT,
  RECIPIENT_STATUS_LABELS,
  recipientDeliverySummary,
} from '../lib/ops-alert-recipients';
import type { OpsAlertView } from '../lib/system-health';

/**
 * Every code the ops-alerts API can put in front of an operator: the HTTP
 * refusals (ops-alert-http-errors.ts: conflicts, routing blockers, 404, 429,
 * 400) and the delivery codes a recipient's `lastErrorCode` can carry
 * (ops-alert-delivery.worker.ts, notification-errors.ts, telegram port,
 * recipients service test result).
 */
const HTTP_CODES = [
  'RECIPIENT_LIMIT',
  'RECIPIENT_DUPLICATE',
  'VERSION_CONFLICT',
  'LAST_CRITICAL_CONFIRM_REQUIRED',
  'LAST_CHANNEL_PROTECTED',
  'RECIPIENT_DELETED',
  'DECRYPT_FAILED',
  'COUNTS_CHANGED',
  'CONFIRM_CANCEL_REQUIRED',
  'ENV_ADDRESS_MISSING',
  'RECIPIENT_BUSY',
  'NO_LIVE_CRITICAL_CHANNEL',
  'LEGACY_ROWS_UNMATCHED',
  'ROUTING_COLLISION_PENDING',
  'ALREADY_IN_MODE',
  'RECIPIENT_NOT_FOUND',
  'TEST_RATE_LIMITED',
  'RECIPIENT_ADDRESS_INVALID',
];
const DELIVERY_CODES = [
  'RECIPIENT_REMOVED',
  'RECIPIENT_PAUSED',
  'PREFERENCE_OFF',
  'LEGACY_AFTER_CUTOVER',
  'ROUTING_REVERTED',
  'LEASE_EXPIRED',
  'NOT_CONFIGURED',
  'RATE_LIMITED',
  'TRANSPORT_UNAVAILABLE',
  'REJECTED',
  'TIMEOUT',
  'INVALID_RECIPIENT',
  'EMAIL_BRANDING_INCOMPLETE',
  'EMAIL_PUBLIC_URL_INVALID',
  'SOURCE_UNAVAILABLE',
  'RECIPIENT_RELEASED',
  'UNKNOWN',
];

describe('RECIPIENT_ERROR_TEXT', () => {
  it.each([...HTTP_CODES, ...DELIVERY_CODES])('%s has Turkish text', (code) => {
    expect(RECIPIENT_ERROR_TEXT[code]?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('never carries an address, a count placeholder or a key', () => {
    for (const text of Object.values(RECIPIENT_ERROR_TEXT)) expect(text).not.toMatch(/@|\{|\d/);
  });
});

describe('RECIPIENT_STATUS_LABELS', () => {
  it('names every status', () => {
    expect(Object.keys(RECIPIENT_STATUS_LABELS).sort()).toEqual(['ACTIVE', 'DELETED', 'PAUSED']);
    for (const label of Object.values(RECIPIENT_STATUS_LABELS)) expect(label.length).toBeGreaterThan(0);
  });
});

describe('recipientDeliverySummary', () => {
  type D = OpsAlertView['deliveries'][number];
  let n = 0;
  const row = (over: Partial<D> = {}): D => ({
    kind: 'OPENED',
    sequence: 1,
    channel: 'EMAIL',
    status: 'SENT',
    attemptCount: 1,
    sentAt: null,
    errorCode: null,
    recipientId: `r${n++}`,
    recipientLabel: 'Nöbetçi',
    ...over,
  });

  it('says there is no channel when the alert has no delivery', () => {
    expect(recipientDeliverySummary([])).toBe('Kanal yok');
  });

  it('one recipient: the delivery state, as the single-address summary words it', () => {
    expect(recipientDeliverySummary([row()])).toBe('E-posta: Yeni sorun — Gönderildi');
    expect(recipientDeliverySummary([row({ status: 'FAILED', attemptCount: 2 })])).toBe('E-posta: Yeni sorun — Yeniden denenecek (2. deneme)');
  });

  it('several recipients: sent of all, and what is still retried', () => {
    const rows = [row(), row(), row({ status: 'FAILED' })];
    expect(recipientDeliverySummary(rows)).toBe('E-posta: Yeni sorun — 2/3 gönderildi, 1 yeniden denenecek');
  });

  it('counts waiting, abandoned and cancelled rows; a cancelled row is not an unsent one', () => {
    const rows = [
      row({ kind: 'RESOLVED', sequence: 2 }),
      row({ kind: 'RESOLVED', sequence: 2, status: 'PENDING' }),
      row({ kind: 'RESOLVED', sequence: 2, status: 'SENDING' }),
      row({ kind: 'RESOLVED', sequence: 2, status: 'ABANDONED' }),
      row({ kind: 'RESOLVED', sequence: 2, status: 'CANCELLED' }),
    ];
    expect(recipientDeliverySummary(rows)).toBe('E-posta: Düzelme — 1/4 gönderildi, 2 bekliyor, 1 gönderilemedi, 1 iptal');
  });

  it('only the latest notice of a channel is summarised', () => {
    const rows = [row({ sequence: 1 }), row({ sequence: 1 }), row({ kind: 'REMINDER', sequence: 2, status: 'FAILED' })];
    expect(recipientDeliverySummary(rows)).toBe('E-posta: Hatırlatma — Yeniden denenecek');
  });

  it('a legacy (OPS_ALERT_EMAIL) row beside managed ones is named apart', () => {
    const rows = [row(), row({ recipientId: null, recipientLabel: null })];
    expect(recipientDeliverySummary(rows)).toBe('E-posta: Yeni sorun — 2/2 gönderildi, 1 eski adres');
  });

  it('a notice whose every row was cancelled has no "0/0": only the cancellations are named', () => {
    const rows = [row({ status: 'CANCELLED' }), row({ status: 'CANCELLED' })];
    expect(recipientDeliverySummary(rows)).toBe('E-posta: Yeni sorun — 2 iptal');
  });

  it('a lone legacy row reads like any single delivery', () => {
    expect(recipientDeliverySummary([row({ recipientId: null, recipientLabel: null })])).toBe('E-posta: Yeni sorun — Gönderildi');
  });

  it('joins channels, Telegram first', () => {
    const rows = [row(), row({ channel: 'TELEGRAM', recipientId: null, recipientLabel: null })];
    expect(recipientDeliverySummary(rows)).toBe('Telegram: Yeni sorun — Gönderildi · E-posta: Yeni sorun — Gönderildi');
  });
});

describe('confirmation proof keys', () => {
  const keys = [
    OPS_ALERT_RECIPIENT_PAUSE,
    OPS_ALERT_RECIPIENT_DELETE,
    OPS_ALERT_RECIPIENT_REPLACE,
    OPS_ALERT_RECIPIENT_REVEAL,
    OPS_ALERT_RECIPIENT_LAST_CRITICAL,
    OPS_ALERT_ROUTING_CUTOVER,
    OPS_ALERT_ROUTING_REVERT,
    OPS_ALERT_ROUTING_REWRAP,
  ];

  it('are eight distinct, mintable keys listed exactly once', () => {
    expect(new Set(keys).size).toBe(8);
    for (const key of keys) {
      expect(isConfirmationProofKey(key)).toBe(true);
      expect(CONFIRMATION_PROOF_KEYS.filter((k) => k === key)).toHaveLength(1);
    }
  });
});

describe('permission labels', () => {
  const OPS = [
    'OPS_ALERT_RECIPIENTS_READ',
    'OPS_ALERT_RECIPIENTS_WRITE',
    'OPS_ALERT_RECIPIENTS_DELETE',
    'OPS_ALERT_RECIPIENTS_REVEAL',
    'OPS_ALERT_RECIPIENTS_TEST',
    'OPS_ALERT_ROUTING_MANAGE',
  ] as const;

  it('puts the six alert permissions in "Operasyon alarmları", each exactly once', () => {
    const groups = groupPermissions([...OPS] as never);
    const area = groups.filter((g) => g.area === 'Operasyon alarmları');
    expect(area).toHaveLength(1);
    expect(area[0]!.items.map((i) => i.permission)).toEqual([...OPS]);
    expect(groups.flatMap((g) => g.items).filter((i) => (OPS as readonly string[]).includes(i.permission))).toHaveLength(6);
  });

  it('says that revealing an address is a SUPER_ADMIN act', () => {
    expect(adminPermissionLabel('OPS_ALERT_RECIPIENTS_REVEAL' as never).action).toContain('SUPER_ADMIN');
  });
});


// ---------------------------------------------------------------------------
// OBS-ALERT-002 PR-B (task B2) — Bildirim Ayarları page, form and actions
// ---------------------------------------------------------------------------

const { default: NotificationSettingsPage } = await import('../app/system-health/notification-settings/page');
const { RecipientForm } = await import('../app/system-health/notification-settings/recipient-form');
const settingsActions = await import('../app/system-health/notification-settings/actions');

import type { RecipientAuditEntry, RecipientView, RoutingState } from '../lib/ops-alert-recipients';

const NOW = '2026-11-02T09:00:00.000Z';

function recipient(over: Partial<RecipientView> = {}): RecipientView {
  return {
    id: 'rcp-1',
    label: 'Nöbetçi mühendis',
    maskedAddress: 'o***@example.test',
    notifyWarning: false,
    notifyCritical: true,
    notifyRecovery: true,
    status: 'ACTIVE',
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    lastSentAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    keyId: 'k1',
    isLastCritical: false,
    ...over,
  };
}

function routing(over: Partial<RoutingState> = {}): RoutingState {
  return {
    emailRouting: 'MANAGED',
    changedAt: NOW,
    envAddressConfigured: true,
    envAddressManaged: true,
    activeRecipients: 1,
    liveCritical: 1,
    telegramConfigured: true,
    keyIds: { k1: 1 },
    hmacVersions: { '1': 1 },
    ...over,
  };
}

const auditPage = (items: RecipientAuditEntry[] = []) => ({ items, total: items.length, page: 1, pageSize: 20, hasNextPage: false });

function auditEntry(over: Partial<RecipientAuditEntry> = {}): RecipientAuditEntry {
  return {
    id: 'a-1',
    domain: 'OPS_ALERT_RECIPIENT',
    action: 'CREATED',
    actor: { id: 'u-1', name: 'Ayşe Yönetici' },
    target: { type: 'OPS_ALERT_RECIPIENT', id: 'rcp-1' },
    changes: [{ field: 'label', from: null, to: 'Nöbetçi mühendis' }],
    reason: null,
    createdAt: NOW,
    ...over,
  };
}

const READ = 'OPS_ALERT_RECIPIENTS_READ';
const WRITE = 'OPS_ALERT_RECIPIENTS_WRITE';

function load(opts: { recipients?: RecipientView[]; routing?: Partial<RoutingState>; audit?: RecipientAuditEntry[] } = {}) {
  api.listOpsAlertRecipients.mockResolvedValue(opts.recipients ?? [recipient()]);
  api.getOpsAlertRouting.mockResolvedValue(routing(opts.routing));
  api.getOpsAlertRecipientsAudit.mockResolvedValue(auditPage(opts.audit));
}

async function renderSettings(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await NotificationSettingsPage({ searchParams: Promise.resolve(params) }));
}

function conflict(status: number, code: string) {
  return new ApiError(status, JSON.stringify({ statusCode: status, code, message: 'x' }));
}

beforeEach(() => {
  api.held = new Set([READ]);
  api.isSuperAdmin = false;
  for (const fn of [
    api.listOpsAlertRecipients,
    api.getOpsAlertRouting,
    api.getOpsAlertRecipientsAudit,
    api.createOpsAlertRecipient,
    api.updateOpsAlertRecipient,
    api.pauseOpsAlertRecipient,
    api.resumeOpsAlertRecipient,
    api.deleteOpsAlertRecipient,
    api.replaceOpsAlertRecipientAddress,
    api.revealOpsAlertRecipient,
    api.testOpsAlertRecipient,
    api.importOpsAlertEnvRecipient,
    api.previewOpsAlertCutover,
    api.applyOpsAlertCutover,
    api.previewOpsAlertRevert,
    api.applyOpsAlertRevert,
    api.rewrapOpsAlertRecipients,
    api.rehashOpsAlertRecipients,
    session.cookieSet,
    cache.revalidatePath,
  ]) {
    fn.mockReset();
  }
});

describe('Bildirim Ayarları page', () => {
  it('asks for OPS_ALERT_RECIPIENTS_READ and sends everyone else to /yetkisiz', async () => {
    load();
    api.held = new Set();
    await expect(renderSettings()).rejects.toMatchObject({ url: '/yetkisiz' });
    expect(api.listOpsAlertRecipients).not.toHaveBeenCalled();
  });

  it('has no loading.tsx above its query window', () => {
    expect(existsSync(resolve(__dirname, '../app/system-health/notification-settings/loading.tsx'))).toBe(false);
  });

  it('shows the ENV_LEGACY notice above the table, and none when routing is managed', async () => {
    load({ routing: { emailRouting: 'ENV_LEGACY' } });
    const legacy = await renderSettings();
    expect(legacy).toContain('data-testid="ops-alert-env-legacy-notice"');
    expect(legacy).toContain('Bu alıcılar geçiş yapılana kadar bildirim almaz; şu an bildirimler OPS_ALERT_EMAIL adresine gidiyor.');
    expect(legacy).toContain('Env (geçiş öncesi)');
    load();
    const managed = await renderSettings();
    expect(managed).not.toContain('ops-alert-env-legacy-notice');
    expect(managed).toContain('Yönetilen');
  });

  it('status strip: x/10 recipients, Telegram state, key versions only when there are several', async () => {
    load({ recipients: [recipient(), recipient({ id: 'rcp-2' })] });
    const one = await renderSettings();
    expect(one).toContain('2/10 alıcı');
    expect(one).toContain('Telegram: tanımlı');
    expect(one).not.toContain('ops-alert-key-versions');

    load({ routing: { telegramConfigured: false, keyIds: { k1: 1, k2: 1 }, hmacVersions: { '1': 2 } } });
    const several = await renderSettings();
    expect(several).toContain('Telegram: tanımlı değil');
    expect(several).toContain('data-testid="ops-alert-key-versions"');
    expect(several).toContain('k1: 1');
    expect(several).toContain('k2: 1');
  });

  it('lists label, masked address, the three switches, status and delivery state', async () => {
    load({
      recipients: [
        recipient({
          lastSentAt: NOW,
          lastErrorCode: 'TIMEOUT',
          consecutiveFailures: 2,
          status: 'PAUSED',
        }),
      ],
    });
    const markup = await renderSettings();
    for (const heading of ['Etiket', 'Adres', 'Uyarı', 'Kritik', 'Düzelme', 'Durum', 'Son gönderim', 'Son hata']) {
      expect(markup).toContain(heading);
    }
    expect(markup).toContain('Nöbetçi mühendis');
    expect(markup).toContain('o***@example.test');
    expect(markup).toContain('Duraklatıldı');
    expect(markup).toContain('Zaman aşımı.');
    expect(markup).toContain('2 ardışık hata');
    const row = markup.slice(markup.indexOf('data-testid="ops-alert-recipient-row"'));
    expect(row).toMatch(/data-testid="ops-alert-toggle-notifyWarning"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-testid="ops-alert-toggle-notifyWarning"/);
    expect(row).toMatch(/aria-checked="true"[^>]*data-testid="ops-alert-toggle-notifyCritical"|data-testid="ops-alert-toggle-notifyCritical"[^>]*aria-checked="true"/);
  });

  it('draws only the masked address, in the list and in the edit dialog', async () => {
    load({ recipients: [recipient({ maskedAddress: 'o***@example.test' })] });
    const list = await renderSettings();
    api.held = new Set([READ, WRITE]);
    const editing = await renderSettings({ alici: 'rcp-1' });
    for (const html of [list, editing]) {
      expect(html).toContain('o***@example.test');
      expect(html).not.toContain('ops@example.test');
    }
  });

  it('a read-only account sees disabled switches, no add link, no edit link, and the form is never drawn', async () => {
    load();
    const markup = await renderSettings({ alici: 'yeni' });
    const switches = markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches.length).toBe(3);
    for (const sw of switches) expect(sw).toContain('disabled');
    expect(markup).not.toContain('ops-alert-recipient-add');
    expect(markup).not.toContain('ops-alert-recipient-edit');
    expect(markup).not.toContain('ops-alert-recipient-dialog');
  });

  it('a writer gets "Alıcı ekle" and a row edit link; at 10/10 the add control is disabled with its reason', async () => {
    api.held = new Set([READ, WRITE]);
    load();
    const open = await renderSettings();
    expect(open).toMatch(/<a[^>]*href="[^"]*alici=yeni"[^>]*data-testid="ops-alert-recipient-add"|<a[^>]*data-testid="ops-alert-recipient-add"[^>]*href="[^"]*alici=yeni"/);
    expect(open).toContain('data-testid="ops-alert-recipient-edit"');
    expect(open).not.toContain('ops-alert-recipient-add-reason');

    load({ recipients: Array.from({ length: 10 }, (_, i) => recipient({ id: `r${i}` })) });
    const full = await renderSettings();
    expect(full).toContain('10/10 alıcı');
    expect(full).toMatch(/<button[^>]*disabled[^>]*data-testid="ops-alert-recipient-add"|<button[^>]*data-testid="ops-alert-recipient-add"[^>]*disabled/);
    expect(full).not.toMatch(/<a[^>]*alici=yeni/);
    expect(full).toContain('data-testid="ops-alert-recipient-add-reason"');
    expect(full).toContain('En fazla 10 alıcı');
  });

  it('?alici=yeni opens the add dialog: Kritik + Düzelme on, Uyarı off, address typed here', async () => {
    api.held = new Set([READ, WRITE]);
    load();
    const markup = await renderSettings({ alici: 'yeni' });
    expect(markup).toContain('data-testid="ops-alert-recipient-dialog"');
    expect(markup).toContain('name="address"');
    expect(markup).toContain('<input type="hidden" name="notifyWarning" value="false"/>');
    expect(markup).toContain('<input type="hidden" name="notifyCritical" value="true"/>');
    expect(markup).toContain('<input type="hidden" name="notifyRecovery" value="true"/>');
  });

  it('?alici=<id> opens the edit dialog with the version and the masked address, and no address field', async () => {
    api.held = new Set([READ, WRITE]);
    load();
    const markup = await renderSettings({ alici: 'rcp-1' });
    expect(markup).toContain('<input type="hidden" name="version" value="3"/>');
    expect(markup).toContain('<input type="hidden" name="recipientId" value="rcp-1"/>');
    expect(markup).toContain('value="Nöbetçi mühendis"');
    expect(markup).not.toContain('name="address"');
    expect(markup).toContain('o***@example.test');
  });

  it('?alici=yeni at 10/10 says why no add window opens, instead of drawing nothing', async () => {
    api.held = new Set([READ, WRITE]);
    load({ recipients: Array.from({ length: 10 }, (_, i) => recipient({ id: `r${i}` })) });
    const markup = await renderSettings({ alici: 'yeni' });
    expect(markup).not.toContain('ops-alert-recipient-form');
    expect(markup).toContain('data-testid="ops-alert-recipient-limit-notice"');
    expect(markup).toContain('En fazla 10 alıcı eklenebilir; yeni alıcı için önce birini silin.');
    load();
    expect(await renderSettings({ alici: 'yeni' })).not.toContain('ops-alert-recipient-limit-notice');
  });

  it('remounts the edit form when the edited recipient changes (no state carried across ids)', () => {
    expect(readFileSync(resolve(__dirname, '../app/system-health/notification-settings/page.tsx'), 'utf8')).toMatch(
      /<RecipientForm\s+key=\{editing\.id\}/,
    );
  });

  it('an unknown ?alici= says the recipient is gone instead of drawing a form', async () => {
    api.held = new Set([READ, WRITE]);
    load();
    const markup = await renderSettings({ alici: 'nope' });
    expect(markup).toContain('data-testid="ops-alert-recipient-missing"');
    expect(markup).not.toContain('ops-alert-recipient-form');
  });

  it('shows the recipient history in an audit timeline, naming the recipient by label', async () => {
    load({ audit: [auditEntry({ action: 'PAUSED', changes: [{ field: 'status', from: 'ACTIVE', to: 'PAUSED' }] })] });
    const markup = await renderSettings();
    expect(markup).toContain('data-testid="ops-alert-audit"');
    expect(markup).toContain('Duraklatıldı');
    expect(markup).toContain('Etkin');
    expect(markup).toContain('Nöbetçi mühendis');
    expect(markup).toContain('Ayşe Yönetici');
  });

  it('draws the page notices for a stale write and for a success', async () => {
    load();
    expect(await renderSettings({ error: 'versionConflict' })).toContain('data-testid="ops-alert-recipients-error"');
    expect(await renderSettings({ ok: 'created' })).toContain('data-testid="ops-alert-recipients-ok"');
  });
});

describe('RecipientForm', () => {
  it('the add form starts with Kritik and Düzelme on, Uyarı off, switches enabled', () => {
    const markup = renderToStaticMarkup(<RecipientForm mode={{ kind: 'create' }} cancelHref="/x" />);
    expect(markup).toMatch(/aria-checked="false"[^>]*data-testid="ops-alert-form-notifyWarning"|data-testid="ops-alert-form-notifyWarning"[^>]*aria-checked="false"/);
    expect(markup).toMatch(/aria-checked="true"[^>]*data-testid="ops-alert-form-notifyCritical"|data-testid="ops-alert-form-notifyCritical"[^>]*aria-checked="true"/);
    expect(markup).toMatch(/aria-checked="true"[^>]*data-testid="ops-alert-form-notifyRecovery"|data-testid="ops-alert-form-notifyRecovery"[^>]*aria-checked="true"/);
    expect(markup).not.toMatch(/<button[^>]*role="switch"[^>]*disabled/);
  });
});

describe('recipient server actions', () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const idle = { kind: 'idle' } as const;

  it('create sends the typed address, label and switches and redirects with ok=created', async () => {
    api.createOpsAlertRecipient.mockResolvedValue(recipient());
    await expect(
      settingsActions.createRecipientAction(
        idle,
        form({ address: 'ops@example.test', label: '  Nöbetçi  ', notifyWarning: 'false', notifyCritical: 'true', notifyRecovery: 'true' }),
      ),
    ).rejects.toMatchObject({ url: '/system-health/notification-settings?ok=created' });
    expect(api.createOpsAlertRecipient).toHaveBeenCalledWith({
      address: 'ops@example.test',
      label: 'Nöbetçi',
      notifyWarning: false,
      notifyCritical: true,
      notifyRecovery: true,
    });
  });

  it('create maps the API refusals to the form state, without echoing the address', async () => {
    api.createOpsAlertRecipient.mockRejectedValue(conflict(409, 'RECIPIENT_LIMIT'));
    const limit = await settingsActions.createRecipientAction(idle, form({ address: 'ops@example.test', label: 'A' }));
    expect(limit).toMatchObject({ kind: 'error', code: 'RECIPIENT_LIMIT', message: RECIPIENT_ERROR_TEXT.RECIPIENT_LIMIT });

    api.createOpsAlertRecipient.mockRejectedValue(conflict(400, 'RECIPIENT_ADDRESS_INVALID'));
    const invalid = await settingsActions.createRecipientAction(idle, form({ address: 'ops@example.test', label: 'A' }));
    expect(invalid).toMatchObject({ kind: 'error', field: 'address', message: RECIPIENT_ERROR_TEXT.RECIPIENT_ADDRESS_INVALID });
    expect(JSON.stringify(invalid)).not.toContain('ops@example.test');

    api.createOpsAlertRecipient.mockRejectedValue(conflict(409, 'RECIPIENT_DUPLICATE'));
    const duplicate = await settingsActions.createRecipientAction(idle, form({ address: 'ops@example.test', label: 'A' }));
    expect(duplicate).toMatchObject({ kind: 'error', field: 'address' });
  });

  it('create refuses an empty label or address before calling the API', async () => {
    const result = await settingsActions.createRecipientAction(idle, form({ address: '', label: '' }));
    expect(result).toMatchObject({ kind: 'error' });
    expect(api.createOpsAlertRecipient).not.toHaveBeenCalled();
  });

  it('edit sends the version it was drawn with', async () => {
    api.updateOpsAlertRecipient.mockResolvedValue(recipient());
    await expect(
      settingsActions.updateRecipientAction(
        idle,
        form({ recipientId: 'rcp-1', version: '3', label: 'Yeni ad', notifyWarning: 'true', notifyCritical: 'true', notifyRecovery: 'false' }),
      ),
    ).rejects.toMatchObject({ url: '/system-health/notification-settings?ok=updated' });
    expect(api.updateOpsAlertRecipient).toHaveBeenCalledWith('rcp-1', {
      version: 3,
      label: 'Yeni ad',
      notifyWarning: true,
      notifyCritical: true,
      notifyRecovery: false,
    });
  });

  it('edit maps VERSION_CONFLICT (and a deleted or missing recipient) to a page notice, not an error page', async () => {
    const send = () =>
      settingsActions.updateRecipientAction(idle, form({ recipientId: 'rcp-1', version: '3', label: 'A', notifyWarning: 'false', notifyCritical: 'true', notifyRecovery: 'true' }));
    api.updateOpsAlertRecipient.mockRejectedValue(conflict(409, 'VERSION_CONFLICT'));
    await expect(send()).rejects.toMatchObject({ url: '/system-health/notification-settings?error=versionConflict' });
    api.updateOpsAlertRecipient.mockRejectedValue(conflict(409, 'RECIPIENT_DELETED'));
    await expect(send()).rejects.toMatchObject({ url: '/system-health/notification-settings?error=deleted' });
    api.updateOpsAlertRecipient.mockRejectedValue(conflict(404, 'RECIPIENT_NOT_FOUND'));
    await expect(send()).rejects.toMatchObject({ url: '/system-health/notification-settings?error=notFound' });
  });

  it('edit turns the last-critical refusal into the second, separate confirmation step', async () => {
    api.updateOpsAlertRecipient.mockRejectedValue(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    const result = await settingsActions.updateRecipientAction(
      idle,
      form({ recipientId: 'rcp-1', version: '3', label: 'A', notifyWarning: 'false', notifyCritical: 'false', notifyRecovery: 'true' }),
    );
    expect(result).toMatchObject({ kind: 'last-critical' });
  });
});

describe('audit entries of the recipient domain', () => {
  it('are titled in Turkish, with field labels and status words, and the test result translated', async () => {
    const { describeAuditEntry } = await import('../components/audit-timeline');
    const titles = {
      CREATED: 'Alıcı eklendi',
      IMPORTED_FROM_ENV: 'OPS_ALERT_EMAIL adresi alıcı olarak içe aktarıldı',
      LABEL_CHANGED: 'Etiket değişti',
      PREFERENCES_CHANGED: 'Bildirim tercihleri değişti',
      PAUSED: 'Alıcı duraklatıldı',
      RESUMED: 'Alıcı yeniden etkinleştirildi',
      DELETED: 'Alıcı silindi',
      ADDRESS_REPLACED: 'Adres değiştirildi',
      REVEALED: 'Adres açık görüntülendi',
      TEST_SENT: 'Test e-postası gönderildi',
      ROUTING_CUTOVER: 'Yönlendirme yönetilen alıcılara geçirildi',
      ROUTING_REVERTED: 'Yönlendirme ortam değişkenine döndürüldü',
      REWRAPPED: 'Şifreleme anahtarı yenilendi',
      REHASHED: 'Adres özeti yenilendi',
    };
    for (const [action, title] of Object.entries(titles)) {
      expect(describeAuditEntry(auditEntry({ action, changes: [] })).title).toBe(title);
    }
    const test = describeAuditEntry(auditEntry({ action: 'TEST_SENT', changes: [{ field: 'result', from: null, to: 'TIMEOUT' }] }));
    expect(renderToStaticMarkup(<>{test.note}</>)).toContain('Zaman aşımı.');
  });
});

// ---------------------------------------------------------------------------
// OBS-ALERT-002 PR-B (task B3) — row actions, confirmation gates and proofs
// ---------------------------------------------------------------------------

const { issueConfirmationProof } = await import('../lib/confirmation-proof-server');
const { CONFIRMATION_PROOF_FIELD, CONFIRMATION_PROOF_REFUSAL_MESSAGE } = await import('../lib/confirmation-proof-keys');
const { LastCriticalStep } = await import('../app/system-health/notification-settings/last-critical-step');
const { LAST_CRITICAL_WARNING, LAST_CHANNEL_PROTECTED_TEXT, RECIPIENT_ACTION_IDLE } = await import(
  '../app/system-health/notification-settings/recipient-action-state'
);

const DELETE = 'OPS_ALERT_RECIPIENTS_DELETE';
const TEST = 'OPS_ALERT_RECIPIENTS_TEST';
const REVEAL = 'OPS_ALERT_RECIPIENTS_REVEAL';
const SETTINGS = '/system-health/notification-settings';
const FULL_ADDRESS = 'oncall@example.test';

/** The form as a submission sends it; each proof is one `__confirmationProof` value. */
function submission(fields: Record<string, string>, proofs: Array<string | null> = []): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const proof of proofs) if (proof) data.append(CONFIRMATION_PROOF_FIELD, proof);
  return data;
}

async function settle(run: () => Promise<unknown>): Promise<{ redirect?: string; value?: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    if (error instanceof Redirect) return { redirect: error.url };
    throw error;
  }
}

const mint = (key: Parameters<typeof issueConfirmationProof>[0]) => issueConfirmationProof(key);

type GuardedCase = {
  name: string;
  /** Every proof this submission needs, in order. */
  keys: Array<Parameters<typeof issueConfirmationProof>[0]>;
  write: ReturnType<typeof vi.fn>;
  run: (proofs: Array<string | null>) => Promise<unknown>;
};

const BASE = { recipientId: 'rcp-1', version: '3' };
const PREFS_OFF = { label: 'Nöbetçi', notifyWarning: 'false', notifyCritical: 'false', notifyRecovery: 'true' };

const GUARDED: GuardedCase[] = [
  {
    name: 'Duraklat',
    keys: ['ops-alert-recipient.pause'],
    write: api.pauseOpsAlertRecipient,
    run: (proofs) => settingsActions.pauseRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE, proofs)),
  },
  {
    name: 'Duraklat — son kritik alıcı onayıyla',
    keys: ['ops-alert-recipient.pause', 'ops-alert-recipient.last-critical'],
    write: api.pauseOpsAlertRecipient,
    run: (proofs) =>
      settingsActions.pauseRecipientAction(RECIPIENT_ACTION_IDLE, submission({ ...BASE, confirmLastCritical: 'true' }, proofs)),
  },
  {
    name: 'Sil',
    keys: ['ops-alert-recipient.delete'],
    write: api.deleteOpsAlertRecipient,
    run: (proofs) =>
      settingsActions.deleteRecipientAction(RECIPIENT_ACTION_IDLE, submission({ ...BASE, reason: 'Ekipten ayrıldı' }, proofs)),
  },
  {
    name: 'Sil — son kritik alıcı onayıyla',
    keys: ['ops-alert-recipient.delete', 'ops-alert-recipient.last-critical'],
    write: api.deleteOpsAlertRecipient,
    run: (proofs) =>
      settingsActions.deleteRecipientAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...BASE, reason: 'Ekipten ayrıldı', confirmLastCritical: 'true' }, proofs),
      ),
  },
  {
    name: 'Adresi değiştir',
    keys: ['ops-alert-recipient.replace'],
    write: api.replaceOpsAlertRecipientAddress,
    run: (proofs) =>
      settingsActions.replaceRecipientAddressAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...BASE, address: 'new@example.test', reason: 'Adres değişti' }, proofs),
      ),
  },
  {
    name: 'Göster',
    keys: ['ops-alert-recipient.reveal'],
    write: api.revealOpsAlertRecipient,
    run: (proofs) => settingsActions.revealRecipientAction(submission({ recipientId: 'rcp-1' }, proofs)),
  },
  {
    name: 'Düzenle — son kritik alıcının Kritik bildirimini kapatma onayıyla',
    keys: ['ops-alert-recipient.last-critical'],
    write: api.updateOpsAlertRecipient,
    run: (proofs) =>
      settingsActions.updateRecipientAction(
        { kind: 'idle' },
        submission({ ...BASE, ...PREFS_OFF, confirmLastCritical: 'true' }, proofs),
      ),
  },
];

function primeWrites() {
  api.pauseOpsAlertRecipient.mockResolvedValue(recipient({ status: 'PAUSED' }));
  api.deleteOpsAlertRecipient.mockResolvedValue(undefined);
  api.replaceOpsAlertRecipientAddress.mockResolvedValue(recipient({ id: 'rcp-2' }));
  api.revealOpsAlertRecipient.mockResolvedValue({ address: FULL_ADDRESS });
  api.updateOpsAlertRecipient.mockResolvedValue(recipient());
}

describe('recipient actions refuse a submission without its confirmation proof, and write nothing', () => {
  for (const testCase of GUARDED) {
    describe(testCase.name, () => {
      it('no proof (a click before hydration, JavaScript off) is refused', async () => {
        primeWrites();
        const result = await settle(() => testCase.run([]));
        expect(JSON.stringify(result.value)).toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
        expect(testCase.write).not.toHaveBeenCalled();
      });

      it('a made-up proof, a static value, or a proof for another confirmation is refused', async () => {
        primeWrites();
        for (const forged of ['yes', 'true', 'eyJrIjoieCJ9.Zm9yZ2Vk']) {
          expect(JSON.stringify((await settle(() => testCase.run(testCase.keys.map(() => forged)))).value)).toContain(
            CONFIRMATION_PROOF_REFUSAL_MESSAGE,
          );
        }
        const otherKey = testCase.keys.includes('ops-alert-recipient.replace') ? 'ops-alert-recipient.delete' : 'ops-alert-recipient.replace';
        const wrong = await Promise.all(testCase.keys.map(() => mint(otherKey)));
        expect(JSON.stringify((await settle(() => testCase.run(wrong))).value)).toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
        expect(testCase.write).not.toHaveBeenCalled();
      });

      if (testCase.keys.length > 1) {
        it('each of its proofs is needed: one alone is refused', async () => {
          primeWrites();
          for (const key of testCase.keys) {
            expect(JSON.stringify((await settle(async () => testCase.run([await mint(key)]))).value)).toContain(
              CONFIRMATION_PROOF_REFUSAL_MESSAGE,
            );
          }
          expect(testCase.write).not.toHaveBeenCalled();
        });
      }

      it('real proofs go through once; a replay of them is refused', async () => {
        primeWrites();
        const proofs = await Promise.all(testCase.keys.map((key) => mint(key)));
        const first = await settle(() => testCase.run(proofs));
        expect(JSON.stringify(first)).not.toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
        expect(testCase.write).toHaveBeenCalledTimes(1);
        const replay = await settle(() => testCase.run(proofs));
        expect(JSON.stringify(replay.value)).toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
        expect(testCase.write).toHaveBeenCalledTimes(1);
      });
    });
  }

  it('resume and test send are plain submits: no proof asked', async () => {
    api.resumeOpsAlertRecipient.mockResolvedValue(recipient());
    expect((await settle(() => settingsActions.resumeRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE)))).redirect).toBe(
      `${SETTINGS}?ok=resumed`,
    );
    expect(api.resumeOpsAlertRecipient).toHaveBeenCalledWith('rcp-1', { version: 3 });
    api.testOpsAlertRecipient.mockResolvedValue({ result: 'SENT' });
    await settingsActions.testRecipientAction(RECIPIENT_ACTION_IDLE, submission({ recipientId: 'rcp-1' }));
    expect(api.testOpsAlertRecipient).toHaveBeenCalledWith('rcp-1');
  });
});

describe('the last critical recipient: two separate confirmations', () => {
  it('pause: the first confirmed submit meets LAST_CRITICAL_CONFIRM_REQUIRED and asks again; the second carries confirmLastCritical', async () => {
    api.pauseOpsAlertRecipient.mockRejectedValueOnce(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    const first = await settingsActions.pauseRecipientAction(
      RECIPIENT_ACTION_IDLE,
      submission(BASE, [await mint('ops-alert-recipient.pause')]),
    );
    expect(first).toMatchObject({ kind: 'last-critical' });
    expect(api.pauseOpsAlertRecipient).toHaveBeenLastCalledWith('rcp-1', { version: 3 });

    api.pauseOpsAlertRecipient.mockResolvedValueOnce(recipient({ status: 'PAUSED' }));
    const second = await settle(async () =>
      settingsActions.pauseRecipientAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...BASE, confirmLastCritical: 'true' }, [
          await mint('ops-alert-recipient.pause'),
          await mint('ops-alert-recipient.last-critical'),
        ]),
      ),
    );
    expect(second.redirect).toBe(`${SETTINGS}?ok=paused`);
    expect(api.pauseOpsAlertRecipient).toHaveBeenLastCalledWith('rcp-1', { version: 3, confirmLastCritical: true });
  });

  it('delete: the reason travels with both steps', async () => {
    api.deleteOpsAlertRecipient.mockRejectedValueOnce(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    const fields = { ...BASE, reason: '  Ekipten ayrıldı ' };
    expect(
      await settingsActions.deleteRecipientAction(RECIPIENT_ACTION_IDLE, submission(fields, [await mint('ops-alert-recipient.delete')])),
    ).toMatchObject({ kind: 'last-critical' });
    api.deleteOpsAlertRecipient.mockResolvedValueOnce(undefined);
    const second = await settle(async () =>
      settingsActions.deleteRecipientAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...fields, confirmLastCritical: 'true' }, [
          await mint('ops-alert-recipient.delete'),
          await mint('ops-alert-recipient.last-critical'),
        ]),
      ),
    );
    expect(second.redirect).toBe(`${SETTINGS}?ok=deleted`);
    expect(api.deleteOpsAlertRecipient).toHaveBeenLastCalledWith('rcp-1', {
      version: 3,
      reason: 'Ekipten ayrıldı',
      confirmLastCritical: true,
    });
  });

  it('edit (Ruling B-3): turning Kritik off on the last critical recipient asks the same second confirmation', async () => {
    api.updateOpsAlertRecipient.mockRejectedValueOnce(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    expect(await settingsActions.updateRecipientAction({ kind: 'idle' }, submission({ ...BASE, ...PREFS_OFF }))).toMatchObject({
      kind: 'last-critical',
    });
    api.updateOpsAlertRecipient.mockResolvedValueOnce(recipient());
    const second = await settle(async () =>
      settingsActions.updateRecipientAction(
        { kind: 'idle' },
        submission({ ...BASE, ...PREFS_OFF, confirmLastCritical: 'true' }, [await mint('ops-alert-recipient.last-critical')]),
      ),
    );
    expect(second.redirect).toBe(`${SETTINGS}?ok=updated`);
    expect(api.updateOpsAlertRecipient).toHaveBeenLastCalledWith('rcp-1', {
      version: 3,
      label: 'Nöbetçi',
      notifyWarning: false,
      notifyCritical: false,
      notifyRecovery: true,
      confirmLastCritical: true,
    });
  });

  it('LAST_CHANNEL_PROTECTED is a dead end: the state offers no confirmation', async () => {
    api.pauseOpsAlertRecipient.mockRejectedValue(conflict(409, 'LAST_CHANNEL_PROTECTED'));
    expect(
      await settingsActions.pauseRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE, [await mint('ops-alert-recipient.pause')])),
    ).toMatchObject({ kind: 'last-channel' });
    api.deleteOpsAlertRecipient.mockRejectedValue(conflict(409, 'LAST_CHANNEL_PROTECTED'));
    expect(
      await settingsActions.deleteRecipientAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...BASE, reason: 'Ekipten ayrıldı' }, [await mint('ops-alert-recipient.delete')]),
      ),
    ).toMatchObject({ kind: 'last-channel' });
    api.updateOpsAlertRecipient.mockRejectedValue(conflict(409, 'LAST_CHANNEL_PROTECTED'));
    expect(await settingsActions.updateRecipientAction({ kind: 'idle' }, submission({ ...BASE, ...PREFS_OFF }))).toMatchObject({
      kind: 'last-channel',
    });
  });

  it('the second step draws the warning, verbatim, with its own confirmation; the dead end draws none', () => {
    const asked = renderToStaticMarkup(
      <form>
        <LastCriticalStep state={{ kind: 'last-critical', at: 1 }} leadProof="ops-alert-recipient.pause" confirmLabel="Yine de duraklat" testId="t" />
      </form>,
    );
    expect(LAST_CRITICAL_WARNING).toBe(
      'Bu, kritik bildirim alan son e-posta alıcısı. Telegram yapılandırılmış olsa da e-posta ile kritik bildirim gelmeyecek.',
    );
    expect(asked).toContain(LAST_CRITICAL_WARNING);
    expect(asked).toContain('<input type="hidden" name="confirmLastCritical" value="true"/>');
    expect(asked).toContain('data-testid="t-confirm"');
    expect(asked).toContain('Yine de duraklat');

    const blocked = renderToStaticMarkup(
      <form>
        <LastCriticalStep state={{ kind: 'last-channel', at: 1 }} leadProof="ops-alert-recipient.pause" confirmLabel="Yine de duraklat" testId="t" />
      </form>,
    );
    expect(LAST_CHANNEL_PROTECTED_TEXT).toBe(
      "Production'da son etkin bildirim kanalı kaldırılamaz. Önce başka bir kritik alıcı ekleyin.",
    );
    expect(blocked).toContain('Production&#x27;da son etkin bildirim kanalı kaldırılamaz. Önce başka bir kritik alıcı ekleyin.');
    expect(blocked).not.toContain('confirmLastCritical');
    expect(blocked).not.toContain('<button');
    expect(blocked).not.toContain('<dialog');

    expect(renderToStaticMarkup(<form><LastCriticalStep state={{ kind: 'idle' }} leadProof={null} confirmLabel="x" testId="t" /></form>)).toBe('<form></form>');
  });
});

describe('recipient action refusals and results', () => {
  it('delete and replace need a reason of at least 5 characters, checked before the proof is spent', async () => {
    const proof = await mint('ops-alert-recipient.delete');
    const short = await settingsActions.deleteRecipientAction(RECIPIENT_ACTION_IDLE, submission({ ...BASE, reason: ' abc ' }, [proof]));
    expect(short).toMatchObject({ kind: 'error', field: 'reason' });
    expect(api.deleteOpsAlertRecipient).not.toHaveBeenCalled();
    api.deleteOpsAlertRecipient.mockResolvedValue(undefined);
    // The same proof is still good: a refused reason did not use it up.
    expect(
      (await settle(() => settingsActions.deleteRecipientAction(RECIPIENT_ACTION_IDLE, submission({ ...BASE, reason: 'Ekipten ayrıldı' }, [proof])))).redirect,
    ).toBe(`${SETTINGS}?ok=deleted`);

    const replace = await settingsActions.replaceRecipientAddressAction(
      RECIPIENT_ACTION_IDLE,
      submission({ ...BASE, address: 'new@example.test', reason: 'x' }, [await mint('ops-alert-recipient.replace')]),
    );
    expect(replace).toMatchObject({ kind: 'error', field: 'reason' });
    expect(api.replaceOpsAlertRecipientAddress).not.toHaveBeenCalled();
  });

  it('replace sends the new address and the trimmed reason, and never echoes the address in a refusal', async () => {
    api.replaceOpsAlertRecipientAddress.mockResolvedValue(recipient({ id: 'rcp-2' }));
    const done = await settle(async () =>
      settingsActions.replaceRecipientAddressAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...BASE, address: ' new@example.test ', reason: ' Adres değişti ' }, [await mint('ops-alert-recipient.replace')]),
      ),
    );
    expect(done.redirect).toBe(`${SETTINGS}?ok=replaced`);
    expect(api.replaceOpsAlertRecipientAddress).toHaveBeenCalledWith('rcp-1', {
      version: 3,
      address: 'new@example.test',
      reason: 'Adres değişti',
    });

    for (const code of ['RECIPIENT_ADDRESS_INVALID', 'RECIPIENT_DUPLICATE']) {
      api.replaceOpsAlertRecipientAddress.mockRejectedValueOnce(conflict(code === 'RECIPIENT_DUPLICATE' ? 409 : 400, code));
      const refused = await settingsActions.replaceRecipientAddressAction(
        RECIPIENT_ACTION_IDLE,
        submission({ ...BASE, address: 'new@example.test', reason: 'Adres değişti' }, [await mint('ops-alert-recipient.replace')]),
      );
      expect(refused).toMatchObject({ kind: 'error', field: 'address', code, message: RECIPIENT_ERROR_TEXT[code] });
      expect(JSON.stringify(refused)).not.toContain('new@example.test');
    }
  });

  it('a stale row (VERSION_CONFLICT, deleted, missing) goes to the page notice of status-conflicts.ts', async () => {
    for (const [status, code, key] of [
      [409, 'VERSION_CONFLICT', 'versionConflict'],
      [409, 'RECIPIENT_DELETED', 'deleted'],
      [404, 'RECIPIENT_NOT_FOUND', 'notFound'],
    ] as const) {
      api.pauseOpsAlertRecipient.mockRejectedValueOnce(conflict(status, code));
      expect(
        (await settle(async () => settingsActions.pauseRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE, [await mint('ops-alert-recipient.pause')])))).redirect,
      ).toBe(`${SETTINGS}?error=${key}`);
      api.resumeOpsAlertRecipient.mockRejectedValueOnce(conflict(status, code));
      expect((await settle(() => settingsActions.resumeRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE)))).redirect).toBe(
        `${SETTINGS}?error=${key}`,
      );
    }
  });

  it('a refusal without a code is named by its HTTP status, not "Bilinmeyen hata"', async () => {
    api.resumeOpsAlertRecipient.mockRejectedValueOnce(new ApiError(400, JSON.stringify({ statusCode: 400, message: ['version must be an integer'] })));
    const invalid = await settingsActions.resumeRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE));
    expect(invalid).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(invalid)).toContain('kabul edilmedi');
    api.resumeOpsAlertRecipient.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ statusCode: 403, message: 'Forbidden' })));
    expect(JSON.stringify(await settingsActions.resumeRecipientAction(RECIPIENT_ACTION_IDLE, submission(BASE)))).toContain('yetkiniz yok');
    for (const result of [invalid]) expect(JSON.stringify(result)).not.toContain(RECIPIENT_ERROR_TEXT.UNKNOWN);
  });

  it('test send: the result code and its sentence; 429 says to wait', async () => {
    api.testOpsAlertRecipient.mockResolvedValueOnce({ result: 'SENT' });
    expect(await settingsActions.testRecipientAction(RECIPIENT_ACTION_IDLE, submission({ recipientId: 'rcp-1' }))).toMatchObject({
      kind: 'tested',
      ok: true,
      result: 'SENT',
    });
    api.testOpsAlertRecipient.mockResolvedValueOnce({ result: 'TIMEOUT' });
    const failed = await settingsActions.testRecipientAction(RECIPIENT_ACTION_IDLE, submission({ recipientId: 'rcp-1' }));
    expect(failed).toMatchObject({ kind: 'tested', ok: false, result: 'TIMEOUT' });
    expect(JSON.stringify(failed)).toContain('Zaman aşımı.');

    api.testOpsAlertRecipient.mockRejectedValueOnce(conflict(429, 'TEST_RATE_LIMITED'));
    expect(await settingsActions.testRecipientAction(RECIPIENT_ACTION_IDLE, submission({ recipientId: 'rcp-1' }))).toMatchObject({
      kind: 'error',
      code: 'TEST_RATE_LIMITED',
      message: RECIPIENT_ERROR_TEXT.TEST_RATE_LIMITED,
    });
    api.testOpsAlertRecipient.mockRejectedValueOnce(new ApiError(429, ''));
    expect(await settingsActions.testRecipientAction(RECIPIENT_ACTION_IDLE, submission({ recipientId: 'rcp-1' }))).toMatchObject({
      kind: 'error',
      message: RECIPIENT_ERROR_TEXT.TEST_RATE_LIMITED,
    });
  });
});

describe('reveal: the full address reaches only the dialog that asked for it', () => {
  it('answers the address to the caller and writes it nowhere: no redirect, no cookie, no revalidation, no log', async () => {
    api.revealOpsAlertRecipient.mockResolvedValue({ address: FULL_ADDRESS });
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const result = await settle(async () =>
      settingsActions.revealRecipientAction(submission({ recipientId: 'rcp-1' }, [await mint('ops-alert-recipient.reveal')])),
    );
    expect(result.redirect).toBeUndefined();
    expect(result.value).toEqual({ kind: 'revealed', address: FULL_ADDRESS });
    expect(session.cookieSet).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(FULL_ADDRESS);
      spy.mockRestore();
    }
  });

  it('the client half keeps it in component memory only: no URL, storage, cookie or router write', () => {
    const source = readFileSync(resolve(__dirname, '../app/system-health/notification-settings/recipient-row-actions.tsx'), 'utf8');
    for (const forbidden of [/localStorage/, /sessionStorage/, /document\.cookie/, /useSearchParams/, /router\.(push|replace)/, /history\./, /console\./]) {
      expect(source).not.toMatch(forbidden);
    }
    // Closing the window drops it.
    expect(source).toMatch(/setAddress\(null\)/);
    const actionsSource = readFileSync(resolve(__dirname, '../app/system-health/notification-settings/actions.ts'), 'utf8');
    expect(actionsSource).not.toMatch(/console\./);
  });
});

describe('Bildirim Ayarları row actions', () => {
  const rowActions = (markup: string) => {
    const start = markup.indexOf('data-testid="ops-alert-recipient-actions"');
    return markup.slice(start, markup.indexOf('</td>', start));
  };

  it('a read-only account gets no action at all', async () => {
    load();
    const cell = rowActions(await renderSettings());
    for (const id of ['edit', 'pause', 'resume', 'test', 'replace-link', 'delete-link', 'reveal']) {
      expect(cell).not.toContain(`ops-alert-recipient-${id}"`);
    }
  });

  it('WRITE pauses an active recipient behind a ConfirmDialog and resumes a paused one directly', async () => {
    api.held = new Set([READ, WRITE]);
    load({ recipients: [recipient(), recipient({ id: 'rcp-2', status: 'PAUSED' })] });
    const markup = await renderSettings();
    expect(markup).toContain('data-testid="ops-alert-recipient-pause"');
    expect(markup).toContain('data-testid="ops-alert-recipient-pause-dialog"');
    expect(markup).toContain('data-testid="ops-alert-recipient-resume"');
    expect(markup).not.toContain('data-testid="ops-alert-recipient-resume-dialog"');
    expect(markup).not.toContain('ops-alert-recipient-delete-link"');
    expect(markup).not.toContain('ops-alert-recipient-replace-link"');
  });

  it('TEST gives a test-send button without a confirmation', async () => {
    api.held = new Set([READ, TEST]);
    load();
    const cell = rowActions(await renderSettings());
    expect(cell).toContain('data-testid="ops-alert-recipient-test"');
    expect(cell).not.toContain('ops-alert-recipient-test-dialog');
  });

  it('DELETE links to the delete window; replacing the address needs WRITE and DELETE', async () => {
    api.held = new Set([READ, DELETE]);
    load();
    const deleteOnly = rowActions(await renderSettings());
    expect(deleteOnly).toMatch(/href="[^"]*alici=rcp-1&amp;islem=sil"/);
    expect(deleteOnly).not.toContain('islem=adres');
    api.held = new Set([READ, WRITE, DELETE]);
    expect(rowActions(await renderSettings())).toMatch(/href="[^"]*alici=rcp-1&amp;islem=adres"/);
  });

  it('"Göster" is drawn for SUPER_ADMIN only — an ADMIN holding OPS_ALERT_RECIPIENTS_REVEAL through a role gets none', async () => {
    api.held = new Set([READ, WRITE, DELETE, TEST, REVEAL]);
    load();
    expect(await renderSettings()).not.toContain('ops-alert-recipient-reveal');
    api.isSuperAdmin = true;
    const superAdmin = await renderSettings();
    expect(superAdmin).toContain('data-testid="ops-alert-recipient-reveal"');
    expect(superAdmin).toContain('data-testid="ops-alert-recipient-reveal-dialog"');
    // The page itself never holds the address: it is fetched only by the confirmed dialog.
    expect(api.revealOpsAlertRecipient).not.toHaveBeenCalled();
    expect(superAdmin).not.toContain(FULL_ADDRESS);
  });

  it('?islem=sil opens the delete window: a reason of 5+ characters and a confirmation; not without DELETE', async () => {
    api.held = new Set([READ, DELETE]);
    load({ recipients: [recipient({ isLastCritical: true })] });
    const markup = await renderSettings({ alici: 'rcp-1', islem: 'sil' });
    expect(markup).toContain('data-testid="ops-alert-recipient-delete-form"');
    expect(markup).toMatch(/<textarea[^>]*name="reason"[^>]*minLength="5"|<textarea[^>]*minLength="5"[^>]*name="reason"/);
    expect(markup).toContain('data-testid="ops-alert-recipient-delete-dialog"');
    expect(markup).toContain('<input type="hidden" name="version" value="3"/>');
    expect(markup).not.toContain('confirmLastCritical');
    api.held = new Set([READ, WRITE]);
    const noDelete = await renderSettings({ alici: 'rcp-1', islem: 'sil' });
    expect(noDelete).not.toContain('ops-alert-recipient-delete-form');
  });

  it('?islem=adres opens the replace window with a new address and a reason; only with WRITE and DELETE', async () => {
    api.held = new Set([READ, WRITE, DELETE]);
    load();
    const markup = await renderSettings({ alici: 'rcp-1', islem: 'adres' });
    expect(markup).toContain('data-testid="ops-alert-recipient-replace-form"');
    expect(markup).toContain('name="address"');
    expect(markup).toContain('name="reason"');
    expect(markup).toContain('data-testid="ops-alert-recipient-replace-dialog"');
    expect(markup).toContain('o***@example.test');
    api.held = new Set([READ, WRITE]);
    expect(await renderSettings({ alici: 'rcp-1', islem: 'adres' })).not.toContain('ops-alert-recipient-replace-form');
  });

  it('says what each success did', async () => {
    load();
    for (const ok of ['paused', 'resumed', 'deleted', 'replaced']) {
      expect(await renderSettings({ ok })).toContain('data-testid="ops-alert-recipients-ok"');
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-ALERT-002 PR-B (task B4) — carried from the B3 review
// ---------------------------------------------------------------------------

const { withSecondStep, STEPPED_ACTION_IDLE } = await import('../app/system-health/notification-settings/recipient-action-state');
const { recipientFormStep, RECIPIENT_FORM_IDLE } = await import('../app/system-health/notification-settings/recipient-form-state');

describe('B3 carry-over: the second step survives, refusals show, no dead save button', () => {
  it('delete: a reason refused in the second step keeps the second step (component state, not the last answer)', async () => {
    const run = withSecondStep(settingsActions.deleteRecipientAction);
    api.deleteOpsAlertRecipient.mockRejectedValueOnce(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    const first = await run(STEPPED_ACTION_IDLE, submission({ ...BASE, reason: 'Ekipten ayrıldı' }, [await mint('ops-alert-recipient.delete')]));
    expect(first.step).toMatchObject({ kind: 'last-critical' });

    const second = await run(
      first,
      submission({ ...BASE, reason: 'abc', confirmLastCritical: 'true' }, [
        await mint('ops-alert-recipient.delete'),
        await mint('ops-alert-recipient.last-critical'),
      ]),
    );
    expect(second.state).toMatchObject({ kind: 'error', field: 'reason' });
    expect(second.step).toMatchObject({ kind: 'last-critical' });
    expect(api.deleteOpsAlertRecipient).toHaveBeenCalledTimes(1);

    // A proof refusal in the second step keeps it too.
    const third = await run(second, submission({ ...BASE, reason: 'Ekipten ayrıldı', confirmLastCritical: 'true' }));
    expect(third.state).toMatchObject({ kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE });
    expect(third.step).toMatchObject({ kind: 'last-critical' });
  });

  it('the delete and pause forms keep their second step through withSecondStep', () => {
    const source = readFileSync(resolve(__dirname, '../app/system-health/notification-settings/recipient-row-actions.tsx'), 'utf8');
    expect(source).toContain('withSecondStep(deleteRecipientAction)');
    expect(source).toContain('withSecondStep(pauseRecipientAction)');
  });

  it('replace: LAST_CRITICAL_CONFIRM_REQUIRED and LAST_CHANNEL_PROTECTED come back as a visible error', async () => {
    api.replaceOpsAlertRecipientAddress.mockRejectedValueOnce(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    const critical = await settingsActions.replaceRecipientAddressAction(
      RECIPIENT_ACTION_IDLE,
      submission({ ...BASE, address: 'new@example.test', reason: 'Adres değişti' }, [await mint('ops-alert-recipient.replace')]),
    );
    expect(critical).toMatchObject({ kind: 'error', code: 'LAST_CRITICAL_CONFIRM_REQUIRED', field: null });
    expect(JSON.stringify(critical)).toContain('Adres değiştirilmedi');

    api.replaceOpsAlertRecipientAddress.mockRejectedValueOnce(conflict(409, 'LAST_CHANNEL_PROTECTED'));
    const channel = await settingsActions.replaceRecipientAddressAction(
      RECIPIENT_ACTION_IDLE,
      submission({ ...BASE, address: 'new@example.test', reason: 'Adres değişti' }, [await mint('ops-alert-recipient.replace')]),
    );
    expect(channel).toMatchObject({ kind: 'error', code: 'LAST_CHANNEL_PROTECTED', message: LAST_CHANNEL_PROTECTED_TEXT });
    for (const result of [critical, channel]) expect(JSON.stringify(result)).not.toContain('new@example.test');
  });

  it('edit: the ordinary save is hidden while the answer is last-channel and Kritik is off', () => {
    const lastChannel = { kind: 'last-channel', at: 1 } as const;
    const lastCritical = { kind: 'last-critical', at: 1 } as const;
    expect(recipientFormStep(true, false, lastChannel)).toEqual({ step: lastChannel, saveHidden: true });
    expect(recipientFormStep(true, false, lastCritical)).toEqual({ step: lastCritical, saveHidden: true });
    // Kritik back on: the save is ordinary again.
    expect(recipientFormStep(true, true, lastChannel)).toEqual({ step: RECIPIENT_FORM_IDLE, saveHidden: false });
    expect(recipientFormStep(false, false, lastChannel)).toEqual({ step: RECIPIENT_FORM_IDLE, saveHidden: false });
    const refused = { kind: 'error', message: 'x', field: null, code: null, at: 1 } as const;
    expect(recipientFormStep(true, false, refused)).toEqual({ step: refused, saveHidden: false });
    const source = readFileSync(resolve(__dirname, '../app/system-health/notification-settings/recipient-form.tsx'), 'utf8');
    expect(source).toContain('recipientFormStep(');
  });
});

// ---------------------------------------------------------------------------
// OBS-ALERT-002 PR-B (task B4) — the SUPER_ADMIN routing panel
// ---------------------------------------------------------------------------

const { RoutingSwitchBody } = await import('../app/system-health/notification-settings/routing-panel');
const { ROUTING_COUNTS_CHANGED_TEXT, ROUTING_SWITCH_IDLE, ROUTING_OP_IDLE } = await import(
  '../app/system-health/notification-settings/routing-panel-state'
);
import type { RoutingPreview } from '../lib/ops-alert-recipients';

const MANAGE = 'OPS_ALERT_ROUTING_MANAGE';
const TOKEN = 'a'.repeat(64);

function preview(over: Partial<RoutingPreview> = {}): RoutingPreview {
  return {
    direction: 'CUTOVER',
    counts: { PENDING: { rebind: 7, cancel: 2 }, FAILED: { rebind: 5, cancel: 3 }, SENDING: { rebind: 4, cancel: 0 } },
    told: 11,
    inFlight: 13,
    collisions: 0,
    confirmRequired: false,
    blockers: [],
    token: TOKEN,
    ...over,
  };
}

function panelOf(markup: string): string {
  const start = markup.indexOf('data-testid="ops-alert-routing-panel"');
  if (start < 0) return '';
  return markup.slice(start, markup.indexOf('data-testid="ops-alert-recipients"', start));
}

const renderBody = (direction: 'CUTOVER' | 'REVERT', state: Parameters<typeof RoutingSwitchBody>[0]['state']) =>
  renderToStaticMarkup(
    <form>
      <RoutingSwitchBody direction={direction} state={state} />
    </form>,
  );

describe('routing panel: who sees it and which steps it draws', () => {
  it('an ADMIN gets no panel — even holding OPS_ALERT_ROUTING_MANAGE and every recipient permission through a role', async () => {
    api.held = new Set([READ, WRITE, DELETE, TEST, REVEAL, MANAGE]);
    load({ routing: { emailRouting: 'ENV_LEGACY', envAddressManaged: false } });
    const markup = await renderSettings();
    for (const id of ['panel', 'import', 'cutover-form', 'revert-form', 'rewrap', 'rehash']) {
      expect(markup).not.toContain(`ops-alert-routing-${id}`);
    }
    // The status strip still says which mode is on.
    expect(markup).toContain('data-testid="ops-alert-routing-mode"');
    expect(api.previewOpsAlertCutover).not.toHaveBeenCalled();
  });

  it('a SUPER_ADMIN gets it between the status strip and the ENV_LEGACY notice', async () => {
    api.isSuperAdmin = true;
    load({ routing: { emailRouting: 'ENV_LEGACY', envAddressManaged: false } });
    const markup = await renderSettings();
    const strip = markup.indexOf('data-testid="ops-alert-status-strip"');
    const panel = markup.indexOf('data-testid="ops-alert-routing-panel"');
    const notice = markup.indexOf('data-testid="ops-alert-env-legacy-notice"');
    expect(strip).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(strip);
    expect(notice).toBeGreaterThan(panel);
    // Drawing the panel previews nothing: a preview is the operator's click.
    expect(api.previewOpsAlertCutover).not.toHaveBeenCalled();
    expect(api.previewOpsAlertRevert).not.toHaveBeenCalled();
  });

  it('ENV_LEGACY: import (when the env address exists and is not managed yet), the test reminder, then the cutover preview', async () => {
    api.isSuperAdmin = true;
    load({ routing: { emailRouting: 'ENV_LEGACY', envAddressConfigured: true, envAddressManaged: false } });
    const fresh = panelOf(await renderSettings());
    expect(fresh).toContain('data-testid="ops-alert-routing-import"');
    expect(fresh).toContain('OPS_ALERT_EMAIL&#x27;i içe aktar');
    expect(fresh).toContain('data-testid="ops-alert-routing-test-reminder"');
    expect(fresh).toContain('Test gönder');
    expect(fresh).toContain('data-testid="ops-alert-routing-cutover-form"');
    expect(fresh).toContain('Geçişi önizle');
    expect(fresh).not.toContain('ops-alert-routing-revert-form');
    expect(fresh.indexOf('ops-alert-routing-import')).toBeLessThan(fresh.indexOf('ops-alert-routing-test-reminder'));
    expect(fresh.indexOf('ops-alert-routing-test-reminder')).toBeLessThan(fresh.indexOf('ops-alert-routing-cutover-form'));

    load({ routing: { emailRouting: 'ENV_LEGACY', envAddressConfigured: true, envAddressManaged: true } });
    const managed = panelOf(await renderSettings());
    expect(managed).toContain('data-testid="ops-alert-routing-imported"');
    expect(managed).toContain('Env adresi yönetilen listede ✓');
    expect(managed).not.toContain('data-testid="ops-alert-routing-import"');

    load({ routing: { emailRouting: 'ENV_LEGACY', envAddressConfigured: false, envAddressManaged: false } });
    const noEnv = panelOf(await renderSettings());
    expect(noEnv).not.toContain('ops-alert-routing-import');
    expect(noEnv).toContain('data-testid="ops-alert-routing-cutover-form"');
  });

  it('MANAGED: the revert preview, and neither import nor cutover', async () => {
    api.isSuperAdmin = true;
    load({ routing: { emailRouting: 'MANAGED', envAddressManaged: false } });
    const panel = panelOf(await renderSettings());
    expect(panel).toContain('data-testid="ops-alert-routing-revert-form"');
    expect(panel).toContain('Geri dönüşü önizle');
    expect(panel).not.toContain('ops-alert-routing-cutover-form');
    expect(panel).not.toContain('ops-alert-routing-import');
  });

  it('rewrap shows only with several key ids, rehash only with several HMAC versions — both behind the rewrap proof', async () => {
    api.isSuperAdmin = true;
    load();
    const single = panelOf(await renderSettings());
    expect(single).not.toContain('ops-alert-routing-rewrap');
    expect(single).not.toContain('ops-alert-routing-rehash');

    load({ routing: { keyIds: { k1: 2, k2: 1 } } });
    const keys = panelOf(await renderSettings());
    expect(keys).toContain('data-testid="ops-alert-routing-rewrap"');
    expect(keys).toContain('data-testid="ops-alert-routing-rewrap-dialog"');
    expect(keys).not.toContain('ops-alert-routing-rehash');

    load({ routing: { hmacVersions: { '1': 2, '2': 1 } } });
    const hmac = panelOf(await renderSettings());
    expect(hmac).toContain('data-testid="ops-alert-routing-rehash"');
    expect(hmac).not.toContain('ops-alert-routing-rewrap"');
  });

  it('says what an import, a cutover and a revert did', async () => {
    load();
    for (const ok of ['imported', 'cutover', 'reverted']) {
      expect(await renderSettings({ ok })).toContain('data-testid="ops-alert-recipients-ok"');
    }
  });
});

describe('routing preview: what the operator approves is what the API previewed', () => {
  it('prints the API numbers as they came, per status, with told, in flight and collisions', () => {
    const markup = renderBody('CUTOVER', { kind: 'preview', preview: preview(), at: 1 });
    const cell = (status: string, column: string) =>
      new RegExp(`data-testid="ops-alert-routing-count-${status}-${column}"[^>]*>(\\d+)<`).exec(markup)?.[1];
    expect(cell('PENDING', 'rebind')).toBe('7');
    expect(cell('PENDING', 'cancel')).toBe('2');
    expect(cell('FAILED', 'rebind')).toBe('5');
    expect(cell('FAILED', 'cancel')).toBe('3');
    expect(cell('SENDING', 'rebind')).toBe('4');
    expect(cell('SENDING', 'cancel')).toBe('0');
    expect(/data-testid="ops-alert-routing-told"[^>]*>(\d+)</.exec(markup)?.[1]).toBe('11');
    expect(/data-testid="ops-alert-routing-in-flight"[^>]*>(\d+)</.exec(markup)?.[1]).toBe('13');
    expect(/data-testid="ops-alert-routing-collisions"[^>]*>(\d+)</.exec(markup)?.[1]).toBe('0');
    for (const heading of ['Bağlanacak', 'İptal edilecek', 'Bilgilendirilmiş aktarılacak']) expect(markup).toContain(heading);
    // The approval carries the preview's own token, and the gate asks before it goes.
    expect(markup).toContain(`<input type="hidden" name="token" value="${TOKEN}"/>`);
    expect(markup).toContain('data-testid="ops-alert-routing-cutover-confirm"');
    expect(markup).toContain('data-testid="ops-alert-routing-cutover-confirm-dialog"');
    expect(markup).toContain('Yönetilen moda geç');
    expect(markup).not.toContain('cancelUnmatched');
  });

  it('a blocker is said in words, and then there is no confirm button and no token', () => {
    for (const blockers of [['ROUTING_COLLISION_PENDING'], ['LEGACY_ROWS_UNMATCHED'], ['LEGACY_ROWS_UNMATCHED', 'NO_LIVE_CRITICAL_CHANNEL']] as const) {
      const markup = renderBody('CUTOVER', { kind: 'preview', preview: preview({ blockers: [...blockers], collisions: 2 }), at: 1 });
      for (const blocker of blockers) {
        expect(markup).toContain(`data-code="${blocker}"`);
        expect(markup).toContain(RECIPIENT_ERROR_TEXT[blocker]!.replace(/'/g, '&#x27;'));
      }
      expect(markup).not.toContain('ops-alert-routing-cutover-confirm');
      expect(markup).not.toContain('name="token"');
      expect(markup).not.toContain('<dialog');
      // The numbers are still shown, so the operator sees what waits.
      expect(/data-testid="ops-alert-routing-collisions"[^>]*>(\d+)</.exec(markup)?.[1]).toBe('2');
    }
  });

  it('revert with confirmRequired asks a separate, required "Eşleşmeyen N teslimatı iptal et" box', () => {
    const required = renderBody('REVERT', {
      kind: 'preview',
      preview: preview({ direction: 'REVERT', confirmRequired: true }),
      at: 1,
    });
    expect(required).toContain('Eşleşmeyen 5 teslimatı iptal et');
    const box = /<input type="checkbox"[^>]*>/.exec(required)?.[0] ?? '';
    for (const attribute of ['name="cancelUnmatched"', 'value="true"', 'required=""']) expect(box).toContain(attribute);
    expect(required).toContain('data-testid="ops-alert-routing-revert-confirm"');

    const plain = renderBody('REVERT', {
      kind: 'preview',
      preview: preview({ direction: 'REVERT', confirmRequired: false, counts: { PENDING: { rebind: 1, cancel: 0 }, FAILED: { rebind: 0, cancel: 0 }, SENDING: { rebind: 0, cancel: 0 } } }),
      at: 1,
    });
    expect(plain).not.toContain('cancelUnmatched');
    expect(plain).toContain('data-testid="ops-alert-routing-revert-confirm"');
  });

  it('COUNTS_CHANGED drops the preview and says to preview again, word for word', () => {
    expect(ROUTING_COUNTS_CHANGED_TEXT).toBe('Önizlemeden bu yana sayılar değişti; yeniden önizleyin.');
    const markup = renderBody('CUTOVER', { kind: 'error', message: ROUTING_COUNTS_CHANGED_TEXT, code: 'COUNTS_CHANGED', at: 1 });
    expect(markup).toContain(ROUTING_COUNTS_CHANGED_TEXT);
    expect(markup).not.toContain('name="token"');
    expect(markup).not.toContain('ops-alert-routing-cutover-confirm');
    expect(markup).toContain('Geçişi önizle');
  });

  it('idle: only the preview button', () => {
    const markup = renderBody('REVERT', ROUTING_SWITCH_IDLE);
    expect(markup).toContain('Geri dönüşü önizle');
    expect(markup).not.toContain('name="token"');
    expect(markup).not.toContain('<table');
  });
});

describe('routing server actions', () => {
  const switchForm = (fields: Record<string, string>, proofs: Array<string | null> = []) => submission(fields, proofs);

  it('preview answers the API preview verbatim and writes nothing; no proof is asked', async () => {
    const cut = preview();
    api.previewOpsAlertCutover.mockResolvedValueOnce(cut);
    expect(await settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'CUTOVER', intent: 'preview' }))).toMatchObject({
      kind: 'preview',
      preview: cut,
    });
    const back = preview({ direction: 'REVERT', confirmRequired: true });
    api.previewOpsAlertRevert.mockResolvedValueOnce(back);
    expect(await settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'REVERT', intent: 'preview' }))).toMatchObject({
      kind: 'preview',
      preview: back,
    });
    expect(api.applyOpsAlertCutover).not.toHaveBeenCalled();
    expect(api.applyOpsAlertRevert).not.toHaveBeenCalled();
  });

  it('cutover sends only the preview token; revert adds cancelUnmatched only when the box is ticked', async () => {
    api.applyOpsAlertCutover.mockResolvedValue(routing());
    const cut = await settle(async () =>
      settingsActions.routingSwitchAction(
        ROUTING_SWITCH_IDLE,
        switchForm({ direction: 'CUTOVER', intent: 'apply', token: TOKEN, counts: '99', told: '99' }, [await mint('ops-alert-routing.cutover')]),
      ),
    );
    expect(cut.redirect).toBe(`${SETTINGS}?ok=cutover`);
    expect(api.applyOpsAlertCutover).toHaveBeenCalledWith({ token: TOKEN });

    api.applyOpsAlertRevert.mockResolvedValue(routing({ emailRouting: 'ENV_LEGACY' }));
    const ticked = await settle(async () =>
      settingsActions.routingSwitchAction(
        ROUTING_SWITCH_IDLE,
        switchForm({ direction: 'REVERT', intent: 'apply', token: TOKEN, cancelUnmatched: 'true' }, [await mint('ops-alert-routing.revert')]),
      ),
    );
    expect(ticked.redirect).toBe(`${SETTINGS}?ok=reverted`);
    expect(api.applyOpsAlertRevert).toHaveBeenLastCalledWith({ token: TOKEN, cancelUnmatched: true });
    await settle(async () =>
      settingsActions.routingSwitchAction(
        ROUTING_SWITCH_IDLE,
        switchForm({ direction: 'REVERT', intent: 'apply', token: TOKEN }, [await mint('ops-alert-routing.revert')]),
      ),
    );
    expect(api.applyOpsAlertRevert).toHaveBeenLastCalledWith({ token: TOKEN });
  });

  type RoutingGuard = { name: string; key: Parameters<typeof issueConfirmationProof>[0]; write: ReturnType<typeof vi.fn>; run: (proofs: Array<string | null>) => Promise<unknown> };
  const ROUTING_GUARDED: RoutingGuard[] = [
    {
      name: 'Geçiş',
      key: 'ops-alert-routing.cutover',
      write: api.applyOpsAlertCutover,
      run: (proofs) => settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'CUTOVER', intent: 'apply', token: TOKEN }, proofs)),
    },
    {
      name: 'Geri dönüş',
      key: 'ops-alert-routing.revert',
      write: api.applyOpsAlertRevert,
      run: (proofs) =>
        settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'REVERT', intent: 'apply', token: TOKEN, cancelUnmatched: 'true' }, proofs)),
    },
    {
      name: 'Rewrap',
      key: 'ops-alert-routing.rewrap',
      write: api.rewrapOpsAlertRecipients,
      run: (proofs) => settingsActions.rewrapRecipientsAction(ROUTING_OP_IDLE, switchForm({}, proofs)),
    },
    {
      name: 'Rehash',
      key: 'ops-alert-routing.rewrap',
      write: api.rehashOpsAlertRecipients,
      run: (proofs) => settingsActions.rehashRecipientsAction(ROUTING_OP_IDLE, switchForm({}, proofs)),
    },
  ];

  for (const testCase of ROUTING_GUARDED) {
    it(`${testCase.name}: refused without its proof, with a forged one or another confirmation's; a real one goes once`, async () => {
      api.applyOpsAlertCutover.mockResolvedValue(routing());
      api.applyOpsAlertRevert.mockResolvedValue(routing({ emailRouting: 'ENV_LEGACY' }));
      api.rewrapOpsAlertRecipients.mockResolvedValue({ rewrapped: 1, failed: 0 });
      api.rehashOpsAlertRecipients.mockResolvedValue({ rehashed: 1, failed: 0 });
      for (const proofs of [[], ['yes'], ['eyJrIjoieCJ9.Zm9yZ2Vk'], [await mint('ops-alert-recipient.pause')]]) {
        expect(JSON.stringify((await settle(() => testCase.run(proofs))).value)).toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
      }
      // A cutover proof is not a revert proof, and the other way round.
      if (testCase.key !== 'ops-alert-routing.rewrap') {
        const other = testCase.key === 'ops-alert-routing.cutover' ? 'ops-alert-routing.revert' : 'ops-alert-routing.cutover';
        expect(JSON.stringify((await settle(async () => testCase.run([await mint(other)]))).value)).toContain(
          CONFIRMATION_PROOF_REFUSAL_MESSAGE,
        );
      }
      expect(testCase.write).not.toHaveBeenCalled();
      const proof = await mint(testCase.key);
      expect(JSON.stringify(await settle(() => testCase.run([proof])))).not.toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
      expect(testCase.write).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((await settle(() => testCase.run([proof]))).value)).toContain(CONFIRMATION_PROOF_REFUSAL_MESSAGE);
      expect(testCase.write).toHaveBeenCalledTimes(1);
    });
  }

  it('an apply without a preview token is refused before the proof is spent', async () => {
    const proof = await mint('ops-alert-routing.cutover');
    const refused = await settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'CUTOVER', intent: 'apply' }, [proof]));
    expect(refused).toMatchObject({ kind: 'error' });
    expect(api.applyOpsAlertCutover).not.toHaveBeenCalled();
    api.applyOpsAlertCutover.mockResolvedValue(routing());
    expect(
      (await settle(() => settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'CUTOVER', intent: 'apply', token: TOKEN }, [proof])))).redirect,
    ).toBe(`${SETTINGS}?ok=cutover`);
  });

  it('an unknown direction is refused and calls nothing', async () => {
    const refused = await settingsActions.routingSwitchAction(ROUTING_SWITCH_IDLE, switchForm({ direction: 'SIDEWAYS', intent: 'preview' }));
    expect(refused).toMatchObject({ kind: 'error' });
    expect(api.previewOpsAlertCutover).not.toHaveBeenCalled();
    expect(api.previewOpsAlertRevert).not.toHaveBeenCalled();
  });

  it('COUNTS_CHANGED says to preview again; a blocker met at apply and CONFIRM_CANCEL_REQUIRED are said in words', async () => {
    api.applyOpsAlertCutover.mockRejectedValueOnce(conflict(409, 'COUNTS_CHANGED'));
    expect(
      await settingsActions.routingSwitchAction(
        { kind: 'preview', preview: preview(), at: 1 },
        switchForm({ direction: 'CUTOVER', intent: 'apply', token: TOKEN }, [await mint('ops-alert-routing.cutover')]),
      ),
    ).toMatchObject({ kind: 'error', code: 'COUNTS_CHANGED', message: ROUTING_COUNTS_CHANGED_TEXT });

    api.applyOpsAlertCutover.mockRejectedValueOnce(conflict(409, 'ROUTING_COLLISION_PENDING'));
    expect(
      await settingsActions.routingSwitchAction(
        ROUTING_SWITCH_IDLE,
        switchForm({ direction: 'CUTOVER', intent: 'apply', token: TOKEN }, [await mint('ops-alert-routing.cutover')]),
      ),
    ).toMatchObject({ kind: 'error', code: 'ROUTING_COLLISION_PENDING', message: RECIPIENT_ERROR_TEXT.ROUTING_COLLISION_PENDING });

    api.applyOpsAlertRevert.mockRejectedValueOnce(conflict(409, 'CONFIRM_CANCEL_REQUIRED'));
    expect(
      await settingsActions.routingSwitchAction(
        ROUTING_SWITCH_IDLE,
        switchForm({ direction: 'REVERT', intent: 'apply', token: TOKEN }, [await mint('ops-alert-routing.revert')]),
      ),
    ).toMatchObject({ kind: 'error', code: 'CONFIRM_CANCEL_REQUIRED', message: RECIPIENT_ERROR_TEXT.CONFIRM_CANCEL_REQUIRED });
  });

  it('import: one API call and ok=imported; the missing or already managed env address is said in words', async () => {
    api.importOpsAlertEnvRecipient.mockResolvedValueOnce(recipient({ label: 'OPS_ALERT_EMAIL (içe aktarıldı)' }));
    expect((await settle(() => settingsActions.importEnvRecipientAction(ROUTING_OP_IDLE, switchForm({})))).redirect).toBe(
      `${SETTINGS}?ok=imported`,
    );
    expect(api.importOpsAlertEnvRecipient).toHaveBeenCalledTimes(1);
    for (const code of ['ENV_ADDRESS_MISSING', 'RECIPIENT_DUPLICATE', 'RECIPIENT_LIMIT']) {
      api.importOpsAlertEnvRecipient.mockRejectedValueOnce(conflict(409, code));
      expect(await settingsActions.importEnvRecipientAction(ROUTING_OP_IDLE, switchForm({}))).toMatchObject({
        kind: 'error',
        code,
        message: RECIPIENT_ERROR_TEXT[code],
      });
    }
  });

  it('rewrap and rehash say how many moved and how many failed, and refresh the page', async () => {
    api.rewrapOpsAlertRecipients.mockResolvedValueOnce({ rewrapped: 3, failed: 1 });
    const rewrap = await settingsActions.rewrapRecipientsAction(ROUTING_OP_IDLE, switchForm({}, [await mint('ops-alert-routing.rewrap')]));
    expect(rewrap).toMatchObject({ kind: 'done' });
    expect(JSON.stringify(rewrap)).toContain('3 alıcı');
    expect(JSON.stringify(rewrap)).toContain('1 alıcı');
    api.rehashOpsAlertRecipients.mockResolvedValueOnce({ rehashed: 2, failed: 0 });
    const rehash = await settingsActions.rehashRecipientsAction(ROUTING_OP_IDLE, switchForm({}, [await mint('ops-alert-routing.rewrap')]));
    expect(rehash).toMatchObject({ kind: 'done' });
    expect(JSON.stringify(rehash)).toContain('2 alıcı');
    expect(cache.revalidatePath).toHaveBeenCalledWith(SETTINGS);
  });
});
