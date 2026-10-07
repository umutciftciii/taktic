import Link from 'next/link';
import { apiFetch, formatDateTime, requireAdmin } from '../../lib/api';
import { formatCount } from '../../lib/pagination';
import { seoReasonCodeLabel, seoSiteClosedReason, type SeoOverview, type SeoPageType } from '../../lib/seo';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { StatCard } from '../../components/stat-card';

/**
 * Arama motoru durumu (SEO-004 PR B), design `seoOverview` (paket 4
 * `38-seo-arama-motoru-durumu`).
 *
 * Every figure is `GET /admin/seo/overview`, computed by the API from the data
 * and the same index rule the public pages apply. What the design draws and no
 * source backs is not drawn: no "son 30 günde … kez kullanıldı" (redirect hits
 * are not counted), no visit figures, no "sitemap son güncelleme" (the sitemap
 * is built per request — the screen says exactly that). The 4th KPI is the 404
 * suggestions waiting for a decision, which the API does count.
 *
 * The shelf is one page: it reads 0 / 1 or 1 / 1, with its card count beside
 * it, never a design fixture like "14 / 18".
 */

const SCREEN_INFO =
  'Hangi herkese açık sayfanın arama motorlarına gösterildiğini ve neden gösterilmediğini özetler. Bir sayfa yayında olsa bile içeriği yeterli değilse aramaya kapalı kalır; kurallar aşağıdadır ve panelden değiştirilemez. Sitenin aramaya açık olup olmadığı sunucu yapılandırmasıyla belirlenir, bu ekrandan açılıp kapatılamaz. Site haritası (sitemap.xml) her istekte o anki verilerden üretilir.';

type TypeRow = {
  key: string;
  label: string;
  sub: string;
  indexable: number;
  total: number;
  note: string;
  filter: SeoPageType | null;
};

export default async function SeoOverviewPage() {
  await requireAdmin('SEO_READ');
  const overview = await apiFetch<SeoOverview>('/admin/seo/overview');
  const { site, pages, thresholds } = overview;

  const closedCategories = pages.categories.public - pages.categories.indexable;
  const closedProviders = pages.providers.public - pages.providers.indexable;
  const closedCards = pages.showcaseCards.live - pages.showcaseCards.indexable;

  const rows: TypeRow[] = [
    { key: 'home', label: 'Ana sayfa', sub: '/', indexable: 1, total: 1, note: 'Her zaman açık', filter: null },
    {
      key: 'catalogue',
      label: 'Hizmet kataloğu',
      sub: '/categories',
      indexable: 1,
      total: 1,
      note: 'Her zaman açık',
      filter: null,
    },
    {
      key: 'categories',
      label: 'Hizmet kategorileri',
      sub: '/categories/…',
      indexable: pages.categories.indexable,
      total: pages.categories.public,
      note:
        pages.categories.public === 0
          ? 'Herkese açık kategori yok'
          : closedCategories === 0
            ? 'Hepsi açık'
            : `${formatCount(closedCategories)} kategoride açıklama veya içerik bloğu eksik`,
      filter: 'CATEGORY',
    },
    {
      key: 'providers',
      label: 'İşletme profilleri',
      sub: '/isletme/…',
      indexable: pages.providers.indexable,
      total: pages.providers.public,
      note:
        pages.providers.public === 0
          ? 'Herkese açık işletme profili yok'
          : closedProviders === 0
            ? 'Hepsi açık'
            : `${formatCount(closedProviders)} işletmede tanıtım, konum veya bölge eksik`,
      filter: 'PROVIDER',
    },
    {
      key: 'shelf',
      label: 'Vitrin rafı',
      sub: '/vitrin',
      indexable: pages.showcaseShelf.indexable ? 1 : 0,
      total: 1,
      note: `Aramaya uygun ${formatCount(pages.showcaseShelf.indexableCards)} kart var · en az ${formatCount(pages.showcaseShelf.required)} gerek`,
      filter: 'SHOWCASE_SHELF',
    },
    {
      key: 'cards',
      label: 'Vitrin kartları',
      sub: '/vitrin/…',
      indexable: pages.showcaseCards.indexable,
      total: pages.showcaseCards.live,
      note:
        pages.showcaseCards.live === 0
          ? 'Yayında kart yok'
          : closedCards === 0
            ? 'Hepsi açık'
            : `${formatCount(closedCards)} kartta özet veya kapsam eksik`,
      filter: 'SHOWCASE_CARD',
    },
  ];

  const topReason = overview.topReasons[0];
  const subtitle = [
    site.open ? `${site.origin.replace(/^https:\/\//, '')} · aramaya açık` : 'Site arama motorlarına kapalı',
    `${formatCount(overview.indexableCount)} sayfa aramaya uygun`,
    topReason ? `en çok neden: ${seoReasonCodeLabel(topReason.code).toLocaleLowerCase('tr-TR')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className="seo-page" data-testid="seo-overview">
      <PageHeader
        title="Arama motoru durumu"
        subtitle={subtitle}
        info={SCREEN_INFO}
        actions={
          site.open ? (
            <a
              className="btn btn-secondary"
              href={`${site.origin}/sitemap.xml`}
              target="_blank"
              rel="noreferrer"
              data-testid="seo-sitemap-link"
            >
              Sitemap&apos;i görüntüle
            </a>
          ) : null
        }
      />

      <section
        className={site.open ? 'seo-site-band is-open' : 'seo-site-band is-closed'}
        aria-labelledby="seo-site-band-title"
        data-testid="seo-site-band"
      >
        <div className="seo-site-band-text">
          <h2 id="seo-site-band-title" className="seo-site-band-title">
            {site.open ? 'Site aramaya açık' : 'Site aramaya kapalı'}
          </h2>
          <p>
            {site.open
              ? 'Sayfalar arama motorlarına gösteriliyor ve site haritası yayında. '
              : `${seoSiteClosedReason(site.reason)} Bu durumda hiçbir sayfa arama motorlarına gösterilmez ve site haritası boştur; aşağıdaki sayılar sayfaların içerik açısından uygun olup olmadığını gösterir. `}
            Bu anahtar sunucu yapılandırmasındadır ve panelden değiştirilemez.
          </p>
        </div>
        <dl className="seo-site-band-facts">
          <div>
            <dt>sitemap.xml</dt>
            <dd data-testid="seo-sitemap-count">{formatCount(overview.sitemapUrlCount)} adres</dd>
          </div>
          <div>
            <dt>Üretim</dt>
            <dd>İstek anında üretilir</dd>
          </div>
        </dl>
      </section>

      <div className="stat-grid seo-stat-grid">
        <StatCard
          label="Aramaya uygun sayfa"
          value={<span className="seo-metric is-good">{formatCount(overview.indexableCount)}</span>}
          hint="Herkese açık ve içeriği yeterli"
          href="/seo/indexing"
          metricKey="seo-indexable"
        />
        <StatCard
          label="Aramaya kapalı sayfa"
          value={<span className="seo-metric is-warn">{formatCount(overview.nonIndexableCount)}</span>}
          hint="Herkese açık ama içeriği yeterli değil"
          href="/seo/indexing"
          metricKey="seo-non-indexable"
        />
        <StatCard
          label="Aktif yönlendirme"
          value={formatCount(overview.redirects.active)}
          hint={
            overview.redirects.notServed > 0
              ? `${formatCount(overview.redirects.notServed)} tanesi şu an uygulanmıyor`
              : 'Hepsi şu an uygulanıyor'
          }
          href="/seo/redirects"
          metricKey="seo-redirects"
        />
        <StatCard
          label="İnceleme bekleyen 404 önerisi"
          value={formatCount(overview.notFound.open)}
          hint="Onay olmadan yönlendirme oluşmaz"
          href="/seo/redirects?sekme=oneriler"
          metricKey="seo-not-found"
        />
      </div>

      <div className="seo-overview-grid">
        <SectionCard
          title="Sayfa türüne göre"
          actions={
            overview.nonIndexableCount > 0 ? (
              <Link className="btn btn-link btn-sm" href="/seo/indexing">
                Kapalı sayfaları gör
              </Link>
            ) : null
          }
          padded={false}
          className="seo-emphasis-card"
          testId="seo-type-breakdown"
        >
          <ul className="seo-type-list">
            {rows.map((row) => {
              const ratio = row.total === 0 ? 0 : row.indexable / row.total;
              return (
                <li key={row.key} className="seo-type-row" data-testid={`seo-type-${row.key}`}>
                  <div className="seo-type-text">
                    <strong>{row.label}</strong>
                    <span className="cell-muted">
                      {row.filter && row.indexable < row.total ? (
                        <Link href={`/seo/indexing?type=${row.filter}`}>{row.note}</Link>
                      ) : (
                        row.note
                      )}
                    </span>
                  </div>
                  <div className="seo-type-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                  </div>
                  <span className="seo-type-count" data-testid={`seo-type-${row.key}-count`}>
                    {formatCount(row.indexable)} / {formatCount(row.total)}
                  </span>
                </li>
              );
            })}
          </ul>
        </SectionCard>

        <SectionCard title="Bir sayfa ne zaman aramaya açılır" padded={false} testId="seo-rules">
          <ul className="seo-rule-list">
            <li>
              <strong>Kategori açıklaması</strong>{' '}
              <span className="seo-rule-limit">en az {formatCount(thresholds.categoryDescriptionMinChars)} karakter</span>
              <span className="cell-muted">Boşluk, noktalama ve etiket sayılmaz — yalnız harf ve rakam</span>
            </li>
            <li>
              <strong>Kategori içerik blokları</strong>{' '}
              <span className="seo-rule-limit">
                her biri en az {formatCount(thresholds.categoryEditorialBlockMinChars)} karakter
              </span>
              <span className="cell-muted">Karar rehberi, fiyatı etkileyen faktörler, sık sorulan sorular</span>
            </li>
            <li>
              <strong>İşletme tanıtım yazısı</strong>{' '}
              <span className="seo-rule-limit">en az {formatCount(thresholds.providerDescriptionMinChars)} karakter</span>
              <span className="cell-muted">Ayrıca il/ilçe, yayında bir kategori ve en az bir çalışma bölgesi</span>
            </li>
            <li>
              <strong>Vitrin kartı özeti</strong>{' '}
              <span className="seo-rule-limit">en az {formatCount(thresholds.showcaseSummaryMinChars)} karakter</span>
              <span className="cell-muted">Aynı işletmenin başka kartıyla aynı olmamalı</span>
            </li>
            <li>
              <strong>Vitrin kartı kapsamı</strong>{' '}
              <span className="seo-rule-limit">
                en az {formatCount(thresholds.showcaseScopeIncludedMinItems)} dahil +{' '}
                {formatCount(thresholds.showcaseScopeExcludedMinItems)} dahil değil
              </span>
              <span className="cell-muted">Müşterinin fiyatı karşılaştırabilmesi için</span>
            </li>
            <li>
              <strong>Vitrin rafı</strong>{' '}
              <span className="seo-rule-limit">
                en az {formatCount(thresholds.showcaseShelfMinIndexableCards)} aramaya uygun kart
              </span>
              <span className="cell-muted">Altında raf boş liste sayılır</span>
            </li>
          </ul>
          <p className="seo-rule-foot">
            Bu eşikler ürün kararıdır ve panelden değiştirilemez; içerik doldukça sayfalar kendiliğinden açılır. Sayılar{' '}
            {formatDateTime(overview.generatedAt)} itibarıyla hesaplandı.
          </p>
        </SectionCard>
      </div>
    </main>
  );
}
