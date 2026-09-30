import type { AdminOfferPackage, OfferPackageType } from '../../lib/api';

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
 * Aktifleştir / Pasifleştir, with CREDIT_PACKAGES_STATUS only. Not a
 * confirmation: deactivating closes new sales and nothing else, and is undone
 * by the same button.
 */
export function PackageStatusForm({
  pkg,
  redirectTo,
  action,
  variant = 'row',
}: {
  pkg: Pick<AdminOfferPackage, 'id' | 'isActive'>;
  redirectTo: string;
  action: FormAction;
  /** `row` in the list, `panel` on the detail screen's status card. */
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
        ? 'btn btn-destructive btn-sm'
        : 'btn btn-primary btn-sm'
      : 'btn btn-secondary btn-sm';

  return (
    <form action={action}>
      <input type="hidden" name="id" value={pkg.id} />
      <input type="hidden" name="isActive" value={String(!pkg.isActive)} />
      <input type="hidden" name="redirectTo" value={redirectTo} />
      <button className={className} type="submit" data-testid="package-status-toggle">
        {label}
      </button>
    </form>
  );
}
