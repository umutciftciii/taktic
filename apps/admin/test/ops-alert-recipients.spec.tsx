import { existsSync } from 'node:fs';
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

vi.mock('next/headers', () => ({ cookies: async () => ({ toString: () => '' }) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  useRouter: () => ({ replace: () => undefined, push: () => undefined, refresh: () => undefined }),
  usePathname: () => '/system-health/notification-settings',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const api = vi.hoisted(() => ({
  held: new Set<string>(),
  isSuperAdmin: false,
  listOpsAlertRecipients: vi.fn(),
  getOpsAlertRouting: vi.fn(),
  getOpsAlertRecipientsAudit: vi.fn(),
  createOpsAlertRecipient: vi.fn(),
  updateOpsAlertRecipient: vi.fn(),
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

  it('edit leaves the last-critical refusal in the form, in the API words', async () => {
    api.updateOpsAlertRecipient.mockRejectedValue(conflict(409, 'LAST_CRITICAL_CONFIRM_REQUIRED'));
    const result = await settingsActions.updateRecipientAction(
      idle,
      form({ recipientId: 'rcp-1', version: '3', label: 'A', notifyWarning: 'false', notifyCritical: 'false', notifyRecovery: 'true' }),
    );
    expect(result).toMatchObject({ kind: 'error', code: 'LAST_CRITICAL_CONFIRM_REQUIRED' });
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
