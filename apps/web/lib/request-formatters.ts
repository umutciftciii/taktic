export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    SUBMITTED: 'Gönderildi',
    IN_REVIEW: 'İncelemede',
    APPROVED: 'Onaylandı',
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

export function formatPrice(amount: number, currency: string = 'TRY'): string {
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
