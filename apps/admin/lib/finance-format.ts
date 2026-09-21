// Reason metni bugün yalnız politika koduyla gelir (örn. "UNVIEWED_OFFER_48H").
// Kaldırılan manuel iade yolundan kalan eski satırlarda ":" sonrasında serbest
// açıklama bulunabilir. Bilinen prefix'leri Türkçe etikete çeviriyoruz; serbest
// metni "Not: …" satırında koruyoruz ki audit takibi kaybolmasın.
const REASON_LABELS: Record<string, string> = {
  // Written by the unviewed-offer refund worker, and the only refund reason the
  // platform produces today. NOT_VIEWED_48H is kept for ledger rows the removed
  // manual refund path wrote before this policy.
  //
  // The stored code keeps its "48H" spelling even though the window is now
  // configurable: it is an identifier already written onto historical ledger
  // rows, and renaming it would split every report that groups by it. The label
  // names no duration, because two rows carrying this code can have been
  // refunded under two different windows.
  UNVIEWED_OFFER_48H: 'Teklif iade süresi içinde görüntülenmedi',
  // Manuel operasyon iadesi. Operasyon gerekçesi ":" sonrasında saklanır ve
  // "Not: …" satırında görünür; ürünün iade politikası değildir.
  MANUAL_ADMIN_REFUND: 'Yönetici manuel kredi iadesi',
  NOT_VIEWED_48H: 'Teklif iade süresi içinde görüntülenmedi',
  OFFER_SPEND: 'Teklif gönderimi',
  OFFER_REFUND: 'Teklif iadesi',
  PACKAGE_PURCHASE: 'Paket satın alımı',
  ADMIN_GRANT: 'Yönetici kredi ekledi',
  ADMIN_DEDUCT: 'Yönetici kredi düşümü yaptı',
  ADJUSTMENT: 'Sistem düzeltmesi',
  MANUAL_ADJUSTMENT: 'Manuel düzeltme',
  ADMIN_REFUND: 'Yönetici iadesi',
  AUTO_REFUND: 'Otomatik iade',
  // CMP-004 S4: the campaign ledger codes (`promo-credit-ledger.ts`
  // PROMO_LEDGER_REASON). The two with a tail are handled below, because
  // their tail is the meaning, not an operator's note.
  CAMPAIGN_GRANT: 'Kampanya promosyon kredisi',
  PROMO_LOT_EXPIRED: 'Promosyon süresi doldu',
};

/**
 * The campaign codes whose `:` tail names a cause, folded into the label so
 * the screen never prints "Not: PAYMENT_REVERSED" under a promotion row.
 */
const TAILED_CAMPAIGN_REASONS: Record<string, (tail: string) => string> = {
  PROMO_LOT_REVOKED: (tail) =>
    `Promosyon geri alındı (${tail === 'PAYMENT_REVERSED' ? 'ödeme iadesi' : tail === 'ADMIN_REVOKED' ? 'yönetici' : tail.toLowerCase()})`,
  PROMO_FORFEIT_ON_REFUND: (tail) =>
    `Teklif iadesinde promosyon payı düştü (${tail === 'REVOKED' ? 'geri alınmış lot' : tail === 'EXPIRED' ? 'süresi dolmuş lot' : tail.toLowerCase()})`,
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

  const tailed = TAILED_CAMPAIGN_REASONS[head];
  if (tailed) {
    return { label: tailed(tail), note: null };
  }
  const mapped = REASON_LABELS[head];
  if (mapped) {
    return { label: mapped, note: tail || null };
  }
  return { label: trimmed, note: null };
}

const REFERENCE_TYPE_LABELS: Record<string, string> = {
  Offer: 'Teklif kaydı',
  PackagePurchase: 'Paket satın alma',
  CampaignRedemption: 'Kampanya hak edişi',
  PromoCreditLot: 'Promosyon lotu',
  PromoCreditLotConsumption: 'Promosyon payı',
};

/** The campaign the API resolved behind a CAMPAIGN_* row (CMP-004 S4). */
export type LedgerCampaignRef = { id: string; name: string; versionNumber: number };

export type LedgerSource = {
  label: string;
  displayNumber: string | null;
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
  sourceNumber?: string | null,
  campaign?: LedgerCampaignRef | null,
): LedgerSource {
  // A campaign row links to the campaign itself, by name and rule version —
  // the reference the row carries (redemption, lot, share) is an accounting
  // key with no screen of its own.
  if (campaign) {
    return {
      label: 'Kampanya',
      displayNumber: `${campaign.name} · sürüm ${campaign.versionNumber}`,
      shortId: null,
      href: `/campaigns/${campaign.id}`,
      isSystem: false,
    };
  }
  if (!referenceType) {
    return {
      label: SYSTEM_SOURCE_LABEL,
      displayNumber: null,
      shortId: null,
      href: null,
      isSystem: true,
    };
  }

  const label = REFERENCE_TYPE_LABELS[referenceType] ?? referenceType;
  const displayNumber = sourceNumber ?? null;
  const shortId = displayNumber || !referenceId ? null : shortenId(referenceId);

  let href: string | null = null;
  if (referenceId) {
    if (referenceType === 'Offer') href = `/offers/${referenceId}`;
    else if (referenceType === 'PackagePurchase') href = `/package-purchases/${referenceId}`;
  }

  return { label, displayNumber, shortId, href, isSystem: false };
}
