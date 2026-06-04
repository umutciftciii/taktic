// Reason metni hem teknik enum koduyla (örn. "NOT_VIEWED_48H") hem de admin/sistem
// tarafından girilmiş serbest açıklamayla (":" sonrası) gelebiliyor. Bilinen
// prefix'leri Türkçe etikete çeviriyoruz; serbest metni "Not: …" satırında
// koruyoruz ki audit takibi kaybolmasın.
const REASON_LABELS: Record<string, string> = {
  NOT_VIEWED_48H: 'Teklif 48 saat içinde görüntülenmedi',
  OFFER_SPEND: 'Teklif gönderimi',
  OFFER_REFUND: 'Teklif iadesi',
  PACKAGE_PURCHASE: 'Paket satın alımı',
  ADMIN_GRANT: 'Yönetici kredi ekledi',
  ADMIN_DEDUCT: 'Yönetici kredi düşümü yaptı',
  ADJUSTMENT: 'Sistem düzeltmesi',
  MANUAL_ADJUSTMENT: 'Manuel düzeltme',
  ADMIN_REFUND: 'Yönetici iadesi',
  AUTO_REFUND: 'Otomatik iade',
};

export type LedgerReason = {
  label: string;
  note: string | null;
};

export function formatLedgerReason(raw: string | null | undefined): LedgerReason | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf(':');
  const head = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
  const tail = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : '';

  const mapped = REASON_LABELS[head];
  if (mapped) {
    return { label: mapped, note: tail || null };
  }
  return { label: trimmed, note: null };
}

const REFERENCE_TYPE_LABELS: Record<string, string> = {
  Offer: 'Teklif kaydı',
  PackagePurchase: 'Paket satın alma',
};

export type LedgerSource = {
  label: string;
  shortId: string | null;
  href: string | null;
  isSystem: boolean;
};

const SYSTEM_SOURCE_LABEL = 'Sistem / manuel işlem';

function shortenId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}…`;
}

export function formatLedgerSource(
  referenceType: string | null | undefined,
  referenceId: string | null | undefined,
): LedgerSource {
  if (!referenceType) {
    return { label: SYSTEM_SOURCE_LABEL, shortId: null, href: null, isSystem: true };
  }

  const label = REFERENCE_TYPE_LABELS[referenceType] ?? referenceType;
  const shortId = referenceId ? shortenId(referenceId) : null;

  let href: string | null = null;
  if (referenceId) {
    if (referenceType === 'Offer') href = `/offers/${referenceId}`;
    else if (referenceType === 'PackagePurchase') href = `/package-purchases/${referenceId}`;
  }

  return { label, shortId, href, isSystem: false };
}
