import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  ProviderProfile,
  ProviderRecentPackagePurchase,
  formatDateTime,
  formatPrice,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';
import { EmptyState } from '../../../components/empty-state';
import { ModerationDialog } from '../../../components/moderation-dialog';
import { updateProviderStatusAction } from '../actions';

type ProviderDetailPageProps = {
  params: Promise<{ id: string }>;
};

const webUrl = process.env.NEXT_PUBLIC_WEB_URL?.replace(/\/$/, '') ?? '';

function packagePurchaseStatusTimestamp(purchase: ProviderRecentPackagePurchase): string | null {
  switch (purchase.status) {
    case 'PAID':
      return purchase.paidAt;
    case 'FAILED':
      return purchase.failedAt;
    case 'CANCELLED':
      return purchase.cancelledAt;
    case 'EXPIRED':
      return purchase.expiredAt;
    case 'REFUNDED':
      return purchase.refundedAt;
    default:
      return null;
  }
}

export default async function ProviderDetailPage({ params }: ProviderDetailPageProps) {
  const { id } = await params;
  // An unknown id — including a path like /providers/new that falls through to
  // this dynamic route — renders the 404 screen instead of a server error.
  const provider = await fetchOrNotFound(() =>
    apiFetch<ProviderProfile>(`/providers/${id}/admin-detail`),
  );

  const creditBalance = provider.creditBalance ?? 0;
  const openOffers = provider.activeOffersCount ?? 0;
  const totalOffers = provider.totalOffersCount ?? 0;
  const packagePurchases = provider.packagePurchasesCount ?? 0;
  const recentOffers = provider.recentOffers ?? [];
  const recentPackagePurchases = provider.recentPackagePurchases ?? [];

  const hasTaxInfo = Boolean(provider.taxType || provider.taxNumber);

  return (
    <main className="provider-detail-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Hizmet Verenler', href: '/providers' },
          { label: provider.businessName },
        ]}
        title={provider.businessName}
        subtitle={
          <>
            <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
            <span className="muted">
              {' '}
              · {provider.city}/{provider.district}
            </span>
          </>
        }
        actions={
          <>
            <ModerationDialog
              providerId={provider.id}
              status={provider.status}
              moderationNote={provider.moderationNote}
              rejectionReason={provider.rejectionReason}
              action={updateProviderStatusAction}
            />
            <Link className="btn btn-secondary btn-sm" href={`/offers?providerId=${provider.id}`}>
              Teklifler
            </Link>
            <Link
              className="btn btn-secondary btn-sm"
              href={`/providers/${provider.id}/credits`}
            >
              Krediler
            </Link>
            <Link
              className="btn btn-ghost btn-sm"
              href={`/package-purchases?providerId=${provider.id}`}
            >
              Paket talepleri
            </Link>
          </>
        }
      />

      <section className="stat-grid">
        <StatCard
          label="Kredi bakiyesi"
          value={creditBalance}
          href={`/providers/${provider.id}/credits`}
          tone={creditBalance > 0 ? 'neutral' : 'warning'}
        />
        <StatCard
          label="Açık teklif"
          value={openOffers}
          href={`/offers?providerId=${provider.id}`}
          hint="Müşteri tarafından hâlâ değerlendirilebilir"
        />
        <StatCard label="Toplam teklif" value={totalOffers} />
        <StatCard
          label="Paket alımı"
          value={packagePurchases}
          href={`/package-purchases?providerId=${provider.id}`}
        />
      </section>

      <div className="provider-detail-card-grid">
        <SectionCard title="Profil & İletişim" className="card-wide">
          <dl className="meta-row">
            <dt>Hizmet veren ID</dt>
            <dd>
              <code style={{ fontSize: 12 }}>{provider.id}</code>
            </dd>
            <dt>Yetkili</dt>
            <dd>{provider.contactName}</dd>
            <dt>Telefon</dt>
            <dd>
              {provider.phone ? (
                <a className="cell-link" href={`tel:${provider.phone}`}>
                  {provider.phone}
                </a>
              ) : (
                '-'
              )}
            </dd>
            <dt>E-posta</dt>
            <dd>
              {provider.email ? (
                <a className="cell-link" href={`mailto:${provider.email}`}>
                  {provider.email}
                </a>
              ) : (
                '-'
              )}
            </dd>
            <dt>Bağlı hesap</dt>
            <dd>{provider.user?.email ?? provider.user?.phone ?? '-'}</dd>
            <dt>Konum</dt>
            <dd>
              {provider.city}/{provider.district}
            </dd>
            <dt>Adres notu</dt>
            <dd>{provider.addressNote ?? '-'}</dd>
            <dt>Açıklama</dt>
            <dd>{provider.description ?? '-'}</dd>
            <dt>Oluşturulma</dt>
            <dd>{formatDateTime(provider.createdAt)}</dd>
            <dt>Güncellenme</dt>
            <dd>{formatDateTime(provider.updatedAt)}</dd>
          </dl>
        </SectionCard>

        <SectionCard title="Hizmet kategorileri">
          {provider.serviceCategories.length === 0 ? (
            <span className="muted">Kategori seçilmemiş.</span>
          ) : (
            <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
              {provider.serviceCategories.map((item) => (
                <span className="badge badge-info" key={item.id}>
                  {item.category.name}
                </span>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Hizmet bölgeleri">
          {provider.serviceAreas.length === 0 ? (
            <span className="muted">Bölge tanımlı değil.</span>
          ) : (
            <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
              {provider.serviceAreas.map((area) => (
                <span className="badge badge-muted" key={area.id}>
                  {area.city}
                  {area.district ? `/${area.district}` : ''}
                  {area.neighborhood ? `/${area.neighborhood}` : ''}
                </span>
              ))}
            </div>
          )}
        </SectionCard>

        {hasTaxInfo ? (
          <SectionCard title="Vergi bilgisi">
            <dl className="meta-row">
              <dt>Vergi türü</dt>
              <dd>{provider.taxType ?? '-'}</dd>
              <dt>Vergi numarası</dt>
              <dd>{provider.taxNumber ?? '-'}</dd>
            </dl>
          </SectionCard>
        ) : null}

        <SectionCard title="Durum bilgileri">
          <dl className="meta-row">
            <dt>Mevcut durum</dt>
            <dd>
              <span className={statusBadgeClass(provider.status)}>
                {statusLabel(provider.status)}
              </span>
            </dd>
            <dt>Onay</dt>
            <dd>{provider.approvedAt ? formatDateTime(provider.approvedAt) : '-'}</dd>
            <dt>Ret</dt>
            <dd>{provider.rejectedAt ? formatDateTime(provider.rejectedAt) : '-'}</dd>
            <dt>Askı</dt>
            <dd>{provider.suspendedAt ? formatDateTime(provider.suspendedAt) : '-'}</dd>
            <dt>Moderasyon notu</dt>
            <dd>{provider.moderationNote ?? '-'}</dd>
            <dt>Ret gerekçesi</dt>
            <dd>{provider.rejectionReason ?? '-'}</dd>
          </dl>
        </SectionCard>

        <SectionCard
          title="Son teklifler"
          subtitle={totalOffers > 0 ? `Toplam ${totalOffers}` : undefined}
          actions={
            totalOffers > 0 ? (
              <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${provider.id}`}>
                Tümünü gör
              </Link>
            ) : undefined
          }
          className="card-wide"
        >
          {recentOffers.length === 0 ? (
            <EmptyState title="Henüz teklif yok." />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Gönderim</th>
                    <th>Kategori / Konum</th>
                    <th>Fiyat</th>
                    <th>Durum</th>
                    <th className="col-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOffers.map((offer) => (
                    <tr key={offer.id}>
                      <td>{formatDateTime(offer.submittedAt)}</td>
                      <td>
                        <div className="cell-stack">
                          <span>{offer.request.category.name}</span>
                          <span className="cell-muted">
                            {offer.request.city}/{offer.request.district}
                          </span>
                        </div>
                      </td>
                      <td>{formatPrice(offer.priceAmount, offer.currency)}</td>
                      <td>
                        <span className={statusBadgeClass(offer.status)}>
                          {statusLabel(offer.status)}
                        </span>
                      </td>
                      <td className="col-actions">
                        <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`}>
                          Detay
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Son paket alımları"
          subtitle={packagePurchases > 0 ? `Toplam ${packagePurchases}` : undefined}
          actions={
            packagePurchases > 0 ? (
              <Link
                className="btn btn-ghost btn-sm"
                href={`/package-purchases?providerId=${provider.id}`}
              >
                Tümünü gör
              </Link>
            ) : undefined
          }
          className="card-wide"
        >
          {recentPackagePurchases.length === 0 ? (
            <EmptyState title="Henüz paket alımı yok." />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Oluşturulma</th>
                    <th>Paket</th>
                    <th className="col-num">Kredi</th>
                    <th>Tutar</th>
                    <th>Durum</th>
                    <th>Durum tarihi</th>
                    <th className="col-actions">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPackagePurchases.map((purchase) => {
                    const statusTimestamp = packagePurchaseStatusTimestamp(purchase);
                    return (
                      <tr key={purchase.id}>
                        <td>{formatDateTime(purchase.createdAt)}</td>
                        <td>{purchase.packageNameSnapshot}</td>
                        <td className="col-num">{purchase.creditAmountSnapshot}</td>
                        <td>
                          {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
                        </td>
                        <td>
                          <span className={statusBadgeClass(purchase.status)}>
                            {statusLabel(purchase.status)}
                          </span>
                        </td>
                        <td>
                          {statusTimestamp ? (
                            formatDateTime(statusTimestamp)
                          ) : (
                            <span className="cell-muted">—</span>
                          )}
                        </td>
                        <td className="col-actions">
                          <Link
                            className="btn btn-secondary btn-sm"
                            href={`/package-purchases/${purchase.id}`}
                          >
                            Detay
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {webUrl ? (
          <div className="notice card-wide">
            Web tarafındaki eşleşen talepler önizlemesi:{' '}
            <a href={`${webUrl}/providers/${provider.id}/requests`}>aç</a>
          </div>
        ) : null}
      </div>
    </main>
  );
}
