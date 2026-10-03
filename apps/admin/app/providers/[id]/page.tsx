import { serviceAreaLabel } from '@taktic/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AdminProviderCredits,
  AdminProviderServiceCategories,
  ApiError,
  apiFetch,
  fetchOrNotFound,
  formatDate,
  formatDateTime,
  formatPrice,
  getProviderStatusHistory,
  listCatalogueForFilter,
  ProviderProfile,
  ProviderRecentPackagePurchase,
  type ProviderReviewsPage,
  requireAdmin,
  reviewResolutionLabel,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import {
  KIND_LABELS,
  STATUS_LABELS as CATEGORY_STATUS_LABELS,
  statusBadgeClass as categoryStatusBadgeClass,
} from '../../categories/category-taxonomy';
import { AUDIT_SINCE_NOTE, AuditTimeline } from '../../../components/audit-timeline';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailHeader } from '../../../components/detail-header';
import { EmptyState } from '../../../components/empty-state';
import { InfoPopover } from '../../../components/info-popover';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../components/tabs';
import {
  BUSINESS_REGISTRATION_STATUS_LABELS,
  ELIGIBILITY_DECISION_LABELS,
  businessRegistrationLabel,
  eligibilitySignalLabel,
  type PromotionEligibilityHoldView,
} from '../../../lib/business-registration';
import { parsePage, resolveTab } from '../../../lib/list-query';
import {
  addProviderServiceCategoryAction,
  removeProviderServiceCategoryAction,
  sendProviderClaimInviteAction,
  updateProviderStatusAction,
} from '../actions';
import { TransactionsPanel } from './credits/transactions-panel';
import { providerApproveConsequence, providerStatusConsequence } from './provider-status-consequence';
import { ProviderStatusForm } from './provider-status-form';
import { RawRegistrationReveal } from './raw-registration-reveal';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../../lib/confirmation-proof-keys';

/**
 * Hizmet veren detayı (#13), design `providerDetail` (ADMIN-DESIGN-001 Faz 3B,
 * paket 2 `16`–`18`).
 *
 * The design's summary card and three tabs — İşletme bilgileri, Kredi
 * hareketleri, Değerlendirmeler — plus a fourth, "Teklifler ve paketler", for
 * the two tables the design leaves out (K7: nothing the screen showed is
 * dropped). Every card beyond the profile keeps its own permission:
 *
 * - The page is PROVIDERS_READ_DETAIL.
 * - Category bindings PROVIDERS_READ, reviews PROVIDER_REVIEWS_READ,
 *   eligibility PROMOTION_ELIGIBILITY_REVIEW — each read only when held, each
 *   card absent otherwise (`apiFetch` turns a 403 into /yetkisiz, so an
 *   unguarded read would take the whole page away).
 * - The Kredi hareketleri tab is FINANCE_LEDGER_READ and reads the staff route
 *   `GET /admin/providers/:id/credits` (ADMIN-DESIGN-000, F4), not the
 *   ownership-guarded provider route; it is read only while the tab is open.
 * - Writes: status PROVIDERS_MODERATE, categories PROVIDER_CATEGORIES_WRITE,
 *   claim invitation PROVIDER_CLAIM_INVITE_ISSUE, the raw registration number
 *   PROVIDER_REGISTRATION_READ_SENSITIVE + PROMOTION_ELIGIBILITY_REVIEW.
 *
 * Suspending, rejecting and removing a category ask first and say what they
 * do. Not rendered, having nothing behind them: the design's "Profili
 * düzenle" (no operator edit API), "Belgeler" (no document model), and the
 * "Bu ay verdiği teklif / Kazanma oranı / Açık şikayet" figures (no source).
 */

type ProviderDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    /** ADMIN-ACTION-AUDIT-001: the status history's own page. */
    gecmisSayfa?: string;
    claimInvite?: string;
    categoryQuery?: string;
    categoryNotice?: string;
    statusSaved?: string;
    statusError?: string;
  }>;
};

type TabKey = '' | 'kredi' | 'degerlendirmeler' | 'teklifler' | 'gecmis';

/** Said once the status form has been sent (updateProviderStatusAction). */
const STATUS_ERRORS: Record<string, string> = {
  invalid: 'Durum kaydedilemedi: istek geçersiz. Ret için gerekçe zorunludur.',
  error: 'Durum kaydedilemedi. Lütfen tekrar deneyin.',
  confirmation: CONFIRMATION_PROOF_REFUSAL_MESSAGE,
};

/** The design's ⓘ on the credit tab, fitted to what the rows are. */
const CREDIT_INFO =
  'İşletmenin kredi bakiyesindeki her hareket: paket alımı, teklif harcaması, iade, promosyon ve yöneticilerin elle yaptığı ekleme ve düşmeler. Mevcut, hareketten önceki bakiye; Kalan, hareketten sonraki bakiyedir. Kayıtlar silinmez; yanlış bir hareket ancak ters bir işlemle dengelenir.';

/** What `DELETE /providers/:id/service-categories/:categoryId` does. */
const REMOVE_CATEGORY_CONSEQUENCE = (
  <>
    <p>
      Bağ kaldırılır: bu kategorideki talepler işletmeye artık gösterilmez ve işletme yayın
      hazırlığı sayacında bu kategori için sayılmaz.
    </p>
    <p>Verilmiş teklifler ve geçmiş değişmez. Bağ gerektiğinde yeniden eklenebilir.</p>
  </>
);

const OFFER_COLUMNS: DataColumn[] = [
  { key: 'submitted', label: 'Gönderim' },
  { key: 'request', label: 'Kategori / Konum' },
  { key: 'price', label: 'Fiyat', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const PURCHASE_COLUMNS: DataColumn[] = [
  { key: 'created', label: 'Oluşturulma' },
  { key: 'package', label: 'Paket' },
  { key: 'credits', label: 'Kredi', align: 'end' },
  { key: 'amount', label: 'Tutar', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'statusAt', label: 'Durum tarihi' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

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
  confirmation: { tone: 'warn', text: CONFIRMATION_PROOF_REFUSAL_MESSAGE },
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
  const { can } = await requireAdmin('PROVIDERS_READ_DETAIL');
  const { id } = await params;
  const search = await searchParams;
  const { claimInvite, categoryQuery: rawCategoryQuery, categoryNotice } = search;
  // An unknown id — including a path like /providers/new that falls through to
  // this dynamic route — renders the 404 screen instead of a server error.
  const provider = await fetchOrNotFound(() =>
    apiFetch<ProviderProfile>(`/providers/${id}/admin-detail`),
  );

  const canReadBindings = can('PROVIDERS_READ');
  const canReadReviews = can('PROVIDER_REVIEWS_READ');
  const canReadEligibility = can('PROMOTION_ELIGIBILITY_REVIEW');
  // Write surfaces and cross-links, each gated by the exact permission of the
  // route (or target page) behind it. The API refuses regardless; this only
  // keeps a control the account cannot use off the screen.
  const canModerate = can('PROVIDERS_MODERATE');
  const canWriteCategories = can('PROVIDER_CATEGORIES_WRITE');
  const canIssueClaimInvite = can('PROVIDER_CLAIM_INVITE_ISSUE');
  const canReadOffers = can('OFFERS_READ');
  const canReadCredits = can('FINANCE_LEDGER_READ');
  const canReadPackagePurchases = can('PACKAGE_PURCHASES_READ');
  const canReadCatalog = can('CATALOG_READ');
  const canReadNotifications = can('NOTIFICATION_LOGS_READ');
  const canReadRequests = can('REQUESTS_READ');
  // Adding a category is a pick from the catalogue, and the catalogue is
  // CATALOG_READ's to read. Without it the list comes back empty and the card
  // used to say "no other category can be bound" — a false statement behind
  // a control that could never do anything (Faz 4). Removing a bond needs no
  // catalogue and stays on the write permission alone.
  const canAddCategories = canWriteCategories && canReadCatalog;

  // The offers and purchases blocks of `admin-detail` are OFFERS_READ's and
  // PACKAGE_PURCHASES_READ's; the API leaves out what the session cannot read
  // (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001), so the tab exists only when
  // one of the two has something to show.
  const hasActivityTab = canReadOffers || canReadPackagePurchases;
  const tabKeys: TabKey[] = [
    '',
    ...(canReadCredits ? (['kredi'] as const) : []),
    ...(canReadReviews ? (['degerlendirmeler'] as const) : []),
    ...(hasActivityTab ? (['teklifler'] as const) : []),
    // ADMIN-ACTION-AUDIT-001: the page's own permission reads it.
    'gecmis',
  ];
  const activeTab = resolveTab<TabKey>(search.tab, tabKeys, '');
  const historyPage = parsePage(search.gecmisSayfa);
  const statusHistory = activeTab === 'gecmis' ? await getProviderStatusHistory(id, historyPage) : null;
  const path = `/providers/${provider.id}`;

  const [serviceCategories, categories, reviews, eligibility, credits] = await Promise.all([
    canReadBindings && activeTab === ''
      ? apiFetch<AdminProviderServiceCategories>(`/providers/${id}/service-categories`)
      : Promise.resolve(null),
    // Only the "add a category" list reads the catalogue.
    canReadBindings && canAddCategories && activeTab === '' ? listCatalogueForFilter() : Promise.resolve([]),
    // The operator's own route (PROVIDER_REVIEWS_READ), not the provider
    // panel's: that one is ownership-guarded. A failure hides the reviews
    // rather than the screen — they are context here, not the subject.
    canReadReviews
      ? apiFetch<ProviderReviewsPage>(`/provider-reviews/by-provider/${encodeURIComponent(id)}?limit=10`).catch(
          (error: unknown) => {
            if (error instanceof ApiError) return null;
            throw error;
          },
        )
      : Promise.resolve(null),
    // This provider's promotion eligibility holds, open and decided.
    canReadEligibility && activeTab === ''
      ? apiFetch<{ items: PromotionEligibilityHoldView[]; total: number }>(
          `/admin/promotion-eligibility/holds?filter=all&providerId=${encodeURIComponent(id)}`,
        )
      : Promise.resolve(null),
    // F4: the staff read, on the ledger's own permission.
    canReadCredits && activeTab === 'kredi'
      ? apiFetch<AdminProviderCredits>(`/admin/providers/${id}/credits`)
      : Promise.resolve(null),
  ]);

  const claim = provider.claim ?? null;
  const inviteNotice = claimInvite ? CLAIM_INVITE_MESSAGES[claimInvite] : undefined;
  const statusErrorText = search.statusError ? STATUS_ERRORS[search.statusError] ?? STATUS_ERRORS.error : null;

  const creditBalance = provider.creditBalance ?? 0;
  const openOffers = provider.activeOffersCount ?? 0;
  const totalOffers = provider.totalOffersCount ?? 0;
  const packagePurchases = provider.packagePurchasesCount ?? 0;
  const recentOffers = provider.recentOffers ?? [];
  const recentPackagePurchases = provider.recentPackagePurchases ?? [];

  const hasTaxInfo = Boolean(provider.taxType || provider.taxNumberMasked);
  const registration = provider.businessRegistration;
  // The API's rule, restated so the button is never offered where the read
  // would be refused (PR-C.2): the sensitive permission and the fraud review
  // context together. The route enforces it; this only hides a dead button.
  const canReadRaw = can('PROVIDER_REGISTRATION_READ_SENSITIVE') && can('PROMOTION_ELIGIBILITY_REVIEW');

  const categoryQuery = (rawCategoryQuery ?? '').trim();
  const categoryNoticeMessage = categoryNotice ? CATEGORY_NOTICES[categoryNotice] : undefined;
  const bindings = serviceCategories?.serviceCategories ?? [];
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

  const reviewAverage =
    reviews && reviews.summary.count > 0 && reviews.summary.average !== null
      ? reviews.summary.average.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : null;

  const tabs: TabItem[] = [
    { key: '', label: 'İşletme bilgileri', testId: 'provider-tab-bilgiler' },
    ...(canReadCredits ? [{ key: 'kredi', label: 'Kredi hareketleri', testId: 'provider-tab-kredi' }] : []),
    ...(canReadReviews
      ? [
          {
            key: 'degerlendirmeler',
            label: 'Değerlendirmeler',
            count: reviews ? reviews.summary.count : null,
            testId: 'provider-tab-degerlendirmeler',
          },
        ]
      : []),
    ...(hasActivityTab
      ? [
          {
            key: 'teklifler',
            label: canReadOffers
              ? canReadPackagePurchases
                ? 'Teklifler ve paketler'
                : 'Teklifler'
              : 'Paket alımları',
            count: canReadOffers ? totalOffers : packagePurchases,
            testId: 'provider-tab-teklifler',
          },
        ]
      : []),
    { key: 'gecmis', label: 'Neler oldu', testId: 'provider-tab-gecmis' },
  ];

  // Each figure only where the session may read its domain: the API carries
  // none of them otherwise, and a "0" here would be a claim it never made.
  const facts: SummaryItem[] = [
    ...(canReadCredits
      ? [
          {
            label: 'Kredi bakiyesi',
            value: String(creditBalance),
            tone: (creditBalance > 0 ? 'neutral' : 'warning') as SummaryItem['tone'],
            testId: 'provider-fact-credit',
          },
        ]
      : []),
    ...(canReadOffers
      ? [
          {
            label: 'Açık teklif',
            value: String(openOffers),
            note: 'Müşteri hâlâ değerlendirebilir',
            testId: 'provider-fact-open-offers',
          },
          { label: 'Toplam teklif', value: String(totalOffers), testId: 'provider-fact-total-offers' },
        ]
      : []),
    ...(canReadPackagePurchases
      ? [{ label: 'Paket alımı', value: String(packagePurchases), testId: 'provider-fact-purchases' }]
      : []),
    ...(canReadReviews
      ? [
          {
            label: 'Müşteri puanı',
            value: reviewAverage ?? '—',
            note: reviews
              ? reviews.summary.count > 0
                ? `${reviews.summary.count} yayındaki değerlendirme`
                : 'Henüz değerlendirme yok'
              : 'Değerlendirmeler yüklenemedi',
            tone: (reviewAverage ? 'success' : 'neutral') as SummaryItem['tone'],
          },
        ]
      : []),
  ];

  return (
    <main className="provider-detail-page">
      <DetailHeader
        back={canReadBindings ? { href: '/providers', label: 'Hizmet verenler' } : null}
        badges={
          <>
            <span className={statusBadgeClass(provider.status)} data-testid="provider-status">
              {statusLabel(provider.status)}
            </span>
            {provider.userId ? (
              <span className="badge badge-muted">Kendi hesabı var</span>
            ) : (
              <span className="badge badge-warn">Kendi hesabı yok</span>
            )}
          </>
        }
        meta={<>{formatDate(provider.createdAt)} tarihinden beri kayıtlı</>}
        title={provider.businessName}
        subtitle={[
          `Yetkili: ${provider.contactName}`,
          provider.phone,
          provider.serviceAreas.length > 0
            ? provider.serviceAreas.map(serviceAreaLabel).join(', ')
            : `${provider.city}/${provider.district}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {canModerate ? <ProviderQuickStatus provider={provider} /> : null}
            {canReadCredits ? (
              <Link className="btn btn-secondary btn-sm" href={`/providers/${provider.id}/credits`}>
                Krediler
              </Link>
            ) : null}
            {canReadOffers ? (
              <Link className="btn btn-secondary btn-sm" href={`/offers?providerId=${provider.id}`}>
                Teklifler
              </Link>
            ) : null}
            {canReadPackagePurchases ? (
              <Link className="btn btn-ghost btn-sm" href={`/package-purchases?providerId=${provider.id}`}>
                Paket talepleri
              </Link>
            ) : null}
          </>
        }
        facts={facts}
        factsLabel="Hizmet veren özeti"
        testId="provider-header"
      />

      {search.statusSaved === '1' ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="provider-status-saved">
          Hizmet verenin durumu güncellendi.
        </div>
      ) : null}
      {statusErrorText ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="provider-status-error">
          {statusErrorText}
        </div>
      ) : null}

      <Tabs label="Hizmet veren sekmeleri" items={tabs} active={activeTab} path={path} testId="provider-tabs" />

      {activeTab === '' ? (
        <div className="detail-panel" data-testid="provider-panel-bilgiler">
          <div className="detail-panel-grid">
            <SectionCard title="İşletme bilgileri">
              <KeyValueList
                items={[
                  { label: 'İşletme', value: provider.businessName },
                  { label: 'Yetkili kişi', value: provider.contactName },
                  {
                    label: 'Telefon',
                    value: provider.phone ? (
                      <a className="cell-link" href={`tel:${provider.phone}`}>
                        {provider.phone}
                      </a>
                    ) : null,
                  },
                  {
                    label: 'E-posta',
                    value: provider.email ? (
                      <a className="cell-link cell-break" href={`mailto:${provider.email}`}>
                        {provider.email}
                      </a>
                    ) : null,
                  },
                  {
                    label: 'Adres',
                    value: (
                      <>
                        {provider.city}/{provider.district}
                        {provider.addressNote ? <div className="cell-muted">{provider.addressNote}</div> : null}
                      </>
                    ),
                  },
                  {
                    label: 'Açıklama',
                    value: provider.description ? <span className="detail-prose">{provider.description}</span> : null,
                  },
                  { label: 'Platforma katıldığı tarih', value: formatDateTime(provider.createdAt) },
                  { label: 'Güncellenme', value: formatDateTime(provider.updatedAt) },
                  {
                    label: 'Hizmet veren ID',
                    value: (
                      <details className="muted technical-id">
                        <summary>Teknik bilgi</summary>
                        <code>{provider.id}</code>
                      </details>
                    ),
                  },
                ]}
              />
            </SectionCard>

            <SectionCard title="Durum yönetimi" id="durum-yonetimi">
              <KeyValueList
                items={[
                  {
                    label: 'Mevcut durum',
                    value: <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>,
                  },
                  { label: 'Onay', value: provider.approvedAt ? formatDateTime(provider.approvedAt) : null },
                  { label: 'Ret', value: provider.rejectedAt ? formatDateTime(provider.rejectedAt) : null },
                  { label: 'Askı', value: provider.suspendedAt ? formatDateTime(provider.suspendedAt) : null },
                  { label: 'Moderasyon notu', value: provider.moderationNote },
                  { label: 'Ret gerekçesi', value: provider.rejectionReason },
                ]}
              />
              {canModerate ? (
                <div className="provider-status-form-wrap">
                  <ProviderStatusForm
                    providerId={provider.id}
                    status={provider.status}
                    moderationNote={provider.moderationNote}
                    rejectionReason={provider.rejectionReason}
                    action={updateProviderStatusAction}
                  />
                </div>
              ) : null}
            </SectionCard>

            {serviceCategories ? (
              <SectionCard
                className="is-wide"
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
                            {canReadCatalog ? (
                              <Link href={`/categories/${binding.category.slug}`}>{binding.category.name}</Link>
                            ) : (
                              <span>{binding.category.name}</span>
                            )}
                            <span className={categoryStatusBadgeClass(binding.category.status)}>
                              {CATEGORY_STATUS_LABELS[binding.category.status]}
                            </span>
                            <span className="badge badge-muted">{KIND_LABELS[binding.category.kind]}</span>
                            {binding.countsForRelease ? (
                              <span className="badge badge-good">Hazırlık sayacına dahil</span>
                            ) : (
                              <span className="badge badge-warn">Sayaca dahil değil</span>
                            )}
                          </span>
                          {canWriteCategories ? (
                            <form action={removeProviderServiceCategoryAction}>
                              <input type="hidden" name="id" value={provider.id} />
                              <input type="hidden" name="categoryId" value={binding.categoryId} />
                              <input type="hidden" name="categoryQuery" value={categoryQuery} />
                              <ConfirmDialog
                                proof="provider.category-remove"
                                triggerLabel="Kaldır"
                                triggerClassName="btn btn-ghost btn-sm"
                                title={`“${binding.category.name}” bağı kaldırılsın mı?`}
                                consequence={REMOVE_CATEGORY_CONSEQUENCE}
                                confirmLabel="Evet, kaldır"
                                testId={`provider-category-remove-${binding.category.slug}`}
                              />
                            </form>
                          ) : null}
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

                {canAddCategories ? (
                  <>
                    <form className="admin-toolbar" method="get" action={path} style={{ marginTop: 16 }}>
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
                          <Link className="btn btn-ghost btn-sm" href={path}>
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
                  </>
                ) : null}
              </SectionCard>
            ) : null}

            <SectionCard title="Çalıştığı bölgeler">
              {provider.serviceAreas.length === 0 ? (
                <span className="muted">Bölge tanımlı değil.</span>
              ) : (
                <div className="badge-row">
                  {provider.serviceAreas.map((area) => (
                    <span className="badge badge-muted" key={area.id}>
                      {serviceAreaLabel(area)}
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

              <KeyValueList
                items={[
                  {
                    label: 'Durum',
                    value: provider.userId ? (
                      <span className="badge badge-good">Hesaba bağlı</span>
                    ) : (
                      <span className="badge badge-warn">Sahipsiz</span>
                    ),
                  },
                  { label: 'Bağlı hesap', value: provider.user?.email ?? provider.user?.phone ?? null },
                  {
                    label: 'Sahiplenme',
                    value: provider.claimedAt
                      ? formatDateTime(provider.claimedAt)
                      : provider.userId
                        ? 'Hesapla oluşturuldu'
                        : null,
                  },
                  {
                    label: 'Son davet',
                    value: claim?.lastInvitation ? (
                      <>
                        {formatDateTime(claim.lastInvitation.createdAt)} ·{' '}
                        {CLAIM_INVITATION_STATE_LABELS[claim.lastInvitation.state] ?? claim.lastInvitation.state} ·
                        son geçerlilik {formatDateTime(claim.lastInvitation.expiresAt)} ·{' '}
                        {claim.lastInvitation.byAdmin ? 'admin' : 'başvuru'}
                      </>
                    ) : null,
                  },
                ]}
              />

              <div className="provider-claim-actions">
                {provider.claimEnabled === false ? (
                  <p className="detail-muted-note">Başvuru sahiplenme şu anda kapalı.</p>
                ) : claim?.canInvite ? (
                  canIssueClaimInvite ? (
                    <form action={sendProviderClaimInviteAction} className="inline-actions">
                      <input type="hidden" name="id" value={provider.id} />
                      <button className="btn btn-secondary btn-sm" type="submit">
                        Claim daveti gönder
                      </button>
                    </form>
                  ) : null
                ) : (
                  <p className="detail-muted-note">
                    {(claim?.blockedCode && CLAIM_BLOCKED_LABELS[claim.blockedCode]) ??
                      'Bu başvuru için davet gönderilemez.'}
                  </p>
                )}

                <p className="detail-muted-note">
                  Bağlantı yalnızca başvurunun e-posta adresine gönderilir; bu ekranda hiçbir zaman
                  gösterilmez.{' '}
                  {canReadNotifications ? (
                    <Link className="cell-link" href={`/notifications?providerId=${provider.id}`}>
                      Gönderim geçmişi
                    </Link>
                  ) : null}
                </p>
              </div>
            </SectionCard>

            {/* CMP-006 PR-C: masked only; the raw value is one audited read away. */}
            <SectionCard title="İşletme kaydı">
              <dl className="kv-list" data-testid="registration-card">
                <div className="kv-row">
                  <dt>Durum</dt>
                  <dd data-testid="registration-status">
                    {BUSINESS_REGISTRATION_STATUS_LABELS[registration?.status ?? 'UNSPECIFIED']}
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Tür</dt>
                  <dd>{businessRegistrationLabel(registration?.type)}</dd>
                </div>
                <div className="kv-row">
                  <dt>Numara</dt>
                  <dd data-testid="registration-masked">{registration?.numberMasked ?? '—'}</dd>
                </div>
                {hasTaxInfo ? (
                  <div className="kv-row">
                    <dt>Eski vergi beyanı</dt>
                    <dd>
                      <span className="muted">Doğrulanmamış eski kayıt</span> · {provider.taxType ?? '-'} ·{' '}
                      <span data-testid="legacy-tax-masked">{provider.taxNumberMasked ?? '-'}</span>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {canReadRaw && (registration?.status === 'DECLARED' || hasTaxInfo) ? (
                <RawRegistrationReveal providerId={provider.id} />
              ) : null}
            </SectionCard>

            {eligibility ? (
              <SectionCard title="Promosyon uygunluğu" className="is-wide">
                {eligibility.items.length === 0 ? (
                  <p className="detail-muted-note" data-testid="provider-eligibility-empty">
                    Bu hizmet veren için uygunluk incelemesi yok.
                  </p>
                ) : (
                  <ul className="plain-list" data-testid="provider-eligibility">
                    {eligibility.items.map((hold) => (
                      <li key={hold.eventId}>
                        <Link className="cell-link" href={`/promotion-eligibility/${hold.eventId}`}>
                          {formatDateTime(hold.heldAt)}
                        </Link>{' '}
                        · {hold.snapshot.signals.map((signal) => eligibilitySignalLabel(signal.code)).join(' · ')} ·{' '}
                        {hold.review ? ELIGIBILITY_DECISION_LABELS[hold.review.decision] : 'Karar bekliyor'}
                      </li>
                    ))}
                  </ul>
                )}
                {eligibility.total > eligibility.items.length ? (
                  // ADMIN-BACKEND-TRUTH-002: the API's first page is 100 holds; say so rather than imply it is all.
                  <p className="detail-muted-note" data-testid="provider-eligibility-more">
                    {eligibility.total} incelemenin en yeni {eligibility.items.length} tanesi gösteriliyor.
                  </p>
                ) : null}
              </SectionCard>
            ) : null}

            {webUrl ? (
              <div className="notice is-wide">
                Web tarafındaki eşleşen talepler önizlemesi:{' '}
                <a href={`${webUrl}/providers/${provider.id}/requests`}>aç</a>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === 'kredi' && credits ? (
        <div className="detail-panel" data-testid="provider-panel-kredi">
          <SectionCard
            title={
              <span className="section-title-with-info">
                Kredi hareketleri
                <InfoPopover label="Kredi hareketleri nedir?" size="sm">
                  {CREDIT_INFO}
                </InfoPopover>
              </span>
            }
            subtitle={
              credits.transactions.length >= 20
                ? 'Son 20 hareket; tamamı kredi hareketleri ekranında.'
                : `${credits.transactions.length} hareket`
            }
            actions={
              <span className="provider-credit-balance" data-testid="provider-credit-balance">
                Bugünkü bakiye <strong>{credits.balance} kredi</strong>
              </span>
            }
            padded={false}
          >
            <TransactionsPanel transactions={credits.transactions} />
          </SectionCard>
          <p className="detail-muted-note">
            Elle kredi ekleme ve düşme, dönemsel paketler ve denetim notu{' '}
            <Link className="cell-link" href={`/providers/${provider.id}/credits`}>
              kredi işlemleri ekranında
            </Link>
            .
          </p>
        </div>
      ) : null}

      {activeTab === 'degerlendirmeler' && canReadReviews ? (
        <div className="detail-panel" data-testid="provider-panel-degerlendirmeler">
          <SectionCard
            title="Değerlendirmeler"
            subtitle={
              reviewAverage && reviews
                ? `Ortalama ${reviewAverage} · ${reviews.summary.count} değerlendirme (yayında olanlar)`
                : 'Müşterilerin bu işletme hakkında bıraktığı değerlendirmeler; yayında olanlar.'
            }
          >
            {!reviews ? (
              <p className="detail-muted-note">Değerlendirmeler yüklenemedi.</p>
            ) : reviews.items.length === 0 ? (
              <EmptyState
                title="Henüz değerlendirme yok."
                description="Müşteri tamamlanan bir işin ardından değerlendirme bıraktığında burada görünür."
              />
            ) : (
              <ul className="review-card-grid" data-testid="provider-review-list">
                {reviews.items.map((item) => (
                  <li key={item.id} className="review-card" data-testid="provider-review-row">
                    <div className="review-card-head">
                      <strong className="review-card-rating" aria-label={`5 üzerinden ${item.rating}`}>
                        {item.rating.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                      </strong>
                      <span className="cell-muted">{formatDateTime(item.createdAt)}</span>
                      {item.myReport ? (
                        <span className={item.myReport.resolution ? 'badge badge-muted' : 'badge badge-warn'}>
                          {item.myReport.resolution
                            ? reviewResolutionLabel(item.myReport.resolution)
                            : 'Şikayet: karar bekliyor'}
                        </span>
                      ) : (
                        <span className="badge badge-good">Yayında</span>
                      )}
                    </div>
                    <p className="review-card-body">
                      {item.commentRemoved ? (
                        <span className="cell-muted">Yorum kaldırıldı</span>
                      ) : item.comment ? (
                        item.comment
                      ) : (
                        <span className="cell-muted">Yorum yazılmamış</span>
                      )}
                    </p>
                    <div className="review-card-foot">
                      <span>
                        {canReadRequests ? (
                          <Link className="cell-link" href={`/requests/${item.request.id}`}>
                            <code className="display-number">
                              {item.request.requestNumber ?? `#${item.request.id.slice(-8)}`}
                            </code>
                          </Link>
                        ) : (
                          <code className="display-number">
                            {item.request.requestNumber ?? `#${item.request.id.slice(-8)}`}
                          </code>
                        )}{' '}
                        · {item.request.categoryName}
                      </span>
                      <Link className="btn btn-ghost btn-sm" href={`/provider-reviews/${item.id}`}>
                        Detay
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'teklifler' ? (
        <div className="detail-panel" data-testid="provider-panel-teklifler">
          {canReadOffers ? (
            <SectionCard
              title="Son teklifler"
              subtitle={totalOffers > 0 ? `Toplam ${totalOffers}` : undefined}
              actions={
                totalOffers > 0 && canReadOffers ? (
                  <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${provider.id}`}>
                    Tümünü gör
                  </Link>
                ) : undefined
              }
            >
              {recentOffers.length === 0 ? (
                <EmptyState
                  title="Henüz teklif yok."
                  description="İşletme bir talebe teklif gönderdiğinde burada görünür."
                />
              ) : (
                <DataTable caption="Son teklifler" columns={OFFER_COLUMNS} minWidth={640} testId="provider-recent-offers">
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
                      <td className="is-num">{formatPrice(offer.priceAmount, offer.currency)}</td>
                      <td>
                        <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                      </td>
                      <td className="col-actions">
                        {canReadOffers ? (
                          <Link className="btn btn-secondary btn-sm" href={`/offers/${offer.id}`}>
                            Aç
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </SectionCard>
          ) : null}

          {canReadPackagePurchases ? (
            <SectionCard
              title="Son paket alımları"
              subtitle={packagePurchases > 0 ? `Toplam ${packagePurchases}` : undefined}
              actions={
                packagePurchases > 0 && canReadPackagePurchases ? (
                  <Link className="btn btn-ghost btn-sm" href={`/package-purchases?providerId=${provider.id}`}>
                    Tümünü gör
                  </Link>
                ) : undefined
              }
            >
              {recentPackagePurchases.length === 0 ? (
                <EmptyState
                  title="Henüz paket alımı yok."
                  description="İşletme bir kredi paketi satın aldığında burada görünür."
                />
              ) : (
                <DataTable
                  caption="Son paket alımları"
                  columns={PURCHASE_COLUMNS}
                  minWidth={760}
                  testId="provider-recent-purchases"
                >
                  {recentPackagePurchases.map((purchase) => {
                    const statusTimestamp = packagePurchaseStatusTimestamp(purchase);
                    return (
                      <tr key={purchase.id}>
                        <td>{formatDateTime(purchase.createdAt)}</td>
                        <td>{purchase.packageNameSnapshot}</td>
                        <td className="is-num">{purchase.creditAmountSnapshot}</td>
                        <td className="is-num">
                          {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
                        </td>
                        <td>
                          <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                        </td>
                        <td>
                          {statusTimestamp ? formatDateTime(statusTimestamp) : <span className="cell-muted">—</span>}
                        </td>
                        <td className="col-actions">
                          {canReadPackagePurchases ? (
                            <Link className="btn btn-secondary btn-sm" href={`/package-purchases/${purchase.id}`}>
                              Aç
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </DataTable>
              )}
            </SectionCard>
          ) : null}
        </div>
      ) : null}
      {activeTab === 'gecmis' && statusHistory ? (
        <div className="detail-panel" data-testid="provider-panel-gecmis">
          <AuditTimeline
            page={statusHistory}
            meta="Başvuru ve hesap durumu değişiklikleri"
            empty="Bu işletmenin durumu kayıt tutulmaya başladığından beri değiştirilmedi."
            footnote={`${AUDIT_SINCE_NOTE} Yalnız durum değişiklikleri görünür; e-posta ve kampanya olayları burada yer almaz.`}
            testId="provider-status-history"
            pager={{ path, params: { tab: 'gecmis' }, pageParam: 'gecmisSayfa' }}
          />
        </div>
      ) : null}
    </main>
  );
}

/**
 * The design's "İş almasını durdur" and its counterparts, in the header: the
 * one move each status most often needs. Suspending asks first; so do
 * approving and re-activating since Faz 2 (they mail the business, resume its
 * vitrin and may fire a campaign reward). Every other move is the status
 * form's, under "Durum yönetimi".
 */
function ProviderQuickStatus({ provider }: { provider: ProviderProfile }): ReactNode {
  const hidden = (
    <>
      <input type="hidden" name="id" value={provider.id} />
      <input type="hidden" name="moderationNote" value={provider.moderationNote ?? ''} />
      <input type="hidden" name="rejectionReason" value={provider.rejectionReason ?? ''} />
    </>
  );

  if (provider.status === 'APPROVED') {
    return (
      <form action={updateProviderStatusAction}>
        {hidden}
        <input type="hidden" name="status" value="SUSPENDED" />
        <ConfirmDialog
          proof="provider.status"
          triggerLabel="İş almasını durdur"
          triggerClassName="btn btn-destructive btn-sm"
          title="Hizmet veren askıya alınsın mı?"
          consequence={providerStatusConsequence('APPROVED', 'SUSPENDED')}
          confirmLabel="Evet, askıya al"
          testId="provider-suspend"
        />
      </form>
    );
  }

  const reactivate = provider.status === 'SUSPENDED';
  return (
    <form action={updateProviderStatusAction}>
      {hidden}
      <input type="hidden" name="status" value="APPROVED" />
      <ConfirmDialog
        proof="provider.approve"
        triggerLabel={reactivate ? 'Tekrar aktif et' : 'Onayla'}
        triggerClassName="btn btn-primary btn-sm"
        title={reactivate ? 'Hizmet veren tekrar aktif edilsin mi?' : 'Hizmet veren onaylansın mı?'}
        consequence={providerApproveConsequence(provider.status)}
        confirmLabel={reactivate ? 'Evet, tekrar aktif et' : 'Evet, onayla'}
        tone="primary"
        testId="provider-approve"
      />
    </form>
  );
}
