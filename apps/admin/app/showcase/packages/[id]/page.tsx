import { formatMinorAsTurkishLira } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  requireAdmin,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_PLACEMENT_STATUS_LABELS,
  showcasePlacementBadgeClass,
  statusBadgeClass,
  statusLabel,
  type PackagePurchase,
  type ShowcasePackage,
} from '../../../../lib/api';
import { formatCount } from '../../../../lib/pagination';
import { resolveTab } from '../../../../lib/list-query';
import { ActivityLog, NO_CHANGE_HISTORY_NOTE, recordLifecycleEntries } from '../../../../components/activity-log';
import { DataTable, type DataColumn } from '../../../../components/data-table';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import { DetailFormFooter, LockedField } from '../../../../components/detail-form-footer';
import { DetailHeader } from '../../../../components/detail-header';
import { EmptyState } from '../../../../components/empty-state';
import { KeyValueList } from '../../../../components/key-value-list';
import { SectionCard } from '../../../../components/section-card';
import { SummaryStrip, type SummaryItem } from '../../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../../components/tabs';
import { updateShowcasePackageAction, updateShowcasePackageStatusAction } from '../actions';
import { ShowcasePackageEditSubmit } from '../showcase-package-gates';
import {
  areaText,
  cardKindText,
  PriceField,
  showcasePackageErrorText,
  SORT_ORDER_HELP,
} from '../showcase-package-fields';
import { showcasePackageSales } from '../showcase-package-sales';

/**
 * One vitrin package (#21), on the design's tabbed detail screen
 * (ADMIN-DESIGN-001 Faz 3F.1). Until this screen the package opened in a
 * `?paket=<id>` window over the list; the window's link now lands here, and the
 * list keeps only the new-package window.
 *
 * It reads `GET /admin/showcase/packages/:packageId` (SHOWCASE_PACKAGES_READ)
 * and nothing it would have to invent:
 *
 * - Paket bilgileri (the plain URL): the edit form with SHOWCASE_PACKAGES_WRITE
 *   — the window's fields, the same server action, the slug written once and
 *   shown, never sent — or the values read-only without it.
 * - Satışlar ve yayınlar (PACKAGE_PURCHASES_READ): this package's purchases and
 *   the run each one became. The purchase list has no vitrin-package filter,
 *   so the tab reads the list whole and keeps this package's rows — only when
 *   the tab is open, which is also why its count is drawn only there. A
 *   purchase that is paid but has no run says so; whether its right is still
 *   usable is an entitlement fact no admin read carries, and is not guessed.
 * - Neler oldu: the package's own instants. No change log exists for it.
 *
 * Satıştan kaldır / Satışa aç is the same PATCH as the form, `isActive` alone,
 * behind the same SHOWCASE_PACKAGES_WRITE. Metin onayları is the consent ledger
 * (SHOWCASE_TERMS_ACCEPTANCES_READ), as on the list.
 */

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    error?: string;
    saved?: string;
    activated?: string;
    deactivated?: string;
  }>;
};

type TabKey = '' | 'satislar' | 'gecmis';

const RECENT_SALES = 10;

const SALE_COLUMNS: DataColumn[] = [
  { key: 'purchase', label: 'Satın alma' },
  { key: 'provider', label: 'İşletme' },
  { key: 'card', label: 'Kart' },
  { key: 'payment', label: 'Ödeme' },
  { key: 'run', label: 'Yayın durumu' },
  { key: 'end', label: 'Yayın bitişi' },
  { key: 'amount', label: 'Tutar', align: 'end' },
];

export default async function ShowcasePackageDetailPage({ params, searchParams }: PageProps) {
  const { can } = await requireAdmin('SHOWCASE_PACKAGES_READ');
  // Editing and the on-sale switch are both SHOWCASE_PACKAGES_WRITE (one PATCH).
  const canWrite = can('SHOWCASE_PACKAGES_WRITE');
  const canReadPurchases = can('PACKAGE_PURCHASES_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenPlacement = can('SHOWCASE_PLACEMENTS_READ');
  const canReadTerms = can('SHOWCASE_TERMS_ACCEPTANCES_READ');

  const { id } = await params;
  const { tab, error, saved, activated, deactivated } = await searchParams;
  const pkg = await fetchOrNotFound(() =>
    apiFetch<ShowcasePackage>(`/admin/showcase/packages/${encodeURIComponent(id)}`),
  );

  const path = `/showcase/packages/${pkg.id}`;
  const tabKeys: TabKey[] = ['', ...(canReadPurchases ? (['satislar'] as const) : []), 'gecmis'];
  const activeTab = resolveTab<TabKey>(tab, tabKeys, '');

  // Read only on the tab that shows it: see the header comment.
  const sales =
    activeTab === 'satislar' && canReadPurchases
      ? showcasePackageSales(pkg.id, await apiFetch<PackagePurchase[]>('/package-purchases'))
      : null;

  const tabs: TabItem[] = [
    { key: '', label: 'Paket bilgileri', testId: 'showcase-package-tab-bilgiler' },
    ...(canReadPurchases
      ? [
          {
            key: 'satislar',
            label: 'Satışlar ve yayınlar',
            count: sales ? sales.rows.length : null,
            testId: 'showcase-package-tab-satislar',
          },
        ]
      : []),
    { key: 'gecmis', label: 'Neler oldu', testId: 'showcase-package-tab-gecmis' },
  ];

  const errorText = showcasePackageErrorText(error);
  const kindText = cardKindText(pkg, SHOWCASE_CARD_KIND_LABELS);

  const facts: SummaryItem[] = [
    {
      label: 'Yayın bedeli',
      value: formatMinorAsTurkishLira(pkg.priceAmount, pkg.currency),
      note: 'TakTick yerleşim ücreti',
      testId: 'showcase-package-fact-price',
    },
    { label: 'Yayın süresi', value: `${pkg.durationDays} gün`, note: 'kart yayına girince başlar' },
    { label: 'Geçerlilik', value: `${pkg.activationWindowDays} gün`, note: 'ödemeden itibaren' },
    {
      label: 'Kart tipi',
      value: kindText,
      note: pkg.allowedCardKind ? undefined : 'hizmet + tanıtım',
    },
    { label: 'Bölge', value: areaText(pkg), note: 'kart başına' },
  ];

  return (
    <main className="catalog-page catalog-detail-page showcase-package-detail">
      <DetailHeader
        back={{ href: '/showcase/packages', label: 'Vitrin paketleri' }}
        badges={
          <>
            <span className={pkg.isActive ? 'badge badge-good' : 'badge badge-muted'} data-testid="showcase-package-status">
              {pkg.isActive ? 'Satışta' : 'Kapalı'}
            </span>
            <span className="badge badge-muted">{pkg.allowedCardKind ? kindText : 'Her iki kart tipi'}</span>
          </>
        }
        meta={
          <>
            <code className="cell-break" data-testid="showcase-package-slug">
              {pkg.slug}
            </code>{' '}
            · listeleme sırası {pkg.sortOrder}
          </>
        }
        title={pkg.name}
        subtitle={`İşletmenin kartı ${
          pkg.maxAreas === null ? 'seçtiği bölgelerde' : `seçtiği en fazla ${pkg.maxAreas} bölgede`
        }, yayına girdiği andan itibaren ${pkg.durationDays} gün vitrin sayfalarında yayında kalır.`}
        actions={
          canReadTerms || canWrite ? (
            <>
              {canReadTerms ? (
                <Link className="btn btn-secondary" href="/showcase/price-terms">
                  Metin onayları
                </Link>
              ) : null}
              {canWrite ? (
                <form action={updateShowcasePackageStatusAction}>
                  <input type="hidden" name="packageId" value={pkg.id} />
                  <input type="hidden" name="isActive" value={String(!pkg.isActive)} />
                  {pkg.isActive ? (
                    <ConfirmDialog
                      proof="showcase-package.deactivate"
                      triggerLabel="Satıştan kaldır"
                      triggerClassName="btn btn-destructive"
                      tone="primary"
                      title={`“${pkg.name}” satıştan kaldırılsın mı?`}
                      consequence={
                        <>
                          <p>
                            Paket <strong>yeni satın almaya kapanır</strong>; işletmelerin satın alma ekranında görünmez.
                          </p>
                          <p>
                            Satılmış haklar, incelemedeki kartlar ve yayındaki yerleşimler <strong>değişmez</strong>;
                            yayındaki kartlar süreleri bitene kadar kalır. Paket aynı düğmeyle yeniden satışa açılabilir.
                          </p>
                        </>
                      }
                      confirmLabel="Evet, satıştan kaldır"
                      testId="showcase-package-status-toggle"
                    />
                  ) : (
                    <ConfirmDialog
                      proof="showcase-package.activate"
                      triggerLabel="Satışa aç"
                      triggerClassName="btn btn-primary"
                      tone="primary"
                      title={`“${pkg.name}” satışa açılsın mı?`}
                      consequence={
                        <>
                          <dl className="confirm-dialog-facts">
                            <div>
                              <dt>Yayın bedeli</dt>
                              <dd>{formatMinorAsTurkishLira(pkg.priceAmount, pkg.currency)}</dd>
                            </div>
                            <div>
                              <dt>Yayın süresi</dt>
                              <dd>{pkg.durationDays} gün</dd>
                            </div>
                          </dl>
                          <p>
                            Paket bu <strong>mevcut bedel ve süreyle</strong> yeniden satın alınabilir hâle gelir.
                          </p>
                        </>
                      }
                      confirmLabel="Evet, satışa aç"
                      testId="showcase-package-status-toggle"
                    />
                  )}
                </form>
              ) : null}
            </>
          ) : undefined
        }
        facts={facts}
        factsLabel="Paket özeti"
        testId="showcase-package-header"
      />

      {errorText ? (
        <div className="notice notice-error detail-notice" role="alert">
          {errorText}
        </div>
      ) : null}
      {saved ? (
        <div className="notice notice-success detail-notice" role="status">
          Paket güncellendi. Değişiklik yalnız bundan sonraki satın almaları etkiler.
        </div>
      ) : null}
      {activated ? (
        <div className="notice notice-success detail-notice" role="status">
          Paket satışa açıldı.
        </div>
      ) : null}
      {deactivated ? (
        <div className="notice notice-success detail-notice" role="status">
          Paket satıştan kaldırıldı. Yayındaki kartlar süreleri bitene kadar kalır.
        </div>
      ) : null}

      <Tabs label="Paket sekmeleri" items={tabs} active={activeTab} path={path} testId="showcase-package-tabs" />

      {activeTab === '' ? (
        <div className="detail-tab-panel" data-testid="showcase-package-panel-bilgiler">
          <SectionCard
            title="Paket bilgileri"
            actions={
              <span className="section-card-meta">Son değişiklik: {formatDateTime(pkg.updatedAt)}</span>
            }
            className="detail-tab-card"
            testId="showcase-package-info"
          >
            {canWrite ? (
              <form
                action={updateShowcasePackageAction}
                className="compact-form compact-form-wide"
                data-testid="showcase-package-edit-form"
              >
                <input type="hidden" name="packageId" value={pkg.id} />
                <div className="compact-field-grid">
                  <label className="field field-4">
                    <span>Ad *</span>
                    <input name="name" defaultValue={pkg.name} required minLength={3} maxLength={120} />
                  </label>
                  <LockedField
                    label="Kısa ad"
                    value={<code>{pkg.slug}</code>}
                    help='Ödeme sağlayıcısındaki ürün eşlemesinin anahtarıdır; yalnız oluştururken yazılır. "vitrin-" ön eki teklif paketleriyle çakışmayı engeller.'
                  />
                  <PriceField
                    className="field field-4"
                    defaultValue={pkg.priceAmount}
                    help="Türk lirası. Kuruş için virgül: 10,50 veya 1.250,75. İşletmenin müşterisinden aldığı hizmet bedeliyle ilgisi yoktur."
                  />
                  <label className="field field-4">
                    <span>Yayın süresi (gün) *</span>
                    <input
                      name="durationDays"
                      type="number"
                      min={1}
                      max={365}
                      defaultValue={pkg.durationDays}
                      required
                    />
                    <span className="help-text">Kart onaylanıp yayına girdiği andan itibaren sayılır.</span>
                  </label>
                  <label className="field field-4">
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
                    <span className="help-text">
                      Ödemeden itibaren kartın onaylanıp yayına girmesi için tanınan süre. İnceleme süresi sayılmaz.
                    </span>
                  </label>
                  <label className="field field-4">
                    <span>Kart tipi</span>
                    <select name="allowedCardKind" defaultValue={pkg.allowedCardKind ?? ''}>
                      <option value="">Her ikisi</option>
                      <option value="SERVICE">Hizmet vitrini</option>
                      <option value="PROMOTION">Genel tanıtım</option>
                    </select>
                  </label>
                  <label className="field field-4">
                    <span>Azami bölge sayısı</span>
                    <input
                      name="maxAreas"
                      type="number"
                      min={1}
                      max={25}
                      defaultValue={pkg.maxAreas ?? ''}
                      placeholder="Boş: tümü"
                    />
                    <span className="help-text">Boş bırakılırsa kart tüm bölgelerde yayınlanabilir.</span>
                  </label>
                  {/*
                    The window's "Satışta" checkbox as the design's select. The
                    action still reads `isActive === 'on'`, so "Kapalı" posts a
                    value that is not "on" and means false — the same payload.
                  */}
                  <label className="field field-4">
                    <span>Durum</span>
                    <select name="isActive" defaultValue={pkg.isActive ? 'on' : 'off'} data-testid="showcase-package-active">
                      <option value="on">Satışta</option>
                      <option value="off">Kapalı</option>
                    </select>
                    <span className="help-text">
                      Satıştan kaldırılan paket yeni satın almaya kapanır; yayındaki kartlar süreleri bitene kadar kalır.
                    </span>
                  </label>
                  <label className="field field-4">
                    <span>Listeleme sırası</span>
                    <input name="sortOrder" type="number" min={0} defaultValue={pkg.sortOrder} />
                    <span className="help-text">{SORT_ORDER_HELP}</span>
                  </label>
                  <label className="field field-12">
                    <span>Açıklama</span>
                    <textarea name="description" maxLength={600} defaultValue={pkg.description ?? ''} />
                    <span className="help-text">
                      İşletmenin gördüğü metin. Yalnız paketin sağladığını yazın: yayın süresi ve karttan doğrudan
                      talep. Öncelik veya sıralama vaadi vermeyin; böyle bir mekanizma yoktur.
                    </span>
                  </label>
                </div>
                <DetailFormFooter note="Değişiklikler yalnız bundan sonraki satın almaları etkiler; satılmış her yayın kendi kopyasını taşır.">
                  {/* Asks only when the price, the run or "Durum" changes (Paket A). */}
                  <ShowcasePackageEditSubmit
                    stored={{
                      name: pkg.name,
                      isActive: pkg.isActive,
                      priceAmount: pkg.priceAmount,
                      currency: pkg.currency,
                      durationDays: pkg.durationDays,
                      activationWindowDays: pkg.activationWindowDays,
                      allowedCardKind: pkg.allowedCardKind,
                      maxAreas: pkg.maxAreas,
                    }}
                  />
                </DetailFormFooter>
              </form>
            ) : (
              <div className="catalog-readonly" data-testid="showcase-package-read-only">
                <KeyValueList
                  items={[
                    { label: 'Ad', value: pkg.name },
                    {
                      label: 'Kısa ad',
                      value: (
                        <span className="readonly-value">
                          <code>{pkg.slug}</code>
                          <small className="cell-muted">
                            Değiştirilemez: ödeme sağlayıcısındaki ürün eşlemesinin anahtarıdır.
                          </small>
                        </span>
                      ),
                    },
                    { label: 'Durum', value: pkg.isActive ? 'Satışta' : 'Kapalı' },
                    { label: 'Yayın bedeli', value: formatMinorAsTurkishLira(pkg.priceAmount, pkg.currency) },
                    { label: 'Yayın süresi', value: `${pkg.durationDays} gün` },
                    { label: 'Geçerlilik', value: `${pkg.activationWindowDays} gün` },
                    { label: 'Kart tipi', value: kindText },
                    { label: 'Bölge', value: areaText(pkg) },
                    { label: 'Listeleme sırası', value: String(pkg.sortOrder) },
                    { label: 'Açıklama', value: pkg.description ?? '—' },
                  ]}
                />
              </div>
            )}
          </SectionCard>

          <SectionCard title="Bu paket ne verir, ne vermez" padded={false} className="detail-tab-card">
            <ul className="detail-fact-cards" data-testid="showcase-package-promise">
              <li className="is-positive">
                <h3>Verir</h3>
                <p>
                  Kartın {pkg.maxAreas === null ? 'seçilen bölgelerde' : `seçilen en fazla ${pkg.maxAreas} bölgede`}{' '}
                  {pkg.durationDays} gün vitrin sayfalarında yayında kalması.
                </p>
              </li>
              <li className="is-positive">
                <h3>Verir</h3>
                <p>Müşterinin karttan doğrudan bu işletmeye talep göndermesi.</p>
              </li>
              <li>
                <h3>Vermez</h3>
                <p>
                  Sıralama önceliği. Vitrin rafı her işletmenin en iyi kartıyla sırayla dizilir; hiçbir paket bir kartı
                  öne çıkarmaz.
                </p>
              </li>
              <li>
                <h3>Vermez</h3>
                <p>Teklif hakkı. Vitrin paketi kredi yüklemez; teklif vermek için kredi paketi gerekir.</p>
              </li>
            </ul>
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'satislar' && sales ? (
        <div className="detail-tab-panel" data-testid="showcase-package-panel-satislar">
          <SectionCard
            title="Satış özeti"
            actions={<span className="section-card-meta">Satın alma anındaki değerlerle</span>}
            padded={false}
            className="detail-tab-card"
            testId="showcase-package-sales"
          >
            {sales.rows.length === 0 ? (
              <EmptyState
                title="Bu pakete bağlı satın alma yok."
                description="Bir işletme bu paketi satın aldığında özet burada görünür."
              />
            ) : (
              <SummaryStrip
                label="Satış özeti"
                items={[
                  {
                    label: 'Toplam satış',
                    value: formatCount(sales.rows.length),
                    note: `${sales.paid} ödenmiş · ${sales.pending} bekleyen`,
                    testId: 'showcase-sales-total',
                  },
                  {
                    label: 'Toplam ciro',
                    value:
                      sales.revenue.length === 0
                        ? formatMinorAsTurkishLira(0, pkg.currency)
                        : sales.revenue.length === 1
                          ? formatMinorAsTurkishLira(sales.revenue[0]![1], sales.revenue[0]![0])
                          : 'Çoklu para birimi',
                    note:
                      sales.revenue.length > 1
                        ? sales.revenue.map(([cur, amount]) => formatMinorAsTurkishLira(amount, cur)).join(' · ')
                        : 'ödenmiş satışlar',
                    testId: 'showcase-sales-revenue',
                  },
                  {
                    label: 'Şu an yayında',
                    value: formatCount(sales.live),
                    note: 'kart',
                    testId: 'showcase-sales-live',
                  },
                  {
                    label: 'Yayına bağlanmamış',
                    value: formatCount(sales.paidWithoutRun),
                    note: 'ödenmiş, henüz yayın açılmamış',
                    testId: 'showcase-sales-unplaced',
                  },
                ]}
              />
            )}
          </SectionCard>

          {sales.rows.length > 0 ? (
            <SectionCard
              title="Son satışlar ve yayınlar"
              actions={
                <span className="section-card-meta">
                  {formatCount(sales.rows.length)} satıştan son {Math.min(RECENT_SALES, sales.rows.length)} kayıt
                </span>
              }
              padded={false}
              className="detail-tab-card"
              testId="showcase-package-recent-sales"
            >
              <DataTable caption="Son satışlar ve yayınlar" columns={SALE_COLUMNS} minWidth={980}>
                {sales.rows.slice(0, RECENT_SALES).map((purchase) => (
                  <tr key={purchase.id} data-testid="showcase-sale-row">
                    <td>
                      <div className="cell-stack">
                        <span className="cell-nowrap">{formatDateTime(purchase.createdAt)}</span>
                        <Link className="cell-link cell-nowrap" href={`/package-purchases/${purchase.id}`}>
                          {purchase.purchaseNumber ?? 'Satın almayı aç'}
                        </Link>
                      </div>
                    </td>
                    <td>
                      {canOpenProvider ? (
                        <Link className="cell-link cell-break" href={`/providers/${purchase.provider.id}`}>
                          {purchase.provider.businessName}
                        </Link>
                      ) : (
                        <strong className="cell-break">{purchase.provider.businessName}</strong>
                      )}
                    </td>
                    <td>
                      {purchase.showcaseCard ? (
                        <div className="cell-stack">
                          <span className="cell-break">{purchase.showcaseCard.category.name}</span>
                          <span className="cell-muted">{SHOWCASE_CARD_KIND_LABELS[purchase.showcaseCard.kind]}</span>
                        </div>
                      ) : purchase.showcasePlacement ? (
                        /*
                          Bought first, bound to a card later: the purchase row
                          carries no card, the run does — and the run's card is
                          on its own screen, not in this projection.
                        */
                        <span className="cell-muted">Yayın kaydında</span>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                    </td>
                    <td>
                      {purchase.showcasePlacement ? (
                        canOpenPlacement ? (
                          <Link href={`/showcase/placements/${purchase.showcasePlacement.id}`}>
                            <span className={showcasePlacementBadgeClass(purchase.showcasePlacement.status)}>
                              {SHOWCASE_PLACEMENT_STATUS_LABELS[purchase.showcasePlacement.status]}
                            </span>
                          </Link>
                        ) : (
                          <span className={showcasePlacementBadgeClass(purchase.showcasePlacement.status)}>
                            {SHOWCASE_PLACEMENT_STATUS_LABELS[purchase.showcasePlacement.status]}
                          </span>
                        )
                      ) : (
                        <span className="cell-muted">Yayın yok</span>
                      )}
                    </td>
                    <td className="cell-nowrap">
                      {purchase.showcasePlacement ? formatDateTime(purchase.showcasePlacement.endAt) : '—'}
                    </td>
                    <td className="is-num">
                      <strong>{formatMinorAsTurkishLira(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</strong>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <div className="detail-card-footer">
                <p>Kartların onay ve yayın durumları Vitrin menüsünden yönetilir.</p>
                {canOpenPlacement ? (
                  <div className="detail-card-footer-actions">
                    <Link className="btn btn-secondary btn-sm" href="/showcase/placements">
                      Yayındaki kartlar
                    </Link>
                  </div>
                ) : null}
              </div>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'gecmis' ? (
        <div className="detail-tab-panel" data-testid="showcase-package-panel-gecmis">
          <ActivityLog
            entries={recordLifecycleEntries({
              createdAt: pkg.createdAt,
              updatedAt: pkg.updatedAt,
              created: 'Paket oluşturuldu',
              updated: 'Paket son güncellendi',
            })}
            meta="Paket kaydının zamanları"
            footnote={NO_CHANGE_HISTORY_NOTE}
            testId="showcase-package-activity"
          />
        </div>
      ) : null}
    </main>
  );
}
