import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ toString: () => '' }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { adminPermissionLabel } from '../lib/api';
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
