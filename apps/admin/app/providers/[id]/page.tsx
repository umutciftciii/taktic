import Link from 'next/link';
import {
  apiFetch,
  AdminProviderServiceCategories,
  Category,
  fetchOrNotFound,
  ProviderProfile,
  ProviderRecentPackagePurchase,
  formatDateTime,
  formatPrice,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import {
  KIND_LABELS,
  STATUS_LABELS as CATEGORY_STATUS_LABELS,
  statusBadgeClass as categoryStatusBadgeClass,
} from '../../categories/category-taxonomy';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';
import { EmptyState } from '../../../components/empty-state';
import { ModerationDialog } from '../../../components/moderation-dialog';
import {
  addProviderServiceCategoryAction,
  removeProviderServiceCategoryAction,
  sendProviderClaimInviteAction,
  updateProviderStatusAction,
} from '../actions';

type ProviderDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    claimInvite?: string;
    categoryQuery?: string;
    categoryNotice?: string;
  }>;
};

/**
 * How many search hits the "add a category" list offers at once.
 *
 * The catalogue is a few dozen rows and the operator is looking for one of
 * them, so a bounded list plus a "narrow your search" line is more useful than
 * every remaining category rendered as a button. The cap is announced whenever
 * it bites — a silently truncated list is how somebody concludes a category
 * does not exist.
 */
const CATEGORY_SUGGESTION_LIMIT = 12;

/** What the operator is told after attaching or detaching a category. */
const CATEGORY_NOTICES: Record<string, { tone: 'good' | 'warn'; text: string }> = {
  added: { tone: 'good', text: 'Kategori bu hizmet verene bağlandı.' },
  already: { tone: 'good', text: 'Bu kategori zaten bağlıydı; ikinci bir kayıt oluşmadı.' },
  removed: { tone: 'good', text: 'Kategori bağı kaldırıldı.' },
  'not-assignable': {
    tone: 'warn',
    text:
      'Yalnızca yayında veya taslak durumdaki hizmet kategorileri bağlanabilir. Grup, yönlendirici ve kapalı kategoriler bağlanamaz.',
  },
  'not-found': { tone: 'warn', text: 'Kategori bulunamadı.' },
  error: { tone: 'warn', text: 'Kategori bağı güncellenemedi. Lütfen tekrar deneyin.' },
};

/**
 * What the operator is told after pressing "davet gönder".
 *
 * Every outcome is a short code the action put in the URL; none of them carries
 * the link, the token or the address. "undelivered" is the honest answer for a
 * deployment with no real e-mail transport: the invitation exists and is valid,
 * but nothing carried it anywhere.
 */
const CLAIM_INVITE_MESSAGES: Record<string, { tone: 'good' | 'warn'; text: string }> = {
  sent: { tone: 'good', text: 'Davet gönderildi. Bağlantı 72 saat geçerli.' },
  undelivered: {
    tone: 'warn',
    text: 'Davet oluşturuldu ancak gönderilemedi. Nedenini bildirim geçmişinde görebilirsiniz.',
  },
  'rate-limited': {
    tone: 'warn',
    text: 'Çok fazla davet isteği gönderildi. Lütfen daha sonra tekrar deneyin.',
  },
  'claim-email-missing': {
    tone: 'warn',
    text: 'Bu başvuruda e-posta adresi yok. Önce başvurunun e-posta adresini girin.',
  },
  'claim-already-completed': { tone: 'warn', text: 'Bu başvuru zaten bir hesaba bağlı.' },
  'claim-not-available': {
    tone: 'warn',
    text: 'Bu durumdaki bir başvuru için davet gönderilemez.',
  },
  disabled: { tone: 'warn', text: 'Başvuru sahiplenme şu anda kapalı.' },
  error: { tone: 'warn', text: 'Davet gönderilemedi. Lütfen tekrar deneyin.' },
};

const CLAIM_BLOCKED_LABELS: Record<string, string> = {
  CLAIM_ALREADY_COMPLETED: 'Başvuru zaten bir hesaba bağlı.',
  CLAIM_NOT_AVAILABLE: 'Bu durumdaki bir başvuru sahiplenilemez.',
  CLAIM_EMAIL_MISSING: 'Başvuruda e-posta adresi yok.',
};

const CLAIM_INVITATION_STATE_LABELS: Record<string, string> = {
  ACTIVE: 'Geçerli',
  USED: 'Kullanıldı',
  EXPIRED: 'Süresi doldu',
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

export default async function ProviderDetailPage({
  params,
  searchParams,
}: ProviderDetailPageProps) {
  const { id } = await params;
  const { claimInvite, categoryQuery: rawCategoryQuery, categoryNotice } = await searchParams;
  // An unknown id — including a path like /providers/new that falls through to
  // this dynamic route — renders the 404 screen instead of a server error.
  const provider = await fetchOrNotFound(() =>
    apiFetch<ProviderProfile>(`/providers/${id}/admin-detail`),
  );

  // Two reads rather than one: the bindings come from the endpoint that owns
  // the "does this count for release" answer, and the catalogue is the same
  // operator's view the categories screen uses. Neither is reachable without a
  // SUPER_ADMIN session, which is what makes drafts nameable here and nowhere
  // else.
  const [serviceCategories, categories] = await Promise.all([
    apiFetch<AdminProviderServiceCategories>(`/providers/${id}/service-categories`),
    apiFetch<Category[]>('/categories?includeInactive=true'),
  ]);

  const claim = provider.claim ?? null;
  const inviteNotice = claimInvite ? CLAIM_INVITE_MESSAGES[claimInvite] : undefined;

  const creditBalance = provider.creditBalance ?? 0;
  const openOffers = provider.activeOffersCount ?? 0;
  const totalOffers = provider.totalOffersCount ?? 0;
  const packagePurchases = provider.packagePurchasesCount ?? 0;
  const recentOffers = provider.recentOffers ?? [];
  const recentPackagePurchases = provider.recentPackagePurchases ?? [];

  const hasTaxInfo = Boolean(provider.taxType || provider.taxNumber);

  const categoryQuery = (rawCategoryQuery ?? '').trim();
  const categoryNoticeMessage = categoryNotice ? CATEGORY_NOTICES[categoryNotice] : undefined;
  const bindings = serviceCategories.serviceCategories;
  const boundCategoryIds = new Set(bindings.map((binding) => binding.categoryId));

  // The same rule the API enforces, restated so the screen never offers a
  // button that would be refused: an ACTIVE or DRAFT service, and nothing that
  // is already attached. Groups, routers and closed categories are absent
  // rather than disabled — an operator should not have to discover by clicking
  // that a folder is not a service.
  const assignable = categories.filter(
    (category) =>
      category.kind === 'LEAF' &&
      (category.status === 'ACTIVE' || category.status === 'DRAFT') &&
      !boundCategoryIds.has(category.id),
  );

  const normalizedCategoryQuery = categoryQuery.toLocaleLowerCase('tr-TR');
  const matches = normalizedCategoryQuery
    ? assignable.filter((category) =>
        `${category.name} ${category.slug}`
          .toLocaleLowerCase('tr-TR')
          .includes(normalizedCategoryQuery),
      )
    : assignable;
  const suggestions = matches.slice(0, CATEGORY_SUGGESTION_LIMIT);

  // Said out loud on the screen, because it is the difference between "this
  // provider will make a draft releasable" and "this provider changes nothing
  // until somebody approves them".
  const countsForRelease = provider.status === 'APPROVED';
  const draftBindingCount = bindings.filter(
    (binding) => binding.category.status === 'DRAFT',
  ).length;

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
            {/* Ownership now has a card of its own, below. */}
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

        <SectionCard
          className="card-wide"
          title="Hizmet kategorileri"
          subtitle={
            <>
              Taslak hizmetler yalnızca burada görünür: hizmet veren onları kendi panelinde
              göremez, keşif ve teklif akışına girmez. Kategori{' '}
              <strong>{CATEGORY_STATUS_LABELS.ACTIVE}</strong> olduğunda buradaki bağ ek bir
              işlem gerekmeden geçerli arz sayılır.
            </>
          }
          id="hizmet-kategorileri"
        >
          {categoryNoticeMessage ? (
            <p
              className={
                categoryNoticeMessage.tone === 'good' ? 'badge badge-good' : 'badge badge-warn'
              }
              role="status"
              style={{ display: 'inline-block', marginBottom: 12 }}
              data-testid="provider-category-notice"
            >
              {categoryNoticeMessage.text}
            </p>
          ) : null}

          {!countsForRelease && bindings.length > 0 ? (
            <p
              className="badge badge-warn"
              style={{ display: 'inline-block', marginBottom: 12 }}
              data-testid="provider-category-not-counted"
            >
              Bu hizmet veren <strong>{statusLabel(provider.status)}</strong> durumda. Bağlı
              kategoriler yayın hazırlığı sayacında <strong>sayılmaz</strong>; sayaç yalnızca
              onaylı hizmet verenleri sayar.
            </p>
          ) : null}

          <div data-testid="provider-category-list">
            {bindings.length === 0 ? (
              <span className="muted">Kategori seçilmemiş.</span>
            ) : (
              <ul className="provider-category-list">
                {bindings.map((binding) => (
                  <li key={binding.id} data-testid={`provider-category-${binding.category.slug}`}>
                    <span className="provider-category-name">
                      <Link href={`/categories/${binding.category.slug}`}>
                        {binding.category.name}
                      </Link>
                      <span className={categoryStatusBadgeClass(binding.category.status)}>
                        {CATEGORY_STATUS_LABELS[binding.category.status]}
                      </span>
                      <span className="badge badge-muted">
                        {KIND_LABELS[binding.category.kind]}
                      </span>
                      {binding.countsForRelease ? (
                        <span className="badge badge-good">Hazırlık sayacına dahil</span>
                      ) : (
                        <span className="badge badge-warn">Sayaca dahil değil</span>
                      )}
                    </span>
                    <form action={removeProviderServiceCategoryAction}>
                      <input type="hidden" name="id" value={provider.id} />
                      <input type="hidden" name="categoryId" value={binding.categoryId} />
                      <input type="hidden" name="categoryQuery" value={categoryQuery} />
                      <button className="btn btn-ghost btn-sm" type="submit">
                        Kaldır
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {draftBindingCount > 0 ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Bu hizmet veren {draftBindingCount} taslak kategoriye bağlı. Taslak bağlar yalnızca
              yayın hazırlığı panelinde görünür.
            </p>
          ) : null}

          <form className="admin-toolbar" method="get" style={{ marginTop: 16 }}>
            <div className="admin-toolbar-field admin-toolbar-search">
              <label htmlFor="provider-category-search">Kategori ara</label>
              <input
                id="provider-category-search"
                name="categoryQuery"
                type="search"
                placeholder="Kategori adı veya slug"
                defaultValue={categoryQuery}
                autoComplete="off"
                data-testid="provider-category-search"
              />
            </div>
            <div className="admin-toolbar-actions">
              <button className="btn btn-secondary btn-sm" type="submit">
                Ara
              </button>
              {categoryQuery ? (
                <Link className="btn btn-ghost btn-sm" href={`/providers/${provider.id}`}>
                  Sıfırla
                </Link>
              ) : null}
            </div>
          </form>

          <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
            {suggestions.length === 0 ? (
              <span className="muted">
                {categoryQuery
                  ? 'Bu aramayla eşleşen, bağlanabilir bir kategori yok.'
                  : 'Bağlanabilecek başka kategori yok.'}
              </span>
            ) : (
              suggestions.map((category) => (
                <form
                  action={addProviderServiceCategoryAction}
                  key={category.id}
                  data-testid={`provider-category-add-${category.slug}`}
                >
                  <input type="hidden" name="id" value={provider.id} />
                  <input type="hidden" name="categoryId" value={category.id} />
                  <input type="hidden" name="categoryQuery" value={categoryQuery} />
                  <button className="btn btn-secondary btn-sm" type="submit">
                    + {category.name}
                    <span className={categoryStatusBadgeClass(category.status)}>
                      {CATEGORY_STATUS_LABELS[category.status]}
                    </span>
                  </button>
                </form>
              ))
            )}
          </div>

          {matches.length > suggestions.length ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {matches.length} sonuçtan ilk {suggestions.length} tanesi gösteriliyor. Aramayı
              daraltın.
            </p>
          ) : null}
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

        <SectionCard title="Sahiplik">
          {inviteNotice ? (
            <p
              className={inviteNotice.tone === 'good' ? 'badge badge-good' : 'badge badge-warn'}
              role="status"
              style={{ display: 'inline-block', marginBottom: 12 }}
            >
              {inviteNotice.text}
            </p>
          ) : null}

          <dl className="meta-row">
            <dt>Durum</dt>
            <dd>
              {provider.userId ? (
                <span className="badge badge-good">Hesaba bağlı</span>
              ) : (
                <span className="badge badge-warn">Sahipsiz</span>
              )}
            </dd>
            <dt>Bağlı hesap</dt>
            <dd>{provider.user?.email ?? provider.user?.phone ?? '-'}</dd>
            <dt>Sahiplenme</dt>
            <dd>
              {provider.claimedAt
                ? formatDateTime(provider.claimedAt)
                : provider.userId
                  ? 'Hesapla oluşturuldu'
                  : '-'}
            </dd>
            <dt>Son davet</dt>
            <dd>
              {claim?.lastInvitation ? (
                <>
                  {formatDateTime(claim.lastInvitation.createdAt)} ·{' '}
                  {CLAIM_INVITATION_STATE_LABELS[claim.lastInvitation.state] ??
                    claim.lastInvitation.state}{' '}
                  · son geçerlilik {formatDateTime(claim.lastInvitation.expiresAt)} ·{' '}
                  {claim.lastInvitation.byAdmin ? 'admin' : 'başvuru'}
                </>
              ) : (
                '-'
              )}
            </dd>
          </dl>

          {provider.claimEnabled === false ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Başvuru sahiplenme şu anda kapalı.
            </p>
          ) : claim?.canInvite ? (
            <form action={sendProviderClaimInviteAction} className="inline-actions">
              <input type="hidden" name="id" value={provider.id} />
              <button className="btn btn-secondary btn-sm" type="submit">
                Claim daveti gönder
              </button>
            </form>
          ) : (
            <p className="muted" style={{ marginBottom: 0 }}>
              {(claim?.blockedCode && CLAIM_BLOCKED_LABELS[claim.blockedCode]) ??
                'Bu başvuru için davet gönderilemez.'}
            </p>
          )}

          <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            Bağlantı yalnızca başvurunun e-posta adresine gönderilir; bu ekranda hiçbir zaman
            gösterilmez.{' '}
            <Link className="cell-link" href={`/notifications?providerId=${provider.id}`}>
              Gönderim geçmişi
            </Link>
          </p>
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
