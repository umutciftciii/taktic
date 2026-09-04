import { urgencyLabel as sharedUrgencyLabel } from '@taktic/shared';

/**
 * Presentation helpers with no server dependency.
 *
 * They live apart from `lib/api.ts` because that module imports `next/headers`
 * and can therefore never be pulled into a Client Component. Everything here is
 * pure formatting, so both sides may import it; `lib/api.ts` re-exports the lot
 * and every existing server-side import keeps working unchanged.
 */

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    SUBMITTED: 'Gönderildi',
    IN_REVIEW: 'İncelemede',
    APPROVED: 'Onaylandı',
    // The matching lifecycle states. Without these the fallback below rendered
    // the raw enum — a customer looking at their own accepted request saw
    // "MATCHED" in an otherwise Turkish screen.
    MATCHED: 'Eşleşti',
    COMPLETED: 'Tamamlandı',
    REJECTED: 'Reddedildi',
    CANCELLED: 'İptal',
    VIEWED: 'Görüntülendi',
    SHORTLISTED: 'Kısa listede',
    ACCEPTED: 'Kabul edildi',
    WITHDRAWN: 'Geri çekildi',
    EXPIRED: 'Süresi doldu',
    PENDING_REVIEW: 'İnceleme bekliyor',
    PENDING: 'Bekliyor',
    PAID: 'Ödendi',
    FAILED: 'Başarısız',
    SUSPENDED: 'Askıya alındı',
    REFUNDED: 'İade edildi',
    DRAFT: 'Taslak',
  };

  return labels[status] ?? status;
}

export function qualityLabel(label: string) {
  const labels: Record<string, string> = {
    HIGH: 'Yüksek',
    MEDIUM: 'Orta',
    LOW: 'Düşük',
  };

  return labels[label] ?? label;
}

/**
 * The customer-facing name of one quality-score component.
 *
 * The API's breakdown is keyed by the identifiers its scoring function uses,
 * and those keys were being printed straight onto the provider's screen. They
 * are field names, not language: a provider reading "cityDistrictPresent" is
 * being shown the implementation. The scores, maximums and pass results are
 * untouched — only the first column changes, and only in wording.
 */
export function qualityBreakdownLabel(key: string): string {
  const labels: Record<string, string> = {
    namePresent: 'Ad soyad bilgisi',
    phonePresent: 'Telefon bilgisi',
    budgetPresent: 'Bütçe bilgisi',
    urgencyPresent: 'Aciliyet bilgisi',
    cityDistrictPresent: 'İl ve ilçe bilgisi',
    descriptionDetailed: 'İş açıklamasının ayrıntısı',
    preferredDatePresent: 'Tercih edilen tarih',
    locationDetailPresent: 'Adres notu',
    requiredAnswersComplete: 'Zorunlu kategori soruları',
    optionalAnswersCompleted: 'İsteğe bağlı kategori soruları',
  };

  const label = labels[key];
  if (label) return label;

  // A component the API grew after this map was written. Spacing the identifier
  // out keeps the row readable instead of dropping it, and a new component is a
  // one-line addition above.
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return spaced.charAt(0).toLocaleUpperCase('tr-TR') + spaced.slice(1);
}

export function qualityBadgeClass(label: string) {
  switch (label) {
    case 'HIGH':
      return 'badge badge-good';
    case 'MEDIUM':
      return 'badge badge-warn';
    case 'LOW':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}

export function statusBadgeClass(status: string) {
  switch (status) {
    case 'APPROVED':
    case 'ACCEPTED':
    case 'PAID':
      return 'badge badge-good';
    case 'PENDING':
    case 'PENDING_REVIEW':
    case 'IN_REVIEW':
    case 'SUBMITTED':
    case 'VIEWED':
    case 'SHORTLISTED':
    case 'DRAFT':
      return 'badge badge-warn';
    case 'REJECTED':
    case 'FAILED':
    case 'CANCELLED':
    case 'SUSPENDED':
    case 'EXPIRED':
    case 'WITHDRAWN':
    case 'REFUNDED':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}

/**
 * The window the platform uses when no operator has chosen one — the same
 * default the API applies, and the term every existing offer was created under.
 *
 * Used only as the fallback for a screen that could not reach the API. Nothing
 * renders it as "the" window.
 */
export const DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS = 48;

/**
 * The one sentence this platform says about credit refunds, and the only one
 * any provider-facing screen may say.
 *
 * A single builder because it is a commercial promise: a screen that
 * paraphrases it promises something the worker does not do.
 *
 * It takes the hours and every caller has to say which hours it means — a
 * screen about an existing offer passes that offer's own snapshot, a screen
 * about the offer a provider is about to send passes the current setting. A
 * hard-coded 48 here would be a promise the worker stops keeping the moment an
 * administrator changes the window.
 */
export function unviewedOfferRefundNotice(windowHours: number) {
  return `Teklifiniz müşteri tarafından ${windowHours} saat içinde görüntülenmezse krediniz otomatik olarak iade edilir.`;
}


/**
 * The stored urgency code in the words a customer reads.
 *
 * The table is @taktic/shared's, not this file's: the admin app and the API's
 * e-mail templates render the same column, and three private copies is how
 * `THIS_WEEK` reached an inbox. `-` rather than the raw code for anything the
 * shared table does not know — an unmapped option is a gap in that table, not
 * something to show a customer.
 */
export function urgencyLabel(urgency: string | null) {
  return sharedUrgencyLabel(urgency) ?? '-';
}

export function creditTxnTypeLabel(type: string) {
  const labels: Record<string, string> = {
    ADMIN_GRANT: 'Yönetici eklemesi',
    ADMIN_DEDUCT: 'Yönetici düşüşü',
    PACKAGE_PURCHASE: 'Paket alımı',
    OFFER_SPEND: 'Teklif harcaması',
    OFFER_REFUND: 'Teklif iadesi',
    ADJUSTMENT: 'Düzeltme',
  };

  return labels[type] ?? type;
}

// `amountMinor` is the monetary value in the currency's minor unit (e.g. kuruş for TRY,
// cents for USD/EUR). The function converts it back to a human-readable string with
// two fractional digits, matching the storage contract used across the platform.
// Example: formatPrice(49900, 'TRY') -> "₺499,00"
export function formatPrice(amountMinor: number, currency: string = 'TRY') {
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

// Mirrors apps/admin/lib/api.ts#parseDecimalToMinor. Accepts user-entered decimal
// strings ("149.90", "149,90", "1500", numeric values) and returns the minor-unit
// integer (kuruş for TRY). Empty / invalid / negative values become null so optional
// form fields can preserve "no value". API DTOs still enforce @Min(100) for safety.
export function parseDecimalToMinor(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    raw = String(value);
  } else {
    raw = value.trim();
    if (!raw) return null;
  }

  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const major = Number(normalized);
  if (!Number.isFinite(major) || major < 0) {
    return null;
  }

  return Math.round(major * 100);
}

// Renders a minor-unit integer as a "x.xx" string suitable for a controlled
// decimal <input>. Null/undefined become an empty string so optional form fields
// stay empty by default.
export function formatMinorAsInput(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) {
    return '';
  }
  if (!Number.isFinite(amountMinor)) {
    return '';
  }
  return (amountMinor / 100).toFixed(2);
}

/**
 * Re-exported from @taktic/shared rather than reimplemented.
 *
 * These used to call `toLocaleDateString('tr-TR', …)` with no `timeZone`, which
 * means "whatever zone this process is in". The server renders in the
 * container's UTC and the browser re-renders in the visitor's UTC+3, so the two
 * produced different text for the same instant and React tore the tree down on
 * hydration. The shared implementation pins both the zone and the locale, so
 * SSR and the first client render agree by construction.
 */
export { formatDate, formatDateTime, formatTime } from '@taktic/shared';

/**
 * The four statuses a support ticket can be in, and how each one reads.
 *
 * Lives here rather than in `lib/api.ts` because the ticket screens are partly
 * Client Components — the composer and its counter — and that module imports
 * `next/headers`.
 */
export const SUPPORT_TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

const SUPPORT_TICKET_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: 'Açık',
  IN_PROGRESS: 'İşlemde',
  RESOLVED: 'Çözüldü',
  CLOSED: 'Kapatıldı',
};

export function supportTicketStatusLabel(status: string): string {
  return SUPPORT_TICKET_STATUS_LABELS[status as SupportTicketStatus] ?? status;
}

/**
 * The badge a status wears.
 *
 * "Çözüldü" is the one state the customer panel fills with ink, for the same
 * reason a match is: it is the outcome the whole screen exists to reach.
 * "Kapatıldı" is deliberately quiet — it is an ending, not an achievement.
 */
export function supportTicketStatusBadgeClass(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'cdash-badge cdash-badge-info';
    case 'IN_PROGRESS':
      return 'cdash-badge cdash-badge-muted';
    case 'RESOLVED':
      return 'cdash-badge cdash-badge-success';
    case 'CLOSED':
      return 'cdash-badge cdash-badge-danger';
    default:
      return 'cdash-badge';
  }
}

/**
 * What a recorded status change says on the timeline.
 *
 * Written from the destination alone: "who moved it from what" is an internal
 * fact, and a customer reading their own ticket needs to know what happened to
 * it rather than which operator did the moving.
 */
export function supportTicketStatusChangeLabel(toStatus: string): string {
  switch (toStatus) {
    case 'OPEN':
      return 'Talep yeniden açık duruma alındı.';
    case 'IN_PROGRESS':
      return 'Talep işleme alındı.';
    case 'RESOLVED':
      return 'Talep çözüldü olarak işaretlendi.';
    case 'CLOSED':
      return 'Talep kapatıldı.';
    default:
      return `Talep durumu ${supportTicketStatusLabel(toStatus)} olarak güncellendi.`;
  }
}
