import { formatMinorAsTurkishLira } from '@taktic/shared';
import type { AdminOfferPackage, OfferPackageType } from '../../lib/api';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { creditPackageOfferText } from './package-changes';

/**
 * The pieces of the credit-package screens (ADMIN-DESIGN-001 Faz 3F) that
 * decide something on their own — the words for the three package types,
 * what a package sells in one cell, and which row controls a permission
 * draws — apart from the pages so they can be checked without a session.
 */

export type FormAction = (formData: FormData) => void | Promise<void>;

export const PACKAGE_TYPE_LABEL: Record<OfferPackageType, string> = {
  ONE_TIME_CREDITS: 'Tek seferlik kredi',
  MONTHLY_QUOTA: 'Aylık kota',
  CATEGORY_UNLIMITED: 'Kategori limitsiz',
};

export function packageTypeLabel(type: string): string {
  return PACKAGE_TYPE_LABEL[type as OfferPackageType] ?? type;
}

/**
 * The design's ⓘ, corrected against the code: a monthly quota is a 30-day
 * period from the purchase, not a calendar month, and unused quota does not
 * roll over; an unlimited package's daily cap is optional; the order is the
 * order packages are listed to a provider in.
 */
export const CREDIT_PACKAGES_SCREEN_INFO =
  'Hizmet verenlerin teklif verebilmek için satın aldığı paketler. Üç tür vardır: "Tek seferlik kredi" (belirli sayıda kredi yüklenir, süresi dolmaz), "Aylık kota" (satın alma anından itibaren 30 gün geçerli kredi hakkı; kullanılmayan kota devretmez) ve "Kategori limitsiz" (seçili kategorilerde 30 gün boyunca kredi harcamadan teklif; isteğe bağlı günlük sınırla). Tür paket oluşturulurken seçilir, sonradan değiştirilemez. Pasifleştirdiğiniz paket yeni satışa kapanır; satılmış paketleri ve yüklenmiş kredileri etkilemez. Satın almalar paketin o anki adını, kredisini ve fiyatını kopyalar, sonraki düzenlemeler eski kayıtları değiştirmez. Sıra, paketlerin hizmet verene listelenme düzenidir (küçük sayı önce).';

/**
 * One sentence per type for the detail screen's "Paketin diğer türleri" card —
 * the ⓘ above, split by type, so the two can never say different things.
 */
export const PACKAGE_TYPE_DESCRIPTION: Record<OfferPackageType, string> = {
  ONE_TIME_CREDITS: 'Belirli sayıda kredi bir kez yüklenir, süresi dolmaz.',
  MONTHLY_QUOTA: 'Satın alma anından itibaren 30 gün geçerli kredi hakkı. Kullanılmayan kota devretmez.',
  CATEGORY_UNLIMITED: 'Seçili kategorilerde 30 gün boyunca kredi harcamadan teklif; isteğe bağlı günlük sınırla.',
};

/**
 * The line under the package's name: what this one package does, in the
 * words of its type and its own figures.
 */
export function packageSummarySentence(
  pkg: Pick<
    AdminOfferPackage,
    'type' | 'creditAmount' | 'quotaCredits' | 'periodDays' | 'dailyOfferLimit' | 'scopeCategories'
  >,
): string {
  if (pkg.type === 'MONTHLY_QUOTA') {
    return `Satın alma anından itibaren ${pkg.periodDays ?? 30} gün geçerli ${pkg.quotaCredits ?? 0} kredi hakkı verir; kullanılmayan kota devretmez.`;
  }
  if (pkg.type === 'CATEGORY_UNLIMITED') {
    const scope =
      pkg.scopeCategories.length > 0
        ? `Kapsam: ${pkg.scopeCategories.map((entry) => entry.category.name).join(', ')}`
        : 'Kapsam tanımsız';
    const limit = pkg.dailyOfferLimit ? `günlük en fazla ${pkg.dailyOfferLimit} teklif` : 'günlük sınır yok';
    return `${scope} · kredi harcamadan teklif, ${limit}.`;
  }
  return `Hizmet verenin hesabına tek seferde ${pkg.creditAmount} kredi yükler. Kredilerin son kullanma tarihi yoktur.`;
}

/**
 * What one credit costs in this package, in the package's minor unit, or
 * `null` where the question has no answer (an unlimited package, or none sold).
 */
export function perCreditMinor(
  pkg: Pick<AdminOfferPackage, 'type' | 'creditAmount' | 'quotaCredits' | 'priceAmount'>,
): number | null {
  const credits =
    pkg.type === 'ONE_TIME_CREDITS' ? pkg.creditAmount : pkg.type === 'MONTHLY_QUOTA' ? pkg.quotaCredits : null;
  if (!credits || credits <= 0) return null;
  return Math.round(pkg.priceAmount / credits);
}

/** What a package sells, in the "Kredi / kota" cell. */
export function packageAllowance(pkg: Pick<AdminOfferPackage, 'type' | 'creditAmount' | 'quotaCredits'>): string {
  if (pkg.type === 'MONTHLY_QUOTA') return pkg.quotaCredits === null ? '—' : String(pkg.quotaCredits);
  if (pkg.type === 'CATEGORY_UNLIMITED') return 'Limitsiz';
  return String(pkg.creditAmount);
}

/**
 * Sıra ↑/↓ and the package's order.
 *
 * The arrows are CREDIT_PACKAGES_WRITE (a reorder is two PATCHes of
 * `sortOrder`) and exist only for a session that holds it; ↑ is closed on the
 * first package of the canonical order and ↓ on the last. The number is always
 * drawn.
 */
export function PackageOrderCell({
  pkg,
  canWrite,
  isFirst,
  isLast,
  moveAction,
}: {
  pkg: Pick<AdminOfferPackage, 'id' | 'name' | 'sortOrder'>;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  moveAction: FormAction;
}) {
  return (
    <div className="package-order-cell">
      {canWrite ? (
        <>
          <form action={moveAction}>
            <input type="hidden" name="id" value={pkg.id} />
            <input type="hidden" name="direction" value="up" />
            <button
              type="submit"
              className="btn btn-ghost btn-sm package-order-button"
              aria-label="Yukarı taşı"
              title={`${pkg.name}: yukarı taşı`}
              disabled={isFirst}
              data-testid="package-move-up"
            >
              ↑
            </button>
          </form>
          <form action={moveAction}>
            <input type="hidden" name="id" value={pkg.id} />
            <input type="hidden" name="direction" value="down" />
            <button
              type="submit"
              className="btn btn-ghost btn-sm package-order-button"
              aria-label="Aşağı taşı"
              title={`${pkg.name}: aşağı taşı`}
              disabled={isLast}
              data-testid="package-move-down"
            >
              ↓
            </button>
          </form>
        </>
      ) : null}
      <span className="package-order-value" data-testid="package-sort-order">
        {pkg.sortOrder}
      </span>
    </div>
  );
}

/**
 * Aktifleştir / Pasifleştir, with CREDIT_PACKAGES_STATUS only.
 *
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A: both directions ask first, in
 * the list row and on the detail screen alike — activating puts the package
 * on sale at its price (`credit-package.activate`, with the price and what it
 * sells in the dialog); deactivating closes new sales and changes nothing
 * already bought (`credit-package.deactivate`). The form, its three fields
 * and the action are unchanged; the action demands the proof of the direction
 * it is asked for.
 */
export function PackageStatusForm({
  pkg,
  redirectTo,
  action,
  variant = 'row',
}: {
  pkg: Pick<
    AdminOfferPackage,
    'id' | 'name' | 'isActive' | 'type' | 'priceAmount' | 'currency' | 'creditAmount' | 'quotaCredits' | 'dailyOfferLimit'
  >;
  redirectTo: string;
  action: FormAction;
  /** `row` in the list, `panel` in the detail screen's summary card. */
  variant?: 'row' | 'panel';
}) {
  const label =
    variant === 'panel'
      ? pkg.isActive
        ? 'Paketi pasifleştir'
        : 'Paketi aktifleştir'
      : pkg.isActive
        ? 'Pasifleştir'
        : 'Aktifleştir';
  const className =
    variant === 'panel'
      ? pkg.isActive
        ? 'btn btn-destructive'
        : 'btn btn-primary'
      : 'btn btn-secondary btn-sm';

  return (
    <form action={action}>
      <input type="hidden" name="id" value={pkg.id} />
      <input type="hidden" name="isActive" value={String(!pkg.isActive)} />
      <input type="hidden" name="redirectTo" value={redirectTo} />
      {pkg.isActive ? (
        <ConfirmDialog
          proof="credit-package.deactivate"
          triggerLabel={label}
          triggerClassName={className}
          tone="primary"
          title={`“${pkg.name}” pasifleştirilsin mi?`}
          consequence={
            <>
              <p>
                Paket <strong>yeni satışa kapanır</strong>: hizmet verenlerin satın alma ekranında görünmez ve satın
                alınamaz.
              </p>
              <p>
                Mevcut satın almalar, yüklenmiş krediler ve devam eden dönemler <strong>değişmez</strong>. Paket aynı
                düğmeyle yeniden aktifleştirilebilir.
              </p>
            </>
          }
          confirmLabel="Evet, pasifleştir"
          testId="package-status-toggle"
        />
      ) : (
        <ConfirmDialog
          proof="credit-package.activate"
          triggerLabel={label}
          triggerClassName={className}
          tone="primary"
          title={`“${pkg.name}” aktifleştirilsin mi?`}
          consequence={
            <>
              <dl className="confirm-dialog-facts">
                <div>
                  <dt>Fiyat</dt>
                  <dd>{formatMinorAsTurkishLira(pkg.priceAmount, pkg.currency)}</dd>
                </div>
                <div>
                  <dt>Satılan</dt>
                  <dd>{creditPackageOfferText(pkg)}</dd>
                </div>
              </dl>
              <p>
                Paket onaydan hemen sonra <strong>satışa açılır</strong>: hizmet verenler bu fiyatla satın alabilir.
                Satın alma anındaki fiyat ve kredi o satın almaya kopyalanır.
              </p>
            </>
          }
          confirmLabel="Evet, aktifleştir"
          testId="package-status-toggle"
        />
      )}
    </form>
  );
}
