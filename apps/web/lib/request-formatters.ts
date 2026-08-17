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

export function formatDate(value: string | null | undefined): string {
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

export function formatDateTime(value: string | null | undefined): string {
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
