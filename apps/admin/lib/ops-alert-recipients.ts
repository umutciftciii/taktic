import { OPS_ALERT_CHANNEL_LABELS, OPS_ALERT_DELIVERY_LABELS, type OpsAlertChannel, type OpsAlertView } from './system-health';
import type { AdminAuditEntry } from './api';

/**
 * OBS-ALERT-002 — the admin's side of the operations-alert e-mail recipients
 * (apps/api/src/modules/ops-alerts/). Types mirror the API's response
 * projections exactly (dates are ISO strings on the wire); the texts are the
 * panel's Turkish, one per code the API can answer with, and carry no value:
 * no address, no id, no count.
 */

export type RecipientStatus = 'ACTIVE' | 'PAUSED' | 'DELETED';

/** One managed recipient. `maskedAddress` is the only form of the address a list ever carries. */
export type RecipientView = {
  id: string;
  label: string;
  maskedAddress: string;
  notifyWarning: boolean;
  notifyCritical: boolean;
  notifyRecovery: boolean;
  status: RecipientStatus;
  /** The optimistic-lock version every change to this recipient carries. */
  version: number;
  createdAt: string;
  updatedAt: string;
  lastSentAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  /** The encryption key id the address is wrapped with; null for a deleted row. */
  keyId: string | null;
  /** Removing or silencing this recipient would leave no live CRITICAL e-mail recipient. */
  isLastCritical: boolean;
};

export type EmailRouting = 'ENV_LEGACY' | 'MANAGED';

export type RoutingState = {
  emailRouting: EmailRouting;
  changedAt: string | null;
  envAddressConfigured: boolean;
  /** The env address is already a live managed recipient: importing it again is a duplicate. */
  envAddressManaged: boolean;
  activeRecipients: number;
  liveCritical: number;
  telegramConfigured: boolean;
  /** Live recipients per encryption key id. */
  keyIds: Record<string, number>;
  /** Live recipients per HMAC key version. */
  hmacVersions: Record<string, number>;
};

export type RoutingBlocker = 'NO_LIVE_CRITICAL_CHANNEL' | 'LEGACY_ROWS_UNMATCHED' | 'ROUTING_COLLISION_PENDING' | 'ALREADY_IN_MODE';
export type RoutingDirection = 'CUTOVER' | 'REVERT';
export type RoutingPendingStatus = 'PENDING' | 'FAILED' | 'SENDING';

export type RoutingPreview = {
  direction: RoutingDirection;
  /** Pending deliveries the switch rebinds or cancels, by status. */
  counts: Record<RoutingPendingStatus, { rebind: number; cancel: number }>;
  /** Sent deliveries whose "told" moves with the switch. */
  told: number;
  /** In-flight deliveries the switch leaves to the worker. */
  inFlight: number;
  /** Notices held while two rows of one notice are unresolved. */
  collisions: number;
  /** The revert's apply must carry `cancelUnmatched: true`. Always false for a cutover. */
  confirmRequired?: boolean;
  blockers: RoutingBlocker[];
  /** Binds the apply to these numbers; the client cannot mint one. */
  token: string;
};

/** The history of one recipient, or of all of them and the routing events: the shared audit entry. */
export type RecipientAuditEntry = AdminAuditEntry & { domain: 'OPS_ALERT_RECIPIENT' };

export type RewrapResult = { rewrapped: number; failed: number };
export type RehashResult = { rehashed: number; failed: number };

export type RecipientTestResult = { result: string };
export type RecipientReveal = { address: string };

// ---------------------------------------------------------------------------
// Request bodies (class-validator DTOs of the API; unknown fields are a 400)
// ---------------------------------------------------------------------------

export type CreateRecipientBody = {
  address: string;
  label: string;
  notifyWarning: boolean;
  notifyCritical: boolean;
  notifyRecovery: boolean;
};
export type UpdateRecipientBody = {
  version: number;
  label?: string;
  notifyWarning?: boolean;
  notifyCritical?: boolean;
  notifyRecovery?: boolean;
  confirmLastCritical?: boolean;
};
export type PauseRecipientBody = { version: number; confirmLastCritical?: boolean };
export type ResumeRecipientBody = { version: number };
export type DeleteRecipientBody = { version: number; reason: string; confirmLastCritical?: boolean };
export type ReplaceRecipientAddressBody = { version: number; address: string; reason: string };
export type ApplyCutoverBody = { token: string };
export type ApplyRevertBody = { token: string; cancelUnmatched?: boolean };

export const RECIPIENT_LABEL_MAX_LENGTH = 80;
export const RECIPIENT_REASON_MIN_LENGTH = 5;
export const RECIPIENT_REASON_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// Labels and texts
// ---------------------------------------------------------------------------

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  ACTIVE: 'Etkin',
  PAUSED: 'Duraklatıldı',
  DELETED: 'Silindi',
};

export const RECIPIENT_STATUS_BADGES: Record<RecipientStatus, string> = {
  ACTIVE: 'badge badge-good',
  PAUSED: 'badge badge-warn',
  DELETED: 'badge badge-muted',
};

export const EMAIL_ROUTING_LABELS: Record<EmailRouting, string> = {
  ENV_LEGACY: 'Ortam değişkeni adresi (OPS_ALERT_EMAIL)',
  MANAGED: 'Yönetilen alıcılar',
};

/**
 * Every code the ops-alerts API can return to the panel, in the operator's
 * words: the HTTP refusals (`code` of a 400/404/409/429 body) and the codes a
 * recipient's last failed delivery (`lastErrorCode`) or a test send can carry.
 * Looked up with `?? RECIPIENT_ERROR_TEXT.UNKNOWN` for a code added later.
 */
export const RECIPIENT_ERROR_TEXT: Record<string, string> = {
  // HTTP refusals (ops-alert-http-errors.ts)
  RECIPIENT_LIMIT: 'Alarm alıcısı sınırına ulaşıldı; yeni alıcı eklemek için önce birini silin.',
  RECIPIENT_DUPLICATE: 'Bu adres zaten bir alarm alıcısı.',
  VERSION_CONFLICT: 'Alıcı bu arada başka biri tarafından değiştirildi; sayfayı yenileyip tekrar deneyin.',
  LAST_CRITICAL_CONFIRM_REQUIRED: 'Bu, kritik alarm e-postalarının son alıcısı; devam etmek için onaylayın.',
  LAST_CHANNEL_PROTECTED: 'Bu, production ortamındaki son etkin alarm kanalı; kaldırılamaz.',
  RECIPIENT_DELETED: 'Bu alıcı silinmiş.',
  RECIPIENT_NOT_FOUND: 'Alıcı bulunamadı.',
  RECIPIENT_BUSY: 'Alarm alıcıları şu anda başka bir işlemle değiştiriliyor; biraz sonra tekrar deneyin.',
  RECIPIENT_ADDRESS_INVALID: 'Geçerli bir e-posta adresi girin (yalnız adres, ad olmadan).',
  DECRYPT_FAILED: 'Alıcının adresi açılamadı; şifreleme anahtarlarını kontrol edin.',
  TEST_RATE_LIMITED: 'Çok fazla test e-postası gönderildi; biraz bekleyip tekrar deneyin.',
  COUNTS_CHANGED: 'Önizlemeden bu yana teslimatlar değişti; yeniden önizleyin.',
  CONFIRM_CANCEL_REQUIRED: 'Geri dönüş bekleyen teslimatları iptal eder; iptali onaylayın.',
  ENV_ADDRESS_MISSING: 'OPS_ALERT_EMAIL tanımlı değil; içe aktarılacak adres yok.',
  // Routing blockers
  NO_LIVE_CRITICAL_CHANNEL: 'Geçişten sonra kritik alarmlar için etkin bir kanal kalmıyor.',
  LEGACY_ROWS_UNMATCHED: 'Bekleyen eski teslimatların eşleşen etkin bir alıcısı yok.',
  ROUTING_COLLISION_PENDING:
    'Aynı bildirimin iki teslimat satırı henüz sonuçlanmadı; gönderilene ya da düşürülene kadar bekleyip yeniden önizleyin.',
  ALREADY_IN_MODE: 'E-posta yönlendirmesi zaten bu modda.',
  // Delivery outcomes a recipient's last failure can carry (worker and e-mail adapter)
  RECIPIENT_REMOVED: 'Alıcı silindiği için gönderilmedi.',
  RECIPIENT_PAUSED: 'Alıcı duraklatılmıştı; gönderilmedi.',
  PREFERENCE_OFF: 'Alıcı bu bildirim türünü kapatmıştı; gönderilmedi.',
  LEGACY_AFTER_CUTOVER: 'Yönlendirme değiştiği için eski adrese gönderilmedi.',
  ROUTING_REVERTED: 'Yönlendirme eski haline döndüğü için gönderilmedi.',
  LEASE_EXPIRED: 'Gönderim yarıda kaldı; yeniden denenecek.',
  NOT_CONFIGURED: 'Kanal yapılandırılmamış.',
  RATE_LIMITED: 'Sağlayıcı hız sınırı uyguladı.',
  TRANSPORT_UNAVAILABLE: 'Taşıma servisi kullanılamıyor.',
  REJECTED: 'Sağlayıcı adresi reddetti.',
  TIMEOUT: 'Zaman aşımı.',
  INVALID_RECIPIENT: 'Geçersiz alıcı adresi.',
  EMAIL_BRANDING_INCOMPLETE: 'Şirket ve e-posta ayarları eksik.',
  EMAIL_PUBLIC_URL_INVALID: 'Uygulamanın public adresi e-postada kullanılamaz.',
  SOURCE_UNAVAILABLE: 'Kaynak kayıt yeniden oluşturulamadı.',
  RECIPIENT_RELEASED: 'Alıcının adresi serbest bırakıldığı için gönderilmedi.',
  UNKNOWN: 'Bilinmeyen hata.',
};

/** The text for a code, or the unknown-error text for one this panel does not know. */
export function recipientErrorText(code: string | null | undefined): string {
  return (code && RECIPIENT_ERROR_TEXT[code]) || RECIPIENT_ERROR_TEXT.UNKNOWN!;
}

// ---------------------------------------------------------------------------
// Delivery summary
// ---------------------------------------------------------------------------

type AlertDelivery = OpsAlertView['deliveries'][number];

const NOTICE_TEXT: Record<AlertDelivery['kind'], string> = {
  OPENED: 'Yeni sorun',
  REMINDER: 'Hatırlatma',
  RESOLVED: 'Düzelme',
};

const CHANNEL_ORDER: readonly OpsAlertChannel[] = ['TELEGRAM', 'EMAIL'];

/**
 * One line per channel about that channel's latest notice. A notice with one
 * delivery reads like OBS-ALERT-001's line; one that fans out to several
 * recipients counts them: "E-posta: Yeni sorun — 2/3 gönderildi, 1 yeniden
 * denenecek". A cancelled delivery (paused, preference off) is not an unsent
 * one, so it is left out of the total and only named. A legacy row — bound to
 * OPS_ALERT_EMAIL, `recipientId: null` — beside managed ones is named apart.
 */
export function recipientDeliverySummary(deliveries: readonly AlertDelivery[]): string {
  const latest = new Map<OpsAlertChannel, number>();
  for (const delivery of deliveries) {
    latest.set(delivery.channel, Math.max(latest.get(delivery.channel) ?? 0, delivery.sequence));
  }
  if (latest.size === 0) return 'Kanal yok';

  return CHANNEL_ORDER.filter((channel) => latest.has(channel))
    .map((channel) => {
      const rows = deliveries.filter((d) => d.channel === channel && d.sequence === latest.get(channel));
      const prefix = `${OPS_ALERT_CHANNEL_LABELS[channel]}: ${NOTICE_TEXT[rows[0]!.kind]} — `;
      if (rows.length === 1) {
        const only = rows[0]!;
        return `${prefix}${OPS_ALERT_DELIVERY_LABELS[only.status]}${only.attemptCount > 1 ? ` (${only.attemptCount}. deneme)` : ''}`;
      }
      const count = (status: AlertDelivery['status'][]) => rows.filter((r) => status.includes(r.status)).length;
      const cancelled = count(['CANCELLED']);
      const parts = [`${count(['SENT'])}/${rows.length - cancelled} gönderildi`];
      const extras: Array<[number, string]> = [
        [count(['FAILED']), 'yeniden denenecek'],
        [count(['PENDING', 'SENDING']), 'bekliyor'],
        [count(['ABANDONED']), 'gönderilemedi'],
        [cancelled, 'iptal'],
      ];
      for (const [n, text] of extras) if (n > 0) parts.push(`${n} ${text}`);
      const managed = rows.some((r) => r.recipientId !== null);
      const legacy = rows.filter((r) => r.recipientId === null).length;
      if (managed && legacy > 0) parts.push(`${legacy} eski adres`);
      return `${prefix}${parts.join(', ')}`;
    })
    .join(' · ');
}
