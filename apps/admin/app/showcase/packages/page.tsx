import { formatMinorAsTurkishLira } from '@taktic/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  SHOWCASE_CARD_KIND_LABELS,
  type ShowcasePackage,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { WholeListFooter } from '../../../components/pagination';
import { RouteDialog } from '../../../components/route-dialog';
import { createShowcasePackageAction } from './actions';
import { ShowcasePackageCreateSubmit } from './showcase-package-gates';
import { PriceField, showcasePackageErrorText, SORT_ORDER_HELP } from './showcase-package-fields';

type PackagesPageProps = {
  searchParams: Promise<{ paket?: string; error?: string; created?: string }>;
};

/**
 * The catalogue's own listing order, under "Gelişmiş ayarlar" in the
 * new-package window because it is not a fact about the package.
 */
function AdvancedSettings({ sortOrder }: { sortOrder: number }) {
  return (
    <details className="form-grid-wide">
      <summary>Gelişmiş ayarlar</summary>
      <label>
        <span>Listeleme sırası</span>
        <input name="sortOrder" type="number" min={0} defaultValue={sortOrder} />
        <small>{SORT_ORDER_HELP}</small>
      </label>
    </details>
  );
}

const PATH = '/showcase/packages';

/** `?paket=yeni` opens the new-package window; any other value names a package. */
const NEW_PACKAGE_KEY = 'yeni';

/**
 * Vitrin paketleri (#21), design `list:showcasePackages` (paket 2
 * `36-vitrin-paketleri`, ADMIN-DESIGN-001 Faz 3C).
 *
 * The vitrin catalogue.
 *
 * ## Why this is not a tab on the credit-package screen
 *
 * They are different products with different rules, and one screen would invite
 * the mistake this whole design exists to prevent: a vitrin package is never an
 * offering right. Keeping them apart also keeps the two slug namespaces visibly
 * separate, which is the thing that stops one payment variant standing for both.
 *
 * ## What the screen is careful to say
 *
 * That the price here is **the platform's listing fee**, not the price a
 * business charges its customer. The two never appear in the same table
 * anywhere in this product, and the sentence on this page is where an operator
 * setting the number is told which one they are setting.
 *
 * ## List, the new-package window, and a screen per package
 *
 * The design's list with "Aç" and "Yeni paket ekle". "Yeni paket ekle" opens a
 * window at `?paket=yeni`; "Aç" opens the package's own detail screen
 * (`/showcase/packages/<id>`, ADMIN-DESIGN-001 Faz 3F.1), which holds what the
 * old `?paket=<id>` window held — the same fields, server action and rules —
 * plus the package's sales and runs. An old `?paket=<id>` link is sent there.
 * The slug is written once, at creation, and shown — never sent — afterwards.
 * Not drawn from the design: its Ara, Durum and Tarih filters (the API takes
 * none; the catalogue is a handful of rows).
 */

/** The design's ⓘ; each sentence checked against showcase-packages.service.ts. */
const SCREEN_INFO =
  'İşletmelerin kartlarını yayına almak için satın aldığı süreli paketler. Buradaki "yayın bedeli" TakTick\'in aldığı yerleşim ücretidir; işletmenin müşterisinden aldığı hizmet bedeliyle ilgisi yoktur. "Geçerlilik", ödemeden sonra kartın onaylanıp yayına girmesi için tanınan süredir; inceleme süresi bu süreden sayılmaz. Fiyat ve süre değişikliği yalnız sonraki satın almaları etkiler, satılmış her yayın kendi anlık kopyasını taşır. Kısa ad sonradan değiştirilemez. Hiçbir paket bir karta sıralama önceliği vermez.';

const COLUMNS: DataColumn[] = [
  { key: 'name', label: 'Paket' },
  { key: 'slug', label: 'Kısa ad' },
  { key: 'price', label: 'Yayın bedeli', align: 'end' },
  { key: 'duration', label: 'Süre' },
  { key: 'window', label: 'Geçerlilik' },
  { key: 'kind', label: 'Kart tipi' },
  { key: 'areas', label: 'Bölge' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function ShowcasePackagesPage({ searchParams }: PackagesPageProps) {
  const { can } = await requireAdmin('SHOWCASE_PACKAGES_READ');
  // Creating is SHOWCASE_PACKAGES_WRITE; without it there is no window.
  const canWrite = can('SHOWCASE_PACKAGES_WRITE');

  const { paket, error, created } = await searchParams;
  const { packages } = await apiFetch<{ packages: ShowcasePackage[] }>('/admin/showcase/packages');

  const openKey = (paket ?? '').trim();
  const isNew = openKey === NEW_PACKAGE_KEY && canWrite;
  const opened = openKey && openKey !== NEW_PACKAGE_KEY ? (packages.find((pkg) => pkg.id === openKey) ?? null) : null;
  // The package window moved to its own screen: an old link still arrives.
  if (opened) {
    redirect(`${PATH}/${encodeURIComponent(opened.id)}${error ? `?${new URLSearchParams({ error })}` : ''}`);
  }
  const errorText = showcasePackageErrorText(error);
  const onSale = packages.filter((pkg) => pkg.isActive).length;

  return (
    <main className="showcase-packages-page">
      <PageHeader
        title="Vitrin paketleri"
        subtitle={
          packages.length === 0
            ? 'Henüz vitrin paketi yok'
            : `${onSale} paket satışta${packages.length > onSale ? ` · ${packages.length - onSale} kapalı` : ''}`
        }
        info={SCREEN_INFO}
        /*
          The consent ledger, reachable from the catalogue that produced the
          text it records, beside the design's primary action.
        */
        actions={
          <>
            {can('SHOWCASE_TERMS_ACCEPTANCES_READ') ? (
              <Link className="btn btn-secondary" href="/showcase/price-terms">
                Metin onayları
              </Link>
            ) : null}
            {canWrite ? (
              <Link
                className="btn btn-primary"
                href={`${PATH}?paket=${NEW_PACKAGE_KEY}`}
                scroll={false}
                data-testid="showcase-package-new"
              >
                Yeni paket ekle
              </Link>
            ) : null}
          </>
        }
      />

      {/* An error that belongs to no window (e.g. an unknown package) stays on the page. */}
      {errorText && !isNew ? (
        <div className="notice notice-error detail-notice" role="alert">
          {errorText}
        </div>
      ) : null}
      {created ? (
        <div className="notice detail-notice" role="status">
          Paket oluşturuldu.
        </div>
      ) : null}
      {openKey && !isNew ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="showcase-package-missing">
          Bu bağlantının gösterdiği vitrin paketi bulunamadı.
        </div>
      ) : null}

      <div className="data-list-card">
        {packages.length === 0 ? (
          <EmptyState
            title="Paket yok"
            description={
              canWrite
                ? 'Henüz bir vitrin paketi tanımlanmadı. "Yeni paket ekle" ile ilkini oluşturabilirsiniz.'
                : 'Henüz bir vitrin paketi tanımlanmadı.'
            }
          />
        ) : (
          <DataTable caption="Vitrin paketleri" columns={COLUMNS} minWidth={1080} testId="showcase-package-table">
            {packages.map((pkg) => (
              <tr key={pkg.id} data-testid="showcase-package-row" data-package-id={pkg.id}>
                <td>
                  <div className="cell-stack">
                    <strong className="cell-break" id={`showcase-package-name-${pkg.id}`}>
                      {pkg.name}
                    </strong>
                    {pkg.description ? <span className="cell-muted cell-break">{pkg.description}</span> : null}
                    <span className="cell-muted">Oluşturma: {formatDateTime(pkg.createdAt)}</span>
                  </div>
                </td>
                <td>
                  <code>{pkg.slug}</code>
                </td>
                <td className="is-num" data-testid="showcase-package-price-cell">
                  <strong>{formatMinorAsTurkishLira(pkg.priceAmount, pkg.currency)}</strong>
                </td>
                <td>{pkg.durationDays} gün</td>
                <td>{pkg.activationWindowDays} gün</td>
                <td>{pkg.allowedCardKind ? SHOWCASE_CARD_KIND_LABELS[pkg.allowedCardKind] : 'Her ikisi'}</td>
                <td>{pkg.maxAreas === null ? 'Tümü' : `En fazla ${pkg.maxAreas}`}</td>
                <td>
                  <span className={pkg.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                    {pkg.isActive ? 'Satışta' : 'Kapalı'}
                  </span>
                </td>
                <td className="col-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    href={`${PATH}/${encodeURIComponent(pkg.id)}`}
                    aria-describedby={`showcase-package-name-${pkg.id}`}
                    data-testid="showcase-package-open"
                  >
                    Aç
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {packages.length > 0 ? (
          <WholeListFooter count={packages.length} noun="paket" summaryTestId="showcase-package-count" />
        ) : null}
      </div>

      {isNew ? (
        <RouteDialog title="Yeni vitrin paketi" closeHref={PATH} testId="showcase-package-dialog">
          {errorText ? (
            <div className="notice notice-error" role="alert">
              {errorText}
            </div>
          ) : null}
          <p className="detail-muted-note">
            Yayın bedeli TakTick&apos;in tahsil ettiği yerleşim ücretidir; hizmet verenin müşterisinden aldığı hizmet
            bedeliyle ilgisi yoktur.
          </p>
          <form action={createShowcasePackageAction} className="form-grid" style={{ marginTop: 16 }}>
            <label>
              <span>Ad *</span>
              <input name="name" required minLength={3} maxLength={120} />
            </label>
            <label>
              <span>Kısa ad *</span>
              <input
                name="slug"
                required
                pattern="vitrin-[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="vitrin-standart-30"
              />
              {/*
                The rule is stated here rather than only enforced, because an
                operator hitting a pattern error deserves to know it is protecting
                the payment mapping rather than a naming preference.
              */}
              <small>
                &quot;vitrin-&quot; ile başlamalı. Bu ön ek, ödeme sağlayıcısındaki ürün
                eşlemesinde teklif paketleriyle çakışmayı imkânsız kılar. Sonradan
                değiştirilemez.
              </small>
            </label>
            <PriceField />
            <label>
              <span>Süre (gün) *</span>
              <input name="durationDays" type="number" min={1} max={365} required />
            </label>
            <label>
              <span>Kullanılmamış hakkın geçerliliği (gün) *</span>
              <input
                name="activationWindowDays"
                type="number"
                min={1}
                max={365}
                step={1}
                defaultValue={90}
                required
              />
              <small>
                Ödemeden itibaren kartın onaylanıp yayına girmesi için tanınan süre. İnceleme
                süresi sayılmaz.
              </small>
            </label>
            <label>
              <span>Kart tipi</span>
              <select name="allowedCardKind" defaultValue="">
                <option value="">Her ikisi</option>
                <option value="SERVICE">Hizmet vitrini</option>
                <option value="PROMOTION">Genel tanıtım</option>
              </select>
            </label>
            <label>
              <span>Azami bölge sayısı</span>
              <input name="maxAreas" type="number" min={1} max={25} placeholder="Boş: tümü" />
            </label>
            <label className="form-grid-wide">
              <span>Açıklama</span>
              <textarea
                name="description"
                maxLength={600}
                placeholder="30 gün boyunca vitrin sayfalarında yayınlanın ve kartınızdan doğrudan talep alın."
              />
              <small>
                Hizmet verenin gördüğü metin. Yalnız paketin sağladığını yazın: yayın süresi ve
                karttan doğrudan talep. Taleplerde öncelik, sıralama veya öne çıkma vaadi vermeyin;
                böyle bir mekanizma yoktur.
              </small>
            </label>
            <AdvancedSettings sortOrder={0} />

            <div className="form-actions form-grid-wide">
              <Link className="btn btn-secondary" href={PATH} scroll={false}>
                Vazgeç
              </Link>
              {/* On sale the moment it exists, with a permanent slug: asks first. */}
              <ShowcasePackageCreateSubmit />
            </div>
          </form>
        </RouteDialog>
      ) : null}

    </main>
  );
}
