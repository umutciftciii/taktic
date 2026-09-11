import { formatMinorAsTurkishLira, formatMinorAsTurkishLiraInput } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  SHOWCASE_CARD_KIND_LABELS,
  type ShowcasePackage,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { createShowcasePackageAction, updateShowcasePackageAction } from './actions';

type PackagesPageProps = {
  searchParams: Promise<{ error?: string; created?: string; saved?: string }>;
};

const ERRORS: Record<string, string> = {
  SHOWCASE_PACKAGE_SLUG_INVALID:
    'Kısa ad "vitrin-" ile başlamak zorunda. Bu ön ek, ödeme sağlayıcısındaki ürün eşlemesinin teklif paketleriyle çakışmasını engeller.',
  SHOWCASE_PACKAGE_SLUG_TAKEN: 'Bu kısa ad başka bir vitrin paketinde kullanılıyor.',
  SHOWCASE_PACKAGE_NOT_FOUND: 'Vitrin paketi bulunamadı.',
  SHOWCASE_PACKAGE_PRICE_INVALID:
    'Yayın bedeli Türk lirası olarak girilmeli: örn. 10, 10,50 veya 1.250,75. Sıfır, eksi ve ikiden fazla ondalık kabul edilmez.',
  SHOWCASE_PACKAGE_SAVE_FAILED: 'Paket kaydedilemedi. Alanları kontrol edip tekrar deneyin.',
};

/**
 * The price field, as the operator sees it: lira, with a comma for kuruş.
 *
 * Kuruş are the storage unit and never the form's language. The field is a
 * text input rather than `type="number"` because a number input cannot hold
 * `1.250,75` — it reads the dot as a decimal point and the comma as a typo —
 * and `inputMode="decimal"` keeps the numeric keyboard on a phone. The server
 * action parses it with the shared helper; the pattern here only spares the
 * operator a round trip for the obvious cases.
 */
const PRICE_HELP = 'Türk lirası. Kuruş için virgül kullanın: 10, 10,50 veya 1.250,75.';
const PRICE_PATTERN = '([0-9]{1,3}(\\.[0-9]{3})*|[0-9]+)(,[0-9]{1,2})?';

function PriceField({ defaultValue }: { defaultValue?: number }) {
  return (
    <label>
      <span>Yayın bedeli (₺) *</span>
      <input
        name="priceAmount"
        type="text"
        inputMode="decimal"
        required
        pattern={PRICE_PATTERN}
        placeholder="499,90"
        defaultValue={defaultValue === undefined ? '' : formatMinorAsTurkishLiraInput(defaultValue)}
        data-testid="showcase-package-price"
      />
      <small>{PRICE_HELP}</small>
    </label>
  );
}

/**
 * The catalogue's own listing order, and nothing else.
 *
 * Under "Gelişmiş ayarlar" because it is not a fact about the package: it says
 * where this package sits in the shop's list, and it says nothing about where
 * any card sits on the home page. The vitrin shelf is ordered by the feed —
 * one round of every provider's best card, then a round of second cards —
 * and no package, price or setting moves a card up it. Stating that here is
 * what keeps an operator from selling a boost that does not exist.
 */
function AdvancedSettings({ sortOrder }: { sortOrder: number }) {
  return (
    <details className="form-grid-wide">
      <summary>Gelişmiş ayarlar</summary>
      <label>
        <span>Listeleme sırası</span>
        <input name="sortOrder" type="number" min={0} defaultValue={sortOrder} />
        <small>
          Yalnız paket listesindeki görünüm sırası (küçük sayı önce). Kartların ana sayfa veya
          vitrin sayfalarındaki sırasını etkilemez; hiçbir paket bir karta öncelik ya da
          sıralama avantajı vermez.
        </small>
      </label>
    </details>
  );
}

/**
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
 */
export default async function ShowcasePackagesPage({ searchParams }: PackagesPageProps) {
  await requireAdmin();

  const { error, created, saved } = await searchParams;
  const { packages } = await apiFetch<{ packages: ShowcasePackage[] }>(
    '/admin/showcase/packages',
  );

  return (
    <>
      <PageHeader
        title="Vitrin Paketleri"
        subtitle="Hizmet verenlerin kartlarını yayına almak için satın aldığı süreli paketler."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Vitrin Paketleri' }]}
        /*
          The consent ledger, reachable from the catalogue that produced the
          text it records. It left the sidebar with "Vitrin Kartları": both are
          things an operator looks up in the middle of an investigation, not
          places they navigate to cold, and five vitrin rows in one sidebar made
          the three that are actual jobs harder to find.
        */
        actions={
          <Link className="btn btn-sm btn-secondary" href="/showcase/price-terms">
            Metin onayları
          </Link>
        }
      />

      {error ? (
        <div className="notice notice-error" role="alert">
          {ERRORS[error] ?? ERRORS.SHOWCASE_PACKAGE_SAVE_FAILED}
        </div>
      ) : null}
      {created ? (
        <div className="notice" role="status">
          Paket oluşturuldu.
        </div>
      ) : null}
      {saved ? (
        <div className="notice" role="status">
          Paket güncellendi. Değişiklik yalnız bundan sonraki satın almaları etkiler.
        </div>
      ) : null}

      <SectionCard
        title="Paketler"
        subtitle={`${packages.length} paket. Fiyat ve süre değişiklikleri yalnız sonraki satın almaları etkiler; satılmış her yerleşim kendi anlık kopyasını taşır.`}
        padded={false}
      >
        {packages.length === 0 ? (
          <EmptyState
            title="Paket yok"
            description="Henüz bir vitrin paketi tanımlanmadı. Aşağıdaki formla ilkini oluşturabilirsiniz."
          />
        ) : (
          <div className="table-scroll showcase-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Paket</th>
                  <th>Kısa ad</th>
                  <th>Yayın bedeli</th>
                  <th>Süre</th>
                  <th>Geçerlilik</th>
                  <th>Kart tipi</th>
                  <th>Bölge</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id}>
                    <td>
                      {pkg.name}
                      {pkg.description ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {pkg.description}
                        </div>
                      ) : null}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {formatDateTime(pkg.createdAt)}
                      </div>
                    </td>
                    <td>
                      <code>{pkg.slug}</code>
                    </td>
                    <td data-testid="showcase-package-price-cell">
                      {formatMinorAsTurkishLira(pkg.priceAmount, pkg.currency)}
                    </td>
                    <td>{pkg.durationDays} gün</td>
                    <td>{pkg.activationWindowDays} gün</td>
                    <td>
                      {pkg.allowedCardKind
                        ? SHOWCASE_CARD_KIND_LABELS[pkg.allowedCardKind]
                        : 'Her ikisi'}
                    </td>
                    <td>{pkg.maxAreas === null ? 'Tümü' : `En fazla ${pkg.maxAreas}`}</td>
                    <td>
                      <span className={pkg.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                        {pkg.isActive ? 'Satışta' : 'Kapalı'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Yeni paket"
        subtitle="Yayın bedeli TakTick'in tahsil ettiği yerleşim ücretidir; hizmet verenin müşterisinden aldığı hizmet bedeliyle ilgisi yoktur."
      >
        <form action={createShowcasePackageAction} className="form-grid">
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
            <button className="btn btn-primary" type="submit">
              Paketi oluştur
            </button>
          </div>
        </form>
      </SectionCard>

      {packages.map((pkg) => (
        <SectionCard
          key={pkg.id}
          title={`Düzenle: ${pkg.name}`}
          subtitle={`Kısa ad ${pkg.slug} değiştirilemez. Yapılan değişiklikler yalnız bundan sonraki satın almaları etkiler.`}
        >
          <form action={updateShowcasePackageAction} className="form-grid">
            <input type="hidden" name="packageId" value={pkg.id} />
            <label>
              <span>Ad *</span>
              <input name="name" defaultValue={pkg.name} required minLength={3} maxLength={120} />
            </label>
            <PriceField defaultValue={pkg.priceAmount} />
            <label>
              <span>Süre (gün) *</span>
              <input
                name="durationDays"
                type="number"
                min={1}
                max={365}
                defaultValue={pkg.durationDays}
                required
              />
            </label>
            <label>
              <span>Kullanılmamış hakkın geçerliliği (gün) *</span>
              <input
                name="activationWindowDays"
                type="number"
                min={1}
                max={365}
                step={1}
                defaultValue={pkg.activationWindowDays ?? 90}
                required
              />
              <small>
                Ödemeden itibaren kartın onaylanıp yayına girmesi için tanınan süre. İnceleme
                süresi sayılmaz.
              </small>
            </label>
            <label>
              <span>Kart tipi</span>
              <select name="allowedCardKind" defaultValue={pkg.allowedCardKind ?? ''}>
                <option value="">Her ikisi</option>
                <option value="SERVICE">Hizmet vitrini</option>
                <option value="PROMOTION">Genel tanıtım</option>
              </select>
            </label>
            <label>
              <span>Azami bölge sayısı</span>
              <input
                name="maxAreas"
                type="number"
                min={1}
                max={25}
                defaultValue={pkg.maxAreas ?? ''}
                placeholder="Boş: tümü"
              />
            </label>
            <label className="form-grid-wide">
              <span>Açıklama</span>
              <textarea name="description" maxLength={600} defaultValue={pkg.description ?? ''} />
              <small>
                Yalnız paketin sağladığını yazın: yayın süresi ve karttan doğrudan talep. Öncelik
                veya sıralama vaadi vermeyin; böyle bir mekanizma yoktur.
              </small>
            </label>
            <label className="checkbox-row form-grid-wide">
              <input type="checkbox" name="isActive" defaultChecked={pkg.isActive} />
              <span>Satışta</span>
            </label>
            <AdvancedSettings sortOrder={pkg.sortOrder} />

            <div className="form-actions form-grid-wide">
              <button className="btn btn-primary" type="submit">
                Kaydet
              </button>
            </div>
          </form>
        </SectionCard>
      ))}
    </>
  );
}
