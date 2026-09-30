import Link from 'next/link';
import {
  ApiError,
  apiFetch,
  ContactRevealDetail,
  type CustomerReviewState,
  fetchOrNotFound,
  formatBudgetRange,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatPrice,
  Offer,
  qualityBadgeClass,
  qualityBreakdownLabel,
  qualityLabel,
  QualityScoreBreakdown,
  REMOVAL_REASON_CUSTOMER_LABELS,
  REPORT_REASON_ADMIN_LABELS,
  REPORT_REASON_KEYS,
  type RequestCancellation,
  WINNER_REFUND_DECISION_LABELS,
  reportReasonLabel,
  reportResolutionLabel,
  RequestReport,
  requestStatusLabel,
  requireAdmin,
  reviewStateBadgeClass,
  reviewStateLabel,
  ServiceRequest,
  statusBadgeClass,
  statusLabel,
  urgencyLabel,
} from '../../../lib/api';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { CancelRequestForm, type CancelOfferCounts } from './cancel-request-form';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailHeader } from '../../../components/detail-header';
import { EmptyState } from '../../../components/empty-state';
import { InfoPopover } from '../../../components/info-popover';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../components/tabs';
import { Timeline, type TimelineItem } from '../../../components/timeline';
import { resolveTab } from '../../../lib/list-query';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';
import {
  isInModeration,
  isRemovable,
  moderationMove,
  removalUnavailableReason,
} from '../../../lib/request-moderation';
import { requestStatusErrorMessage } from '../../../lib/status-conflicts';
import {
  completeRequestAction,
  recalculateRequestQualityAction,
  reopenRequestAction,
  resolveReportsAction,
  updateRequestStatusAction,
} from '../actions';

/**
 * Talep detayı (#3), design `requestDetail` (ADMIN-DESIGN-001 Faz 3A).
 *
 * The screen is a summary card over four tabs — "Talep bilgileri · Teklifler ·
 * Şikayet · Neler oldu" — and every tab is a URL (`?tab=teklifler`), so a tab
 * can be linked to, survives a reload and moves with the browser's Back and
 * Forward. Everything the screen showed before is still here, only distributed
 * across the tabs.
 *
 * Permissions, from `/admin/me/permissions` only:
 * - REQUESTS_READ opens the screen.
 * - "Teklifler" exists only with OFFERS_READ, "Şikayet" only with
 *   REQUEST_REPORTS_READ, and the contact-sharing audit only with
 *   CONTACT_REVEAL_READ. Without the permission the tab (or block) is not
 *   rendered, its endpoint is not called, and a `?tab=` link to it opens the
 *   default tab instead.
 * - Each write control asks for the permission its API route asks for
 *   (route-permission-map.ts). Completing and cancelling are
 *   `@Roles(CUSTOMER, SUPER_ADMIN)` routes that no permission grants, so they
 *   are a super admin's alone.
 *
 * Not rendered: the design's "Süreyi 7 gün uzat" (ADMIN-ACTIONS-001). The
 * expiry is computed from the approval time and a code constant; no API
 * extends it, and a button that did nothing is worse than none.
 */

type RequestDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; statusError?: string; reportError?: string; cancelled?: string }>;
};

type TabKey = '' | 'teklifler' | 'sikayet' | 'gecmis';

const REPORT_ERROR_MESSAGES: Record<string, string> = {
  // Followed on the page by the current status's reason (removalUnavailableReason).
  notRemovable:
    'Talep kaldırılmadı. Kaldırma yalnız açık (yeni, incelemede, yayında) ve bir teklifle eşleşmemiş talebe uygulanır; talep bu sayfa açıldıktan sonra değişmiş olabilir.',
  noOpen: 'Karar kaydedilmedi. Bu talebin açık bildirimi kalmamış; sayfa yenilendi.',
  reasonRequired: 'Talebi kaldırmak için gerekçe seçilmelidir.',
  notReopenable:
    'Talep geri açılmadı. Yalnız bir bildirim sonucu kaldırılmış ve hâlâ reddedilmiş durumdaki talep geri açılabilir.',
  phoneNotVerified:
    'Talep geri açılmadı. Telefon doğrulaması zorunlu olduğu için doğrulanmamış bir talep yeniden yayına alınamaz.',
};

/** An approved request stays open for 14 days from its approval moment. */
const REQUEST_OPEN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The design's ⓘ for the quality card, fitted to the real ten-part score. */
const QUALITY_BREAKDOWN_INFO =
  'Puan on başlıktan toplanır: iletişim, konum, bütçe, tarih, aciliyet, açıklama ve kategori soruları. Eksik kalan başlık, müşteriye hangi bilgiyi sormanız gerektiğini söyler. 80 ve üzeri Yüksek, 50–79 Orta sayılır.';

const OFFER_COLUMNS: DataColumn[] = [
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'no', label: 'Teklif no' },
  { key: 'price', label: 'Teklif', align: 'end' },
  // The design's "Ne zaman gelebilir": the provider's own estimated start.
  { key: 'start', label: 'Ne zaman gelebilir' },
  { key: 'submittedAt', label: 'Verildiği zaman' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

/**
 * When the expiry scheduler would close this request, or null when there is
 * nothing to project: the request is not open any more, or it was approved
 * before approvedAt existed and is therefore never picked up by the scheduler.
 */
function plannedExpiry(request: ServiceRequest): Date | null {
  if (request.status !== 'APPROVED' || !request.approvedAt) {
    return null;
  }

  const approved = new Date(request.approvedAt);
  if (Number.isNaN(approved.getTime())) {
    return null;
  }

  return new Date(approved.getTime() + REQUEST_OPEN_DAYS * DAY_MS);
}

export default async function RequestDetailPage({ params, searchParams }: RequestDetailPageProps) {
  const { can, isSuperAdmin } = await requireAdmin('REQUESTS_READ');
  const { id } = await params;
  const { tab: rawTab, statusError, reportError, cancelled: justCancelled } = await searchParams;
  const request = await fetchOrNotFound(() => apiFetch<ServiceRequest>(`/service-requests/${id}`));

  // Each secondary block belongs to another permission. It is read only when
  // the session holds that permission. Without it the block is not rendered
  // and its endpoint is not called: REQUESTS_READ alone opens the request.
  // Rendering "0 teklif" or "Kayıt yok" instead would state something about
  // data this session was never allowed to read.
  const canReadOffers = can('OFFERS_READ');
  const canReadReports = can('REQUEST_REPORTS_READ');
  const canReadContactReveal = can('CONTACT_REVEAL_READ');
  const canChangeStatus = can('REQUESTS_STATUS');
  const canRecalculateQuality = can('REQUESTS_QUALITY_RECALC');
  const canResolveReports = can('REQUEST_REPORTS_RESOLVE');
  const canReopenRequest = can('REQUESTS_REOPEN');
  const canOpenProviders = can('PROVIDERS_READ_DETAIL');
  const canOpenReviews = can('PROVIDER_REVIEWS_READ');
  // Completing is a customer-or-SUPER_ADMIN route (`@Roles(CUSTOMER,
  // SUPER_ADMIN)`); no role grants it. Cancelling is REQUESTS_CANCEL since
  // PR #118, and keeping the winner's credit on a matched cancel is
  // REQUESTS_CANCEL_WITHOUT_REFUND on top of it. The customer's review is read
  // on the customer's own route, which a SUPER_ADMIN may also read and nobody
  // else.
  const canComplete = isSuperAdmin;
  const canCancel = can('REQUESTS_CANCEL');
  const canWithholdRefund = can('REQUESTS_CANCEL', 'REQUESTS_CANCEL_WITHOUT_REFUND');
  const canReadReview = isSuperAdmin;

  const [offers, reportsResult, reviewState, contactReveal] = await Promise.all([
    canReadOffers ? apiFetch<Offer[]>(`/offers?requestId=${id}`) : Promise.resolve(null),
    // Operator-only: a reporter's note is shown here and nowhere the customer
    // or another provider can see. A failed load is kept apart from an empty
    // list: "no reports" must not be said about a request whose reports could
    // not be read, and no decision form may be offered on it.
    canReadReports
      ? apiFetch<RequestReport[]>(`/service-requests/${id}/reports`).then(
          (reports) => ({ reports, failed: false as const }),
          (error: unknown) => {
            rethrowNextControlFlow(error);
            return { reports: [] as RequestReport[], failed: true as const };
          },
        )
      : Promise.resolve({ reports: [] as RequestReport[], failed: false as const }),
    // The customer's review of the matched provider, read the way the
    // customer's own screen reads it. Null hides the card rather than the
    // screen; the review has its own page.
    canReadReview
      ? apiFetch<CustomerReviewState>(`/service-requests/${id}/review`).catch((error: unknown) => {
          rethrowNextControlFlow(error);
          if (error instanceof ApiError) return null;
          throw error;
        })
      : Promise.resolve(null),
    // Audit only: this panel reports whether contact details were opened and
    // under which disclosure version. It renders no contact value. The
    // operator already has the customer and provider panels for that, and
    // this feature adds nothing to what they show.
    canReadContactReveal
      ? apiFetch<ContactRevealDetail>(`/service-requests/${id}/contact-reveal`).catch(
          (error: unknown) => {
            rethrowNextControlFlow(error);
            return null;
          },
        )
      : Promise.resolve(null),
  ]);

  const reports = reportsResult.reports;
  const reportsFailed = reportsResult.failed;
  const openReports = reports.filter((report) => report.resolvedAt === null);
  const matchedOffer =
    request.matchedOfferId && offers
      ? (offers.find((offer) => offer.id === request.matchedOfferId) ?? null)
      : null;
  const requestRef = request.requestNumber ?? `#${request.id.slice(-8)}`;
  const categoryName = request.category.name;
  const path = `/requests/${request.id}`;

  // A tab the session may not see is not a tab: its link is not drawn, and a
  // `?tab=` pointing at it falls back to the first tab.
  const tabKeys: TabKey[] = [
    '',
    ...(canReadOffers ? (['teklifler'] as const) : []),
    ...(canReadReports ? (['sikayet'] as const) : []),
    'gecmis',
  ];
  const activeTab = resolveTab<TabKey>(rawTab, tabKeys, '');
  const tabs: TabItem[] = [
    { key: '', label: 'Talep bilgileri', testId: 'request-tab-bilgiler' },
    ...(canReadOffers
      ? [{ key: 'teklifler', label: 'Teklifler', count: offers?.length ?? null, testId: 'request-tab-teklifler' }]
      : []),
    ...(canReadReports
      ? [
          {
            key: 'sikayet',
            label: 'Şikayet',
            count: reportsFailed ? null : reports.length,
            testId: 'request-tab-sikayet',
          },
        ]
      : []),
    { key: 'gecmis', label: 'Neler oldu', testId: 'request-tab-gecmis' },
  ];

  // Both the moderation "Reddet" and a report's "Talebi kaldır" arrive at
  // the same API gate, so one flag governs both forms.
  // Mirrors the API's removal rule, match included (PR #120); the API decides.
  const canRemove = isRemovable(request.status, request.matchedOfferId);
  const removalBlockedReason = removalUnavailableReason(request.status, request.matchedOfferId);
  // Derived, not stored: the request is down *because of a report* only when
  // it is REJECTED and some report's decision was the removal.
  const canReopen =
    canReopenRequest &&
    !reportsFailed &&
    request.status === 'REJECTED' &&
    reports.some((report) => report.resolution === 'REQUEST_REMOVED');
  const reportErrorMessage = reportError ? (REPORT_ERROR_MESSAGES[reportError] ?? null) : null;

  const expiry = plannedExpiry(request);
  const now = Date.now();
  const daysLeft = expiry ? Math.max(0, Math.ceil((expiry.getTime() - now) / DAY_MS)) : null;
  const daysPassed =
    expiry && request.approvedAt
      ? Math.min(REQUEST_OPEN_DAYS, Math.max(0, Math.floor((now - new Date(request.approvedAt).getTime()) / DAY_MS)))
      : null;
  const lowestOffer =
    offers && offers.length > 0
      ? offers.reduce((lowest, offer) => (offer.priceAmount < lowest.priceAmount ? offer : lowest))
      : null;

  const facts: SummaryItem[] = [
    {
      label: 'Talep kalitesi',
      value: `${request.qualityScore} / 100`,
      note: qualityLabel(request.qualityLabel),
      tone: request.qualityLabel === 'HIGH' ? 'success' : request.qualityLabel === 'LOW' ? 'danger' : 'neutral',
      testId: 'request-fact-quality',
    },
    ...(offers
      ? [
          {
            label: 'Gelen teklif',
            value: String(offers.length),
            note: lowestOffer ? `En düşük ${formatPrice(lowestOffer.priceAmount, lowestOffer.currency)}` : 'Henüz teklif yok',
            testId: 'request-fact-offers',
          } satisfies SummaryItem,
        ]
      : []),
    { label: 'Bütçe', value: formatBudgetRange(request.budgetMin, request.budgetMax), note: 'Müşterinin verdiği aralık' },
    ...(daysLeft !== null && daysPassed !== null
      ? [
          {
            label: 'Yayında kalan süre',
            value: `${daysLeft} gün`,
            note: `${daysPassed} / ${REQUEST_OPEN_DAYS} gün geçti`,
            testId: 'request-fact-expiry',
          } satisfies SummaryItem,
        ]
      : []),
    ...(canReadReports && !reportsFailed
      ? [
          {
            label: 'Şikayet',
            value: `${reports.length} adet`,
            note: openReports.length > 0 ? `${openReports.length} tanesi karar bekliyor` : 'Karar bekleyen yok',
            tone: openReports.length > 0 ? 'danger' : 'neutral',
            testId: 'request-fact-reports',
          } satisfies SummaryItem,
        ]
      : []),
  ];

  const headerActions =
    canReadOffers || canRecalculateQuality || request.customerPhone ? (
      <>
        {request.customerPhone ? (
          <a className="btn btn-secondary btn-sm" href={`tel:${request.customerPhone}`}>
            Müşteriyi ara
          </a>
        ) : null}
        {canReadOffers ? (
          <Link className="btn btn-secondary btn-sm" href={`/offers?requestId=${request.id}`}>
            Teklifleri görüntüle
          </Link>
        ) : null}
        {canRecalculateQuality ? (
          <form action={recalculateRequestQualityAction}>
            <input type="hidden" name="id" value={request.id} />
            <button className="btn btn-ghost btn-sm" type="submit">
              Kaliteyi yeniden hesapla
            </button>
          </form>
        ) : null}
      </>
    ) : undefined;

  return (
    <main className="request-detail-page">
      <DetailHeader
        back={{ href: '/requests', label: 'Tüm talepler' }}
        badges={
          <>
            <span className={statusBadgeClass(request.status)} data-testid="request-status">
              {requestStatusLabel(request.status)}
            </span>
            <span className={qualityBadgeClass(request.qualityLabel)}>
              {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
            </span>
            {canReadReports && openReports.length > 0 ? (
              <span className="badge badge-bad" data-testid="request-open-reports">
                {openReports.length} şikayet karar bekliyor
              </span>
            ) : null}
          </>
        }
        meta={
          <>
            <code>{requestRef}</code> · {formatDateTime(request.submittedAt)}&apos;de geldi
          </>
        }
        title={`${categoryName} · ${request.district}, ${request.city}`}
        subtitle={
          <>
            Müşteri: {request.customerName}
            {request.customerPhone ? <> · {request.customerPhone}</> : null}
            {request.customerEmail ? <> · {request.customerEmail}</> : null}
          </>
        }
        actions={headerActions}
        facts={facts}
        factsLabel="Talep özeti"
        testId="request-header"
      />

      <Tabs label="Talep sekmeleri" items={tabs} active={activeTab} path={path} testId="request-tabs" />

      {justCancelled === '1' && request.status === 'CANCELLED' ? (
        <div className="notice-success detail-notice" role="status" data-testid="request-cancelled-notice">
          Talep iptal edildi. Teklif kapanışları, kredi iadeleri ve bildirimler iptal kaydında listeleniyor.
        </div>
      ) : null}

      {activeTab === '' ? (
        <div className="detail-panel" data-testid="request-panel-bilgiler">
          <div className="detail-panel-grid">
            <StatusCard
              request={request}
              statusError={statusError}
              canChangeStatus={canChangeStatus}
              canComplete={canComplete}
              canCancel={canCancel}
              canWithholdRefund={canWithholdRefund}
              canRemove={canRemove}
              removalBlockedReason={removalBlockedReason}
              offers={offers}
            />
            <MatchCard
              request={request}
              matchedOffer={matchedOffer}
              canReadOffers={canReadOffers}
              canReadContactReveal={canReadContactReveal}
              contactReveal={contactReveal}
            />
            {request.cancellation ? <CancellationCard cancellation={request.cancellation} canReadOffers={canReadOffers} /> : null}
            <SectionCard title="Müşteri ne istiyor" subtitle="Müşterinin formda yazdıkları.">
              {request.description ? (
                <p className="detail-prose request-description">{request.description}</p>
              ) : (
                <p className="detail-muted-note">Açıklama girilmemiş.</p>
              )}
              <KeyValueList
                items={[
                  { label: 'Aciliyet', value: urgencyLabel(request.urgency) },
                  {
                    label: 'Tercih tarihi',
                    value: request.preferredDate
                      ? formatDateRange(request.preferredDate, request.preferredDateEnd)
                      : null,
                  },
                  { label: 'Bütçe', value: formatBudgetRange(request.budgetMin, request.budgetMax) },
                ]}
              />
            </SectionCard>
            <SectionCard
              title={`Kalite puanı neden ${request.qualityScore}`}
              actions={
                <InfoPopover label="Kalite kırılımı nedir?" size="sm">
                  {QUALITY_BREAKDOWN_INFO}
                </InfoPopover>
              }
            >
              <QualityBreakdown request={request} />
            </SectionCard>
            <SectionCard title="Müşteri" subtitle="İletişim bilgileri ve bağlı hesap.">
              <KeyValueList
                items={[
                  { label: 'Ad soyad', value: request.customerName },
                  {
                    label: 'Telefon',
                    value: request.customerPhone ? (
                      <a className="cell-link" href={`tel:${request.customerPhone}`}>
                        {request.customerPhone}
                      </a>
                    ) : null,
                  },
                  {
                    label: 'E-posta',
                    value: request.customerEmail ? (
                      <a className="cell-link" href={`mailto:${request.customerEmail}`}>
                        {request.customerEmail}
                      </a>
                    ) : null,
                  },
                  {
                    label: 'Telefon doğrulaması',
                    value: request.phoneVerifiedAt ? (
                      <>Doğrulandı · {formatDateTime(request.phoneVerifiedAt)}</>
                    ) : (
                      <span className="cell-muted">Doğrulanmadı</span>
                    ),
                  },
                  {
                    label: 'Bağlı hesap',
                    value: request.customer ? (
                      <span>
                        {request.customer.name ??
                          request.customer.email ??
                          request.customer.phone ??
                          request.customer.id}
                        {request.customer.email ? (
                          <span className="cell-muted"> · {request.customer.email}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="cell-muted">Bağlı hesap yok</span>
                    ),
                  },
                ]}
              />
            </SectionCard>
            <SectionCard title="Adres ve erişim" subtitle="Hizmetin verileceği yer.">
              <KeyValueList
                items={[
                  { label: 'İl / ilçe', value: `${request.city}/${request.district}` },
                  { label: 'Mahalle', value: request.neighborhood },
                  {
                    label: 'Adres notu',
                    value: request.addressNote ? (
                      <span className="request-description">{request.addressNote}</span>
                    ) : (
                      <span className="cell-muted">Adres notu yok.</span>
                    ),
                  },
                ]}
              />
            </SectionCard>
            <LifecycleCard request={request} expiry={expiry} daysLeft={daysLeft} daysPassed={daysPassed} />
            <SectionCard title="Kayıt bilgileri" subtitle="Numara, kategori ve moderasyon kaydı.">
              <KeyValueList
                items={[
                  {
                    label: 'Talep no',
                    value: (
                      <>
                        <code>{requestRef}</code>
                        {request.requestNumber ? (
                          <details className="muted technical-id">
                            <summary>Teknik ID</summary>
                            <code>{request.id}</code>
                          </details>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    label: 'Kategori',
                    value: (
                      <>
                        {categoryName}
                        {request.category.slug ? (
                          <span className="cell-muted"> · {request.category.slug}</span>
                        ) : null}
                      </>
                    ),
                  },
                  { label: 'Gönderim', value: formatDateTime(request.submittedAt) },
                  { label: 'Oluşturuldu', value: formatDateTime(request.createdAt) },
                  { label: 'Güncellendi', value: formatDateTime(request.updatedAt) },
                  {
                    label: 'Moderasyon',
                    value: request.moderatedAt ? formatDateTime(request.moderatedAt) : null,
                  },
                  ...(request.moderationNote
                    ? [
                        {
                          label: 'Moderasyon notu',
                          value: <span className="request-description">{request.moderationNote}</span>,
                        },
                      ]
                    : []),
                  ...(request.rejectionReason
                    ? [
                        {
                          label: 'Ret gerekçesi',
                          value: <span className="request-description">{request.rejectionReason}</span>,
                        },
                      ]
                    : []),
                ]}
              />
            </SectionCard>
            <SectionCard
              className="is-wide"
              title="Kategori soruları"
              subtitle="Müşterinin kategori sorularına verdiği yanıtlar."
            >
              {(request.answers ?? []).length === 0 ? (
                <EmptyState
                  title="Dinamik yanıt yok."
                  description="Bu kategoride zorunlu soru bulunmuyor ya da müşteri opsiyonel soruları yanıtlamamış."
                />
              ) : (
                <div className="answer-card-grid">
                  {(request.answers ?? []).map((answer) => (
                    <div className="answer-card" key={answer.id}>
                      <div className="answer-card-head">
                        <span className="answer-card-label">{answer.questionLabel}</span>
                        <span className="answer-card-meta">
                          <code>{answer.questionKey}</code>
                          <span>·</span>
                          <span>{answer.questionType}</span>
                        </span>
                      </div>
                      <div className="answer-card-value">{formatAnswer(answer.value)}</div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            {canReadReview ? (
              <ReviewCard reviewState={reviewState} canOpenProviders={canOpenProviders} canOpenReviews={canOpenReviews} />
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === 'teklifler' && offers ? (
        <div className="detail-panel">
          <SectionCard
            title="Bu talebe gelen teklifler"
            subtitle={
              offers.length === 0
                ? 'Onaylı talebe teklif geldikçe burada listelenir.'
                : request.matchedOfferId
                  ? request.status === 'CANCELLED'
                    ? 'Kabul edilen teklifle eşleşme, talebin iptaliyle sona erdi.'
                    : request.status === 'MATCHED' || request.status === 'COMPLETED'
                      ? 'Müşteri bir teklifi kabul etti; talep eşleşti.'
                      : 'Talep kapandı; kayıtta bir kabul edilmiş teklif var.'
                  : `Müşteri ${offers.length} teklifi görebilir, henüz birini seçmedi.`
            }
            actions={
              <Link className="btn btn-secondary btn-sm" href={`/offers?requestId=${request.id}`}>
                Tüm teklifleri görüntüle
              </Link>
            }
            padded={offers.length === 0}
          >
            <div data-testid="request-offers-panel">
              {offers.length === 0 ? (
                <p className="request-offers-empty">Bu talebe henüz teklif verilmemiş.</p>
              ) : (
                <DataTable caption="Bu talebe gelen teklifler" columns={OFFER_COLUMNS} minWidth={860}>
                  {offers.map((offer) => {
                    const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
                    return (
                      <tr key={offer.id} data-testid="request-offer-row">
                        <td>
                          <div className="cell-stack">
                            <strong>{offer.provider.businessName}</strong>
                            <span className="cell-muted">
                              {offer.provider.city}/{offer.provider.district}
                            </span>
                          </div>
                        </td>
                        <td className="cell-nowrap">
                          <code className="display-number">{offerRef}</code>
                        </td>
                        <td className="is-num cell-nowrap">
                          <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
                        </td>
                        <td>
                          {offer.estimatedStartDate ? (
                            formatDate(offer.estimatedStartDate)
                          ) : (
                            <span className="cell-muted">Belirtilmedi</span>
                          )}
                        </td>
                        <td>{formatDateTime(offer.submittedAt)}</td>
                        <td>
                          <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>
                        </td>
                        <td className="col-actions">
                          <Link
                            className="btn btn-secondary btn-sm"
                            href={`/offers/${offer.id}`}
                            aria-label={`Aç: ${offer.provider.businessName} teklifi`}
                          >
                            Aç
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </DataTable>
              )}
            </div>
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'sikayet' && canReadReports ? (
        <div className="detail-panel">
          <SectionCard
            id="bildirimler"
            title="Gelen şikayetler"
            subtitle="Hizmet verenlerin bu talep hakkındaki bildirimleri ve verilen kararlar. Bildiren ve notu yalnız yönetici görür."
          >
            {reportErrorMessage ? (
              <div className="status-action-error" role="alert" data-testid="report-error">
                {reportErrorMessage}
                {reportError === 'notRemovable' && removalBlockedReason ? ` ${removalBlockedReason}` : null}
              </div>
            ) : null}

            {reportsFailed ? (
              <p className="status-action-error" role="alert" data-testid="report-load-error">
                Bildirimler yüklenemedi. Sayfayı yenileyin.
              </p>
            ) : reports.length === 0 ? (
              <EmptyState
                title="Bildirim yok."
                description="Bir hizmet veren bu talebi bildirirse burada, kararıyla birlikte görünür."
              />
            ) : (
              <ul className="report-list" data-testid="report-list">
                {reports.map((report) => (
                  <li
                    className={report.resolvedAt ? 'report-item is-resolved' : 'report-item'}
                    key={report.id}
                    data-testid="report-item"
                  >
                    <div className="report-item-head">
                      {report.resolvedAt ? null : <span className="badge badge-bad">Karar bekliyor</span>}
                      <span className="badge badge-muted">{reportReasonLabel(report.reason)}</span>
                      {canOpenProviders ? (
                        <Link className="cell-link" href={`/providers/${report.reporter.id}`}>
                          {report.reporter.businessName}
                        </Link>
                      ) : (
                        <span>{report.reporter.businessName}</span>
                      )}
                      <span className="cell-muted">{formatDateTime(report.createdAt)}</span>
                    </div>
                    {report.note ? (
                      <p className="report-quote">{report.note}</p>
                    ) : (
                      <p className="report-item-note cell-muted">Not yazılmamış.</p>
                    )}
                    <div className="report-item-resolution">
                      {report.resolvedAt && report.resolution ? (
                        <>
                          <span
                            className={
                              report.resolution === 'REQUEST_REMOVED' ? 'badge badge-bad' : 'badge badge-good'
                            }
                          >
                            {reportResolutionLabel(report.resolution)}
                          </span>
                          <span className="cell-muted">
                            {formatDateTime(report.resolvedAt)}
                            {report.resolvedBy?.name ? ` · ${report.resolvedBy.name}` : ''}
                          </span>
                          {report.resolutionNote ? (
                            <span className="report-item-resolution-note">{report.resolutionNote}</span>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {canResolveReports && !reportsFailed && openReports.length > 0 ? (
              <ReportDecisions
                  requestId={request.id}
                  openCount={openReports.length}
                  canRemove={canRemove}
                  removalBlockedReason={removalBlockedReason}
                />
            ) : null}

            {canReopen ? (
              <form action={reopenRequestAction} className="status-reject-form report-decision-form">
                <input type="hidden" name="id" value={request.id} />
                <p className="report-decisions-intro">
                  Bu talep bir bildirim sonucu kaldırıldı. Geri açılırsa yeniden onaylı duruma geçer ve eşleşen
                  hizmet verenlere gösterilir.
                </p>
                <label className="status-reject-field">
                  <span>Moderasyon notu (opsiyonel)</span>
                  <textarea name="moderationNote" placeholder="Yalnızca admin görür" />
                </label>
                <p className="report-decision-hint" role="note">
                  Kapatılan teklifler geri açılmaz; iadeler geri alınmaz. Onay zamanı yenilenir, yani 14 günlük yayın
                  süresi yeniden başlar.
                </p>
                <button className="btn btn-primary btn-sm" type="submit" data-testid="report-reopen">
                  Talebi geri aç
                </button>
              </form>
            ) : null}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'gecmis' ? (
        <div className="detail-panel">
          <SectionCard
            title="Bu talepte neler oldu"
            subtitle="Kayıttaki zamanlardan, en yeni başta. Bir olay yalnız bu ekranda okuma izniniz olan kayıtlardan gösterilir."
          >
            <div data-testid="request-history">
              <Timeline
                items={requestHistory({
                  request,
                  offers,
                  reports: reportsFailed ? [] : reports,
                  contactReveal,
                })}
                empty={<p className="detail-muted-note">Henüz kayıtlı bir olay yok.</p>}
              />
            </div>
          </SectionCard>
        </div>
      ) : null}
    </main>
  );
}

/* ---- Talep bilgileri ---------------------------------------------------- */

function StatusCard({
  request,
  statusError,
  canChangeStatus,
  canComplete,
  canCancel,
  canWithholdRefund,
  canRemove,
  removalBlockedReason,
  offers,
}: {
  request: ServiceRequest;
  statusError: string | undefined;
  canChangeStatus: boolean;
  canComplete: boolean;
  canCancel: boolean;
  canWithholdRefund: boolean;
  canRemove: boolean;
  removalBlockedReason: string | null;
  offers: Offer[] | null;
}) {
  const statusErrorMessage = requestStatusErrorMessage(statusError);
  // A refused rejection says why in terms of the request as it is now.
  const statusErrorDetail = statusError === 'notRemovable' ? removalBlockedReason : null;

  return (
    <SectionCard
      className="is-wide status-action-panel"
      id="durum"
      title="Durum yönetimi"
      subtitle={`İnceleme geçişleri anında uygulanır. Reddetme için gerekçe zorunludur. Eşleşme, tamamlanma ve süre dolumu buradan yazılamaz: süre dolumunu yalnızca zamanlayıcı yazar ve onaydan ${REQUEST_OPEN_DAYS} gün sonra uygular.`}
    >
      {statusErrorMessage ? (
        <div className="status-action-error" role="alert" data-testid="status-error">
          {statusErrorMessage}
          {statusErrorDetail ? ` ${statusErrorDetail}` : null}
        </div>
      ) : null}

      <p className="status-verification-note">
        <strong>Telefon doğrulaması:</strong>{' '}
        {request.phoneVerifiedAt ? (
          <>Doğrulandı · {formatDateTime(request.phoneVerifiedAt)}</>
        ) : (
          <>
            Doğrulanmadı. Telefon doğrulaması zorunlu hale getirildiğinde bu talep onaylanamaz ve hizmet verenlere
            gösterilmez. Reddetme yalnız açık (yeni, incelemede, yayında) ve eşleşmemiş talep için mümkündür; aktif
            teklifleri kapatıp kredilerini iade eder.
          </>
        )}
      </p>

      {canChangeStatus && isInModeration(request.status) ? (
        <div className="status-action-list" data-testid="request-moderation-actions">
          <StatusQuickForm
            requestId={request.id}
            targetStatus="IN_REVIEW"
            currentStatus={request.status}
            label="İncelemeye al"
            variant="secondary"
          />
          <StatusQuickForm
            requestId={request.id}
            targetStatus="APPROVED"
            currentStatus={request.status}
            label="Onayla"
            variant="primary"
          />
        </div>
      ) : canChangeStatus ? (
        // Out of the moderation queue: no move is offered, and the screen says
        // why (lib/request-moderation.ts). Rejecting and cancelling keep their
        // own rules below.
        <p className="status-reject-note" role="note" data-testid="request-moderation-closed">
          Talep “{requestStatusLabel(request.status)}” durumunda; inceleme ve onay geçişleri yalnız yeni, incelemede
          ya da onaylı (yayında) taleplere uygulanır.
          {request.status === 'REJECTED' ? ' Bildirim sonucu kaldırılan talep Şikayet sekmesinden geri açılır.' : ''}
        </p>
      ) : null}

      {canComplete || canCancel ? (
        <div className="status-action-list">
          {canComplete ? (
            <form action={completeRequestAction} className="status-quick-form">
              <input type="hidden" name="id" value={request.id} />
              <button
                className="btn btn-primary btn-sm status-action-btn"
                type="submit"
                disabled={request.status !== 'MATCHED'}
                aria-disabled={request.status !== 'MATCHED'}
                title={request.status === 'MATCHED' ? undefined : 'Yalnız eşleşmiş talep tamamlanabilir.'}
              >
                <span className="status-action-label">Hizmeti tamamlandı işaretle</span>
              </button>
            </form>
          ) : null}
          {canCancel ? (
            isTerminalStatus(request.status) ? (
              <button
                className="btn btn-ghost btn-sm status-action-btn"
                type="button"
                disabled
                aria-disabled
                title="Talep kapanmış durumda."
              >
                <span className="status-action-label">İptal et</span>
              </button>
            ) : (
              <CancelRequestForm
                requestId={request.id}
                matchedOfferId={request.matchedOfferId}
                canWithhold={canWithholdRefund}
                counts={cancelOfferCounts(request, offers)}
              />
            )
          ) : null}
        </div>
      ) : null}

      {canChangeStatus ? (
        <details className="status-reject-block" open={request.status === 'REJECTED'}>
          <summary>
            Reddet
            {request.status === 'REJECTED' ? <span className="status-current-tag">Mevcut durum</span> : null}
          </summary>
          <p className="status-reject-note">
            Reddetme yalnız açık (yayında, incelemede, yeni) talep için mümkündür; aktif teklifleri kapatır ve harcanan
            kredileri iade eder.
          </p>
          <form action={updateRequestStatusAction} className="status-reject-form">
            <input type="hidden" name="id" value={request.id} />
            <input type="hidden" name="status" value="REJECTED" />
            <label className="status-reject-field">
              <span>Ret gerekçesi (zorunlu)</span>
              <textarea
                name="rejectionReason"
                required
                defaultValue={request.rejectionReason ?? ''}
                placeholder="Müşteriye gösterilecek gerekçe"
                disabled={!canRemove}
              />
            </label>
            <label className="status-reject-field">
              <span>Moderasyon notu (opsiyonel)</span>
              <textarea
                name="moderationNote"
                defaultValue={request.moderationNote ?? ''}
                placeholder="Yalnızca admin görür"
                disabled={!canRemove}
              />
            </label>
            {canRemove ? (
              <ConfirmDialog
                triggerLabel="Talebi reddet"
                triggerClassName="btn btn-danger btn-sm"
                title="Talep reddedilsin mi?"
                consequence={
                  <>
                    <p>
                      Talep reddedilir ve hizmet verenlere gösterilmez. Üzerindeki açık teklifler (gönderildi,
                      görüntülendi, kısa listede) kapatılır ve bu teklifler için harcanan krediler hizmet verenlere
                      iade edilir. Vitrinden geldiyse işletmeyle açılan kayıt da kapanır.
                    </p>
                    <p>
                      Ret gerekçesi talebin kaydına yazılır. Bu işlem e-posta göndermez. Kapatılan teklifler ve
                      yapılan iadeler geri alınmaz.
                    </p>
                  </>
                }
                confirmLabel="Evet, reddet"
                testId="status-reject"
              />
            ) : (
              <button
                className="btn btn-danger btn-sm"
                type="submit"
                disabled
                aria-disabled
                data-testid="status-reject"
              >
                {request.status === 'REJECTED' ? 'Talep zaten reddedildi' : 'Talebi reddet'}
              </button>
            )}
            {removalBlockedReason ? (
              <p className="status-reject-note" role="note" data-testid="status-reject-hint">
                {removalBlockedReason}
              </p>
            ) : null}
          </form>
        </details>
      ) : null}
    </SectionCard>
  );
}

/**
 * What the cancel will find on this request, from the offer list the page
 * already read (null when the session cannot read offers). Mirrors the API's
 * cancelLoserOfferRule; a REJECTED offer counts as "rejected because another
 * offer was accepted" only when its rejectionReason says COMPETITOR_ACCEPTED
 * and the request is matched.
 */
function cancelOfferCounts(request: ServiceRequest, offers: Offer[] | null): CancelOfferCounts {
  if (!offers) return null;
  const matched = request.matchedOfferId !== null;
  const others = offers.filter((offer) => offer.id !== request.matchedOfferId);
  const winner = offers.find((offer) => offer.id === request.matchedOfferId) ?? null;
  const competitorRejected = matched
    ? others.filter((offer) => offer.status === 'REJECTED' && offer.rejectionReason === 'COMPETITOR_ACCEPTED').length
    : 0;
  return {
    live: others.filter((offer) => LIVE_OFFER_STATUSES.has(offer.status)).length,
    competitorRejected,
    otherRejected: others.filter((offer) => offer.status === 'REJECTED').length - competitorRejected,
    // The first charge not yet refunded, or — when it was refunded and the
    // acceptance charged again (BUG-OFFER-REFUND-ACCEPT-001) — that second
    // charge not yet refunded. The same rule the API's cancel applies.
    winnerRefundable: Boolean(
      winner &&
        winner.creditCost > 0 &&
        ((winner.creditSpentTransactionId && !winner.creditRefundedAt) ||
          (winner.creditRechargeTransactionId && !winner.creditRechargeRefundedAt)),
    ),
    winnerCreditCost: winner?.creditCost ?? 0,
  };
}

/** The cancellation record (PR #118): who, what was decided about the winner's credit, and why. */
function CancellationCard({
  cancellation,
  canReadOffers,
}: {
  cancellation: RequestCancellation;
  canReadOffers: boolean;
}) {
  const offerLink = (offerId: string) =>
    canReadOffers ? (
      <Link key={offerId} className="cell-link" href={`/offers/${offerId}`}>
        #{offerId.slice(-8)}
      </Link>
    ) : (
      <span key={offerId}>#{offerId.slice(-8)}</span>
    );
  const list = (ids: string[]) =>
    ids.length === 0 ? '—' : ids.map((offerId, index) => [index > 0 ? ', ' : null, offerLink(offerId)]);

  return (
    <SectionCard title="İptal kaydı" subtitle="İptali kimin yaptığı ve kredi kararları. Yalnız yöneticiler görür.">
      <dl className="kv-list" data-testid="request-cancellation">
        <div className="kv-row">
          <dt>İptal eden</dt>
          <dd>
            {cancellation.actorKind === 'CUSTOMER' ? 'Müşteri' : 'Yönetici'} ·{' '}
            {cancellation.actor.name ?? cancellation.actor.email ?? cancellation.actor.id}
          </dd>
        </div>
        <div className="kv-row">
          <dt>Zaman</dt>
          <dd>{formatDateTime(cancellation.createdAt)}</dd>
        </div>
        <div className="kv-row">
          <dt>Önceki durum</dt>
          <dd>{requestStatusLabel(cancellation.previousStatus)}</dd>
        </div>
        <div className="kv-row">
          <dt>Kazanan teklif</dt>
          <dd data-testid="request-cancellation-decision">{WINNER_REFUND_DECISION_LABELS[cancellation.winnerRefundDecision]}</dd>
        </div>
        {cancellation.withholdReason ? (
          <div className="kv-row">
            <dt>İadesiz iptal gerekçesi</dt>
            <dd className="detail-prose" data-testid="request-cancellation-reason">
              {cancellation.withholdReason}
            </dd>
          </div>
        ) : null}
        <div className="kv-row">
          <dt>Kapatılan teklifler</dt>
          <dd>{list(cancellation.closedOfferIds)}</dd>
        </div>
        <div className="kv-row">
          <dt>Kredisi iade edilen teklifler</dt>
          <dd>{list(cancellation.refundedOfferIds)}</dd>
        </div>
      </dl>
    </SectionCard>
  );
}

function MatchCard({
  request,
  matchedOffer,
  canReadOffers,
  canReadContactReveal,
  contactReveal,
}: {
  request: ServiceRequest;
  matchedOffer: Offer | null;
  canReadOffers: boolean;
  canReadContactReveal: boolean;
  contactReveal: ContactRevealDetail | null;
}) {
  // `matchedOfferId` outlives the match on purpose: a cancel keeps it as the
  // record of which offer was accepted (PR #118). Only MATCHED and COMPLETED
  // are a live (or delivered) match; on any other status the card says the
  // match has ended, so the historical pointer is never read as a current one.
  const matchLive = request.status === 'MATCHED' || request.status === 'COMPLETED';
  return (
    <SectionCard
      title="Eşleşme"
      subtitle={
        request.matchedOfferId && !matchLive
          ? 'Tarihsel kayıt: bu eşleşme sona erdi. İletişim paylaşımı ve mesajlaşma kapalı.'
          : 'Müşterinin kabul ettiği teklif ve iletişim paylaşımı.'
      }
    >
      {request.matchedOfferId ? (
        <dl className="kv-list">
          <div className="kv-row" data-testid="match-state">
            <dt>Eşleşme durumu</dt>
            <dd>
              {matchLive ? (
                <span className="badge badge-good">{request.status === 'COMPLETED' ? 'Tamamlandı' : 'Aktif'}</span>
              ) : (
                <span className="badge badge-bad">
                  {request.status === 'CANCELLED' ? 'Sona erdi · talep iptal edildi' : 'Sona erdi'}
                </span>
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Kabul edilen teklif</dt>
            <dd>
              {canReadOffers ? (
                <Link className="cell-link" href={`/offers/${request.matchedOfferId}`}>
                  {matchedOffer ? matchedOffer.provider.businessName : `#${request.matchedOfferId.slice(-8)}`}
                </Link>
              ) : (
                <span>#{request.matchedOfferId.slice(-8)}</span>
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Teklif kimliği</dt>
            <dd>
              <code>{request.matchedOfferId}</code>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Eşleşme zamanı</dt>
            <dd>{formatDateTime(request.matchedAt)}</dd>
          </div>
          {request.completedAt ? (
            <div className="kv-row">
              <dt>Tamamlanma</dt>
              <dd>{formatDateTime(request.completedAt)}</dd>
            </div>
          ) : null}
          {request.cancelledAt ? (
            <div className="kv-row">
              <dt>İptal</dt>
              <dd>{formatDateTime(request.cancelledAt)}</dd>
            </div>
          ) : null}
          {/*
            Read-only audit. There is no action here on purpose: the reveal
            is written once inside the accept transaction, and nothing in
            the product may repeat, edit or undo it.
          */}
          {canReadContactReveal ? (
            <div className="kv-row" data-testid="contact-reveal-audit">
              <dt>İletişim paylaşımı</dt>
              <dd>
                {contactReveal?.event ? (
                  <>
                    {formatDateTime(contactReveal.event.revealedAt)}
                    <span className="muted">
                      {' '}
                      · metin sürümü <code>{contactReveal.event.disclosureVersion}</code>
                    </span>
                    {contactReveal.event.offerId !== request.matchedOfferId ? (
                      <span className="badge badge-bad">Eşleşme ile tutarsız</span>
                    ) : null}
                  </>
                ) : (
                  <span className="muted">Kayıt yok</span>
                )}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="request-offers-empty">Bu talep henüz bir teklifle eşleşmedi.</p>
      )}
    </SectionCard>
  );
}

function QualityBreakdown({ request }: { request: ServiceRequest }) {
  const qualityFillPercent = Math.min(100, Math.max(0, request.qualityScore));
  return (
    <div className="quality-summary">
      <div className="quality-summary-head">
        <span className={qualityBadgeClass(request.qualityLabel)}>
          {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
        </span>
        <div className="request-quality-bar" role="presentation">
          <span
            className={`request-quality-bar-fill request-quality-bar-fill-${request.qualityLabel.toLowerCase()}`}
            style={{ width: `${qualityFillPercent}%` }}
          />
        </div>
      </div>
      {request.qualityScoreBreakdown ? (
        <div className="quality-breakdown-grid">
          {Object.entries(request.qualityScoreBreakdown).map(([key, component]) => (
            <QualityBreakdownItem key={key} keyName={key} component={component} />
          ))}
        </div>
      ) : (
        <p className="cell-muted">Kalite kırılımı henüz hesaplanmadı.</p>
      )}
    </div>
  );
}

function LifecycleCard({
  request,
  expiry,
  daysLeft,
  daysPassed,
}: {
  request: ServiceRequest;
  expiry: Date | null;
  daysLeft: number | null;
  daysPassed: number | null;
}) {
  return (
    <SectionCard title="Bu talebe ne olacak" subtitle="Yayın süresi ve hatırlatma, kayıttaki zamanlardan.">
      <p className="detail-prose">{lifecycleSentence(request, daysLeft)}</p>
      {expiry && daysPassed !== null ? (
        <div className="lifecycle-progress" aria-hidden="true">
          <div className="lifecycle-progress-bar">
            <span
              className="lifecycle-progress-fill"
              style={{ width: `${Math.round((daysPassed / REQUEST_OPEN_DAYS) * 100)}%` }}
            />
          </div>
          <span className="lifecycle-progress-label">
            {daysPassed} / {REQUEST_OPEN_DAYS} gün
          </span>
        </div>
      ) : null}
      <KeyValueList
        items={[
          {
            label: 'Onay',
            value: request.approvedAt ? (
              formatDateTime(request.approvedAt)
            ) : request.status === 'APPROVED' ? (
              <span className="cell-muted">Kayıtlı değil</span>
            ) : null,
          },
          {
            label: 'Süre bitişi',
            value: request.expiredAt ? (
              formatDateTime(request.expiredAt)
            ) : expiry ? (
              <span className="cell-muted">{formatDateTime(expiry.toISOString())} (planlanan)</span>
            ) : null,
          },
          {
            label: 'Hatırlatma',
            value: request.reminderSentAt ? (
              formatDateTime(request.reminderSentAt)
            ) : (
              <span className="cell-muted">Gönderilmedi</span>
            ),
          },
        ]}
      />
    </SectionCard>
  );
}

/** What the lifecycle will do next, said from the record — never a promise the scheduler does not keep. */
function lifecycleSentence(request: ServiceRequest, daysLeft: number | null): string {
  switch (request.status) {
    case 'APPROVED':
      if (!request.approvedAt) {
        return 'Talep yayında, ancak onay zamanı kayıtlı değil: bu alan eklenmeden önce onaylandığı için süre dolumu ve hatırlatma bu talebe hiç uygulanmaz.';
      }
      return `Talep yayında. Yayında kalma süresi ${REQUEST_OPEN_DAYS} gün; ${daysLeft} gün kaldı. Onaydan 7 gün sonra hâlâ hiç teklif yoksa müşteriye bir kez hatırlatma gider; süre dolduğunda talep kendiliğinden kapanır ve verilmiş teklifler kayıtta kalır. İkisini de Operasyon ayarlarındaki zamanlanmış işler yapar; iş kapalıysa bekler.`;
    case 'MATCHED':
      return 'Müşteri bir teklifi kabul etti. Süre dolumu eşleşmiş talebe uygulanmaz; talep hizmet tamamlandı olarak işaretlenene ya da iptal edilene kadar bu durumda kalır.';
    case 'SUBMITTED':
    case 'IN_REVIEW':
      return 'Talep henüz yayında değil. Onaylandığında hizmet verenlere açılır ve 14 günlük yayın süresi o anda başlar.';
    case 'DRAFT':
      return 'Talep taslak durumda; müşteri göndermedikçe hiçbir süre işlemez.';
    case 'EXPIRED':
      return 'Yayın süresi doldu; talep kendiliğinden kapandı ve hizmet verenlere gösterilmiyor.';
    case 'COMPLETED':
      return 'Hizmet tamamlandı olarak işaretlendi; talep kapandı.';
    case 'CANCELLED':
      return 'Talep iptal edildi; hizmet verenlere gösterilmiyor.';
    case 'REJECTED':
      return 'Talep reddedildi; hizmet verenlere gösterilmiyor.';
    default:
      return 'Talebin durumu için planlanmış bir işlem yok.';
  }
}

function ReviewCard({
  reviewState,
  canOpenProviders,
  canOpenReviews,
}: {
  reviewState: CustomerReviewState | null;
  canOpenProviders: boolean;
  canOpenReviews: boolean;
}) {
  return (
    <SectionCard
      title="Değerlendirme"
      subtitle="Müşterinin, kabul ettiği teklifin hizmet vereni hakkındaki değerlendirmesi."
    >
      {reviewState?.review ? (
        <dl className="kv-list" data-testid="request-review">
          <div className="kv-row">
            <dt>Puan</dt>
            <dd>
              <span className="badge badge-muted" aria-label={`5 üzerinden ${reviewState.review.rating}`}>
                ★ {reviewState.review.rating}
              </span>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Durum</dt>
            <dd>
              <span
                className={reviewStateBadgeClass({
                  removed: reviewState.review.removed,
                  commentRemoved: reviewState.review.commentRemoved,
                })}
              >
                {reviewStateLabel({
                  removed: reviewState.review.removed,
                  commentRemoved: reviewState.review.commentRemoved,
                })}
              </span>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Hizmet veren</dt>
            <dd>
              {reviewState.provider && canOpenProviders ? (
                <Link className="cell-link" href={`/providers/${reviewState.provider.id}`}>
                  {reviewState.provider.businessName}
                </Link>
              ) : reviewState.provider ? (
                reviewState.provider.businessName
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Tarih</dt>
            <dd>{formatDateTime(reviewState.review.createdAt)}</dd>
          </div>
          {canOpenReviews ? (
            <div className="kv-row">
              <dt>Detay</dt>
              <dd>
                <Link className="btn btn-ghost btn-sm" href={`/provider-reviews/${reviewState.review.id}`}>
                  Değerlendirmeyi aç
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="cell-muted" style={{ margin: 0 }} data-testid="request-review-none">
          {reviewState?.eligibility === 'disabled' ? 'Değerlendirme özelliği kapalı.' : 'Değerlendirme yok.'}
        </p>
      )}
    </SectionCard>
  );
}

/* ---- Şikayet --------------------------------------------------------------- */

function ReportDecisions({
  requestId,
  openCount,
  canRemove,
  removalBlockedReason,
}: {
  requestId: string;
  openCount: number;
  canRemove: boolean;
  removalBlockedReason: string | null;
}) {
  return (
    <div className="report-decisions" data-testid="report-decisions">
      <p className="report-decisions-intro">
        {openCount} açık bildirim var. Karar tüm açık bildirimleri birlikte kapatır.
      </p>

      <form action={resolveReportsAction} className="status-reject-form report-decision-form">
        <input type="hidden" name="id" value={requestId} />
        <input type="hidden" name="resolution" value="DISMISSED" />
        <label className="status-reject-field">
          <span>Not (opsiyonel, yalnız yönetici görür)</span>
          <textarea name="resolutionNote" placeholder="Neden uygun bulundu?" />
        </label>
        <p className="report-decision-hint">
          Bildirimler kapanır; talep, teklifler ve krediler olduğu gibi kalır. Kimseye e-posta gönderilmez.
        </p>
        <button className="btn btn-secondary btn-sm" type="submit" data-testid="report-dismiss">
          Uygun bulundu
        </button>
      </form>

      {/*
        Open by default: the operator came here to decide, and the required
        reason select plus the confirmation are the guard against a careless
        removal, not the fold. The fold is still there to collapse the form.
      */}
      <details className="status-reject-block report-remove-block" open>
        <summary data-testid="report-remove-toggle">Talebi kaldır</summary>
        <form action={resolveReportsAction} className="status-reject-form report-decision-form">
          <input type="hidden" name="id" value={requestId} />
          <input type="hidden" name="resolution" value="REQUEST_REMOVED" />
          <fieldset className="report-remove-fieldset" disabled={!canRemove}>
            <legend>Talebi kaldır</legend>
            <label className="status-reject-field">
              <span>Gerekçe (zorunlu; müşteriye gösterilecek metin yanında)</span>
              <select name="removalReason" required defaultValue="">
                <option value="" disabled>
                  Gerekçe seçin
                </option>
                {REPORT_REASON_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {REPORT_REASON_ADMIN_LABELS[key]} — “{REMOVAL_REASON_CUSTOMER_LABELS[key]}”
                  </option>
                ))}
              </select>
            </label>
            <label className="status-reject-field">
              <span>Not (opsiyonel, yalnız yönetici görür)</span>
              <textarea name="resolutionNote" placeholder="Karar gerekçesi" />
            </label>
            <p className="report-decision-hint">
              Kaldırma talebi reddeder, aktif teklifleri kapatır ve harcanan kredileri iade eder. Müşteriye yalnız
              seçilen gerekçe gösterilir.
            </p>
            <ConfirmDialog
              triggerLabel="Talebi kaldır"
              triggerClassName="btn btn-danger btn-sm"
              title="Talep kaldırılsın mı?"
              consequence={
                <>
                  <p>
                    Açık bildirimlerin hepsi kaldırma kararıyla kapanır ve talep reddedilir: hizmet
                    verenlere artık gösterilmez. Üzerindeki açık teklifler (gönderildi, görüntülendi, kısa listede)
                    kapatılır ve bu teklifler için harcanan krediler hizmet verenlere iade edilir.
                  </p>
                  <p>
                    Müşteriye, seçtiğiniz gerekçeyle talebinin kaldırıldığı e-postası gider. Hizmet verenlere e-posta
                    gitmez. Talep sonradan geri açılabilir, ama kapatılan teklifler ve yapılan iadeler geri alınmaz.
                  </p>
                </>
              }
              confirmLabel="Evet, talebi kaldır"
              testId="report-remove"
            />
          </fieldset>
          {removalBlockedReason ? (
            <p className="report-decision-hint" role="note" data-testid="report-remove-hint">
              {removalBlockedReason}
            </p>
          ) : null}
        </form>
      </details>
    </div>
  );
}

/* ---- Neler oldu --------------------------------------------------------- */

/**
 * The request's history, from the timestamps the records already carry — and
 * only from records this session may read. Nothing here is inferred: an event
 * with no stored time is not drawn, and "who" is named only where the record
 * names someone.
 */
function requestHistory({
  request,
  offers,
  reports,
  contactReveal,
}: {
  request: ServiceRequest;
  offers: Offer[] | null;
  reports: RequestReport[];
  contactReveal: ContactRevealDetail | null;
}): TimelineItem[] {
  const events: Array<Omit<TimelineItem, 'when'> & { at: string }> = [];
  const push = (key: string, at: string | null | undefined, title: string, actor?: string | null, note?: string | null) => {
    if (!at) return;
    events.push({ key, at, dateTime: at, title, actor: actor ?? undefined, note: note ?? undefined });
  };

  push('submitted', request.submittedAt, 'Müşteri talebi gönderdi', request.customerName);
  push('phone', request.phoneVerifiedAt, 'Müşteri telefon numarasını doğruladı', request.customerName);
  push('approved', request.approvedAt, 'Talep onaylandı ve hizmet verenlere açıldı (son onay)');
  push('moderated', request.moderatedAt, 'Son moderasyon işlemi kaydedildi', null, request.moderationNote);
  push('reminder', request.reminderSentAt, 'Müşteriye süre hatırlatması gönderildi');
  push('matched', request.matchedAt, 'Talep eşleşti: müşteri bir teklifi kabul etti');
  push('completed', request.completedAt, 'Hizmet tamamlandı olarak işaretlendi');
  push('cancelled', request.cancelledAt, 'Talep iptal edildi');
  push('expired', request.expiredAt, 'Yayın süresi doldu, talep kapandı', 'Sistem');

  for (const offer of offers ?? []) {
    push(
      `offer-${offer.id}`,
      offer.submittedAt,
      `Teklif geldi · ${formatPrice(offer.priceAmount, offer.currency)}`,
      offer.provider.businessName,
    );
    push(`offer-accepted-${offer.id}`, offer.acceptedAt, 'Teklif kabul edildi', offer.provider.businessName);
    push(`offer-withdrawn-${offer.id}`, offer.withdrawnAt, 'Teklif geri çekildi', offer.provider.businessName);
  }

  if (contactReveal?.event) {
    push(
      'contact-reveal',
      contactReveal.event.revealedAt,
      'İletişim bilgileri iki tarafa açıldı',
      null,
      `Metin sürümü ${contactReveal.event.disclosureVersion}`,
    );
  }

  for (const report of reports) {
    push(
      `report-${report.id}`,
      report.createdAt,
      `Şikayet bildirildi: ${reportReasonLabel(report.reason)}`,
      report.reporter.businessName,
    );
    if (report.resolution) {
      push(
        `report-resolved-${report.id}`,
        report.resolvedAt,
        `Şikayet kararı: ${reportResolutionLabel(report.resolution)}`,
        report.resolvedBy?.name ?? null,
      );
    }
  }

  return events
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map(({ at, ...event }) => ({ ...event, when: formatDateTime(at) }));
}

/* ---- Small pieces ------------------------------------------------------- */

function QualityBreakdownItem({
  keyName,
  component,
}: {
  keyName: string;
  component: QualityScoreBreakdown[string];
}) {
  return (
    <div className={`quality-breakdown-item ${component.passed ? 'is-passed' : 'is-missing'}`}>
      <div className="quality-breakdown-item-head">
        <span className="quality-breakdown-item-label">{qualityBreakdownLabel(keyName)}</span>
        <span className="quality-breakdown-item-score">
          {component.points}/{component.max}
        </span>
      </div>
      <span className={component.passed ? 'badge badge-good' : 'badge badge-muted'}>
        {component.passed ? 'Tamam' : 'Eksik'}
      </span>
    </div>
  );
}

/** Offers still in play: what an acceptance or a rejection cascade would close. */
const LIVE_OFFER_STATUSES: ReadonlySet<string> = new Set(['SUBMITTED', 'VIEWED', 'SHORTLISTED']);

function isTerminalStatus(status: string) {
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'EXPIRED' || status === 'REJECTED';
}

type StatusQuickFormProps = {
  requestId: string;
  targetStatus: 'IN_REVIEW' | 'APPROVED';
  currentStatus: string;
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
};

function StatusQuickForm({ requestId, targetStatus, currentStatus, label, variant }: StatusQuickFormProps) {
  const move = moderationMove(currentStatus, targetStatus);
  if (move === 'hidden') return null;
  const isCurrent = move === 'current';
  const buttonClass = isCurrent
    ? 'btn btn-sm status-action-btn is-current'
    : `btn btn-${variant} btn-sm status-action-btn`;
  return (
    <form action={updateRequestStatusAction} className="status-quick-form">
      <input type="hidden" name="id" value={requestId} />
      <input type="hidden" name="status" value={targetStatus} />
      <button className={buttonClass} type="submit" disabled={isCurrent} aria-disabled={isCurrent}>
        <span className="status-action-label">{label}</span>
        {isCurrent ? <span className="status-current-tag">Mevcut</span> : null}
      </button>
    </form>
  );
}

function formatAnswer(value: unknown) {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  return String(value);
}
