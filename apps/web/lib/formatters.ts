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

export function refundActionLabel(action: string) {
  const labels: Record<string, string> = {
    FULL_REFUND: 'Tam iade önerilir',
    MANUAL_REVIEW: 'Manuel inceleme',
    NO_REFUND: 'İade yok',
  };

  return labels[action] ?? action;
}

export function refundActionBadgeClass(action: string) {
  switch (action) {
    case 'FULL_REFUND':
      return 'badge badge-good';
    case 'MANUAL_REVIEW':
      return 'badge badge-warn';
    case 'NO_REFUND':
      return 'badge badge-muted';
    default:
      return 'badge';
  }
}

export function urgencyLabel(urgency: string | null) {
  if (!urgency) return '-';
  const labels: Record<string, string> = {
    ASAP: 'En kısa zamanda',
    WITHIN_DAYS: 'Birkaç gün içinde',
    WITHIN_WEEKS: 'Birkaç hafta içinde',
    FLEXIBLE: 'Esnek',
    THIS_WEEK: 'Bu hafta',
    THIS_MONTH: 'Bu ay',
  };

  return labels[urgency] ?? urgency;
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

export function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return value;
  }
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}
