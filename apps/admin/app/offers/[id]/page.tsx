import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  apiFetch,
  fetchOrNotFound,
  formatDate,
  formatDateTime,
  formatPrice,
  Offer,
  OfferStatus,
  refundActionBadgeClass,
  refundActionLabel,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DetailHeader } from '../../../components/detail-header';
import { InfoPopover } from '../../../components/info-popover';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../components/tabs';
import { Timeline, type TimelineItem } from '../../../components/timeline';
import { resolveTab } from '../../../lib/list-query';
import { refundOfferCreditAction, updateOfferStatusAction } from '../actions';

/**
 * Teklif detayı (#6), design `offerDetail` (ADMIN-DESIGN-001 Faz 3A).
 *
 * A summary card over four URL tabs — "Teklif ve işlemler · İlgili talep ·
 * Kredi ve iade · Neler oldu". The design's operations list keeps only the
 * operations this panel can actually perform:
 *
 * - accept, reject and shortlist on the customer's behalf (OFFERS_STATUS,
 *   `PATCH /offers/:id/status`), and
 * - the operations refund (OFFER_REFUND_MANUAL, `POST /offers/:id/refund-credit`).
 *
 * "Teklifi müşteriden kaldır", "Müşteriye hatırlatma gönder", "Hizmet vereni
 * uyar" and "Eşleşmeyi iptal et" have no API behind them (ADMIN-ACTIONS-002 to
 * -005) and are not drawn.
 *
 * The status operations are also drawn only where the API would carry them
 * out. `PATCH /offers/:id/status` lets a staff account act on a request with no
 * customer account, and only a super admin on one that has a customer account
 * (`ensureCustomerCanAccessRequest`); it refuses withdrawn, cancelled and
 * expired offers; and it accepts only on an approved, unmatched request. A
 * button the API is certain to refuse would only lead to an error screen, so
 * the screen says why instead. The API still decides every case.
 */

type OfferDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string; refunded?: string; statusSaved?: string }>;
};

type TabKey = '' | 'talep' | 'kredi' | 'gecmis';
const TAB_KEYS: readonly TabKey[] = ['', 'talep', 'kredi', 'gecmis'];

/** The statuses the offer status endpoint refuses to move an offer out of. */
const CLOSED_OFFER_STATUSES: ReadonlySet<OfferStatus> = new Set(['WITHDRAWN', 'CANCELLED', 'EXPIRED']);

/**
 * The operations reasons a manual refund may be filed under. Mirrors
 * MANUAL_REFUND_REASON_CODES on the API side, which validates the choice; this
 * list only decides what the select offers.
 *
 * None of these is UNVIEWED_OFFER_48H. That code belongs to the automatic
 * worker and to it alone, so a finance report can always tell what the policy
 * cost from what operations decided.
 */
const manualRefundReasons: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'INVALID_REQUEST', label: 'Geçersiz talep' },
  { code: 'CUSTOMER_UNREACHABLE', label: 'Müşteriye ulaşılamadı' },
  { code: 'DUPLICATE_REQUEST', label: 'Mükerrer talep' },
  { code: 'PLATFORM_ERROR', label: 'Platform hatası' },
  { code: 'GOODWILL', label: 'İyi niyet iadesi' },
  { code: 'OTHER', label: 'Diğer' },
];

/** The design's ⓘ for the operations list, fitted to what these operations record. */
const OPERATIONS_INFO =
  'Her işlem, altındaki açıklamada yazan şeyi yapar. Sonucu geri alınamayan işlemler önce ne olacağını söyleyip onay ister. Kredi iadesi, işlemi yapan yönetici ve gerekçesiyle kalıcı olarak kaydedilir.';

function statusTone(status: OfferStatus): SummaryItem['tone'] {
  switch (status) {
    case 'ACCEPTED':
      return 'success';
    case 'SHORTLISTED':
    case 'VIEWED':
      return 'warning';
    case 'REJECTED':
    case 'WITHDRAWN':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export default async function OfferDetailPage({ params, searchParams }: OfferDetailPageProps) {
  const { can, isSuperAdmin } = await requireAdmin('OFFERS_READ');
  const canReadRequests = can('REQUESTS_READ');
  const canReadProviderDetail = can('PROVIDERS_READ_DETAIL');
  const canReadProviderCredits = can('FINANCE_LEDGER_READ');
  const canUpdateStatus = can('OFFERS_STATUS');
  const canManualRefund = can('OFFER_REFUND_MANUAL');
  const { id } = await params;
  const search = (await searchParams) ?? {};
  const justRefunded = search.refunded === '1';
  const justStatusSaved = search.statusSaved === '1';
  const activeTab = resolveTab<TabKey>(search.tab, TAB_KEYS, '');

  const offer = await fetchOrNotFound(() => apiFetch<Offer>(`/offers/${id}`));

  const customerName = offer.request.customerName;
  const isRefunded = Boolean(offer.creditRefundedAt);
  const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
  const requestRef = offer.request.requestNumber ?? `#${offer.request.id.slice(-8)}`;
  const price = formatPrice(offer.priceAmount, offer.currency);
  const path = `/offers/${offer.id}`;

  // What the status endpoint will carry out for this session (see the file
  // comment). The permission is the route's; the rest is the API's own rule.
  const apiLetsSessionDecide = isSuperAdmin || offer.request.customer === null;
  const offerIsClosed = CLOSED_OFFER_STATUSES.has(offer.status);
  const canOfferStatusActions = canUpdateStatus && apiLetsSessionDecide && !offerIsClosed;
  const canRefundHere = canManualRefund && !isRefunded && Boolean(offer.creditSpentTransactionId);

  const tabs: TabItem[] = [
    { key: '', label: 'Teklif ve işlemler', testId: 'offer-tab-islemler' },
    { key: 'talep', label: 'İlgili talep', testId: 'offer-tab-talep' },
    { key: 'kredi', label: 'Kredi ve iade', testId: 'offer-tab-kredi' },
    { key: 'gecmis', label: 'Neler oldu', testId: 'offer-tab-gecmis' },
  ];

  const facts: SummaryItem[] = [
    { label: 'Teklif tutarı', value: price },
    {
      label: 'Harcanan kredi',
      value: String(offer.creditCost),
      note: offer.creditSpentTransactionId ? 'Teklif verildiğinde düşüldü' : 'Kredi harcaması yok',
    },
    {
      label: 'Müşteri gördü mü',
      value: offer.viewedAt ? 'Gördü' : 'Görmedi',
      note: offer.viewedAt ? formatDateTime(offer.viewedAt) : 'Müşteri teklifi henüz açmadı',
      tone: offer.viewedAt ? 'success' : 'neutral',
      testId: 'offer-fact-viewed',
    },
    { label: 'Karar', value: statusLabel(offer.status), tone: statusTone(offer.status) },
    {
      label: 'İade uygunluğu',
      value: isRefunded ? 'İade tamamlandı' : refundActionLabel(offer.refundEligibility.recommendedAction),
      note: isRefunded
        ? offer.creditRefundedAt
          ? formatDateTime(offer.creditRefundedAt)
          : undefined
        : offer.refundEligibility.hoursSinceSubmitted !== null
          ? `${offer.refundEligibility.hoursSinceSubmitted} sa geçti`
          : undefined,
      tone: isRefunded || offer.refundEligibility.recommendedAction === 'FULL_REFUND' ? 'success' : 'neutral',
    },
  ];

  return (
    <main className="offer-detail-page">
      <DetailHeader
        back={{ href: '/offers', label: 'Tüm teklifler' }}
        badges={
          <>
            <span className={statusBadgeClass(offer.status)} data-testid="offer-status">
              {statusLabel(offer.status)}
            </span>
            {isRefunded ? <span className="badge badge-good">Kredi iade edildi</span> : null}
          </>
        }
        meta={
          <>
            <code>{offerRef}</code> · {formatDateTime(offer.submittedAt)}&apos;de verildi
          </>
        }
        title={`${price} · ${offer.provider.businessName}`}
        subtitle={
          <>
            {requestRef} · {offer.request.category.name} · {offer.request.district} · müşteri:{' '}
            {customerName || '-'}
          </>
        }
        actions={
          <>
            {canReadRequests ? (
              <Link className="btn btn-secondary btn-sm" href={`/requests/${offer.request.id}`}>
                Talebi aç
              </Link>
            ) : null}
            {canReadProviderDetail ? (
              <Link className="btn btn-secondary btn-sm" href={`/providers/${offer.provider.id}`}>
                Hizmet vereni aç
              </Link>
            ) : null}
            <Link className="btn btn-ghost btn-sm" href={`/offers?requestId=${offer.request.id}`}>
              Bu talebin tüm teklifleri
            </Link>
          </>
        }
        facts={facts}
        factsLabel="Teklif özeti"
        testId="offer-header"
      />

      {justRefunded ? (
        <div className="notice-success detail-notice" role="status">
          Manuel iade tamamlandı. Kredi hizmet verenin bakiyesine eklendi.
        </div>
      ) : null}
      {justStatusSaved ? (
        <div className="notice-success detail-notice" role="status">
          Teklif durumu güncellendi.
        </div>
      ) : null}

      <Tabs label="Teklif sekmeleri" items={tabs} active={activeTab} path={path} testId="offer-tabs" />

      {activeTab === '' ? (
        <div className="detail-panel" data-testid="offer-panel-islemler">
          <div className="detail-panel-grid">
            <SectionCard title="Hizmet verenin teklifi">
              <KeyValueList
                items={[
                  {
                    label: 'Teklif no',
                    value: (
                      <>
                        <code>{offerRef}</code>
                        {offer.offerNumber ? (
                          <details className="muted technical-id">
                            <summary>Teknik ID</summary>
                            <code>{offer.id}</code>
                          </details>
                        ) : null}
                      </>
                    ),
                  },
                  { label: 'Fiyat', value: <strong>{price}</strong> },
                  { label: 'Mesaj', value: <span className="detail-prose">{offer.message}</span> },
                  { label: 'Garanti', value: offer.warrantyNote },
                  { label: 'İç not', value: offer.internalNote },
                  { label: 'Tahmini başlangıç', value: formatDate(offer.estimatedStartDate) },
                  { label: 'Tahmini bitiş', value: formatDate(offer.estimatedCompletionDate) },
                ]}
              />
            </SectionCard>

            <SectionCard
              title="Yapabileceğin işlemler"
              actions={
                <InfoPopover label="Bu işlemler nedir?" size="sm">
                  {OPERATIONS_INFO}
                </InfoPopover>
              }
            >
              <OperationsList
                offer={offer}
                isSuperAdmin={isSuperAdmin}
                canUpdateStatus={canUpdateStatus}
                apiLetsSessionDecide={apiLetsSessionDecide}
                offerIsClosed={offerIsClosed}
                canOfferStatusActions={canOfferStatusActions}
                canRefundHere={canRefundHere}
                refundHref={`${path}?tab=kredi`}
              />
            </SectionCard>

            <SectionCard title="Hizmet veren">
              <KeyValueList
                items={[
                  { label: 'İşletme', value: offer.provider.businessName },
                  { label: 'Yetkili', value: offer.provider.contactName },
                  {
                    label: 'Telefon',
                    value: offer.provider.phone ? (
                      <a className="cell-link" href={`tel:${offer.provider.phone}`}>
                        {offer.provider.phone}
                      </a>
                    ) : null,
                  },
                  {
                    label: 'E-posta',
                    value: offer.provider.email ? (
                      <a className="cell-link" href={`mailto:${offer.provider.email}`}>
                        {offer.provider.email}
                      </a>
                    ) : null,
                  },
                  { label: 'Konum', value: `${offer.provider.city}/${offer.provider.district}` },
                  {
                    label: 'Durum',
                    value: (
                      <span className={statusBadgeClass(offer.provider.status)}>
                        {statusLabel(offer.provider.status)}
                      </span>
                    ),
                  },
                ]}
              />
              <div className="inline-actions detail-card-links">
                {canReadProviderCredits ? (
                  <Link className="btn btn-ghost btn-sm" href={`/providers/${offer.provider.id}/credits`}>
                    Kredi geçmişi
                  </Link>
                ) : null}
                <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${offer.provider.id}`}>
                  Diğer teklifleri
                </Link>
              </div>
            </SectionCard>
          </div>
        </div>
      ) : null}

      {activeTab === 'talep' ? (
        <div className="detail-panel" data-testid="offer-panel-talep">
          <SectionCard title="Teklifin verildiği talep ve müşteri">
            <KeyValueList
              items={[
                {
                  label: 'Talep no',
                  value: canReadRequests ? (
                    <Link className="cell-link" href={`/requests/${offer.request.id}`}>
                      <code>{requestRef}</code>
                    </Link>
                  ) : (
                    <code>{requestRef}</code>
                  ),
                },
                { label: 'Kategori', value: offer.request.category.name },
                {
                  label: 'Konum',
                  value: `${offer.request.city}/${offer.request.district}${
                    offer.request.neighborhood ? ` · ${offer.request.neighborhood}` : ''
                  }`,
                },
                {
                  label: 'Talep durumu',
                  value: (
                    <span className={statusBadgeClass(offer.request.status)}>{statusLabel(offer.request.status)}</span>
                  ),
                },
                { label: 'Kalite', value: `${offer.request.qualityScore}/100` },
                { label: 'Müşteri', value: customerName || null },
                {
                  label: 'Telefon',
                  value: offer.request.customerPhone ? (
                    <a className="cell-link" href={`tel:${offer.request.customerPhone}`}>
                      {offer.request.customerPhone}
                    </a>
                  ) : null,
                },
                {
                  label: 'E-posta',
                  value: offer.request.customerEmail ? (
                    <a className="cell-link" href={`mailto:${offer.request.customerEmail}`}>
                      {offer.request.customerEmail}
                    </a>
                  ) : null,
                },
                ...(offer.request.customer
                  ? [
                      {
                        label: 'Kullanıcı hesabı',
                        value: (
                          <span className="muted">
                            {offer.request.customer.name ??
                              offer.request.customer.email ??
                              offer.request.customer.phone ??
                              offer.request.customer.id}
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <div className="inline-actions detail-card-links">
              {canReadRequests ? (
                <Link className="btn btn-secondary btn-sm" href={`/requests/${offer.request.id}`}>
                  Talebin tamamını aç
                </Link>
              ) : null}
              <Link className="btn btn-ghost btn-sm" href={`/offers?requestId=${offer.request.id}`}>
                Aynı talebe gelen diğer teklifler
              </Link>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'kredi' ? (
        <div className="detail-panel" data-testid="offer-panel-kredi">
          <div className="detail-panel-grid">
            <SectionCard title="Bu teklifin kredi hikâyesi">
              <KeyValueList
                items={[
                  { label: 'Kredi maliyeti', value: String(offer.creditCost) },
                  {
                    label: 'Harcama işlemi',
                    value: offer.creditSpentTransactionId ? <code>{offer.creditSpentTransactionId}</code> : null,
                  },
                  {
                    label: 'İade işlemi',
                    value: offer.creditRefundedTransactionId ? <code>{offer.creditRefundedTransactionId}</code> : null,
                  },
                  { label: 'İade tarihi', value: offer.creditRefundedAt ? formatDateTime(offer.creditRefundedAt) : null },
                  { label: 'İade sebebi', value: offer.creditRefundReason },
                  {
                    label: 'Uygunluk',
                    value: isRefunded ? (
                      <span className="badge badge-good">İade tamamlandı</span>
                    ) : (
                      <span className={offer.refundEligibility.eligible ? 'badge badge-good' : 'badge badge-muted'}>
                        {offer.refundEligibility.eligible ? 'Uygun' : 'Uygun değil'}
                      </span>
                    ),
                  },
                  {
                    label: 'Öneri',
                    value: isRefunded ? (
                      <span className="badge badge-good">İade edildi</span>
                    ) : (
                      <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
                        {refundActionLabel(offer.refundEligibility.recommendedAction)}
                      </span>
                    ),
                  },
                  { label: 'Sebep kodu', value: <code>{offer.refundEligibility.reasonCode}</code> },
                  { label: 'Detay', value: offer.refundEligibility.details },
                  {
                    label: 'Gönderim sonrası saat',
                    value:
                      offer.refundEligibility.hoursSinceSubmitted !== null
                        ? String(offer.refundEligibility.hoursSinceSubmitted)
                        : null,
                  },
                ]}
              />
              {canReadProviderCredits ? (
                <div className="inline-actions detail-card-links">
                  <Link className="btn btn-ghost btn-sm" href={`/providers/${offer.provider.id}/credits`}>
                    Hizmet veren kredi geçmişi
                  </Link>
                </div>
              ) : null}
            </SectionCard>

            {/*
              Two things, kept apart on purpose.

              The card states where the offer stands under the automatic 48-hour
              policy — the promise providers are actually shown, which the worker
              keeps without being asked. Below it sits the operations refund: the
              remedy for cases the rule cannot see. It is not the policy, and it
              files its own ledger reason so a report can always separate the two.
            */}
            <SectionCard title="Kredi iadesi" id="kredi-iadesi">
              {offer.creditRefundedAt ? (
                <div className="notice-success">
                  Bu teklifin kredi iadesi tamamlandı.{' '}
                  <span className="muted">{formatDateTime(offer.creditRefundedAt)}</span>
                  {offer.creditRefundReason ? (
                    <>
                      {' · '}
                      <code>{offer.creditRefundReason}</code>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="detail-form">
                  {offer.refundEligibility.policyStatus ? (
                    <>
                      <p className="detail-prose">
                        <span className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}>
                          {offer.refundEligibility.policyStatusLabel}
                        </span>
                      </p>
                      <p className="detail-muted-note">{offer.refundEligibility.details}</p>
                      {/*
                        The window this offer was sold under, not today's setting.
                        An operator looking at a case has to see the term that
                        governs it — the two differ as soon as the setting moves.
                      */}
                      {offer.refundEligibility.windowHours !== null ? (
                        <p className="detail-muted-note">
                          İade süresi: {offer.refundEligibility.windowHours} saat
                          {offer.refundEligibility.eligibleAt
                            ? ` · İade zamanı: ${formatDateTime(offer.refundEligibility.eligibleAt)}`
                            : ''}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className="notice-warning">
                      Bu teklif, görüntülenmeyen teklif iade kuralı yürürlüğe girmeden önce gönderildi ve bu kural
                      kapsamında değil.
                    </div>
                  )}

                  {!offer.creditSpentTransactionId ? (
                    <div className="notice-warning">Bu teklifin kredi harcama işlemi yok.</div>
                  ) : canManualRefund ? (
                    <form action={refundOfferCreditAction} className="detail-form" data-testid="offer-refund-form">
                      <input type="hidden" name="id" value={offer.id} />
                      <p className="detail-muted-note">
                        <strong>Manuel iade (operasyon).</strong> Standart iade politikası değildir; hizmet verenlere
                        bir hak olarak duyurulmaz. Yapılan işlem, işlemi yapan yönetici ve gerekçesiyle birlikte
                        kalıcı olarak kaydedilir.
                      </p>
                      <label className="detail-form-field">
                        <span>Operasyon gerekçesi *</span>
                        <select name="reasonCode" defaultValue="INVALID_REQUEST">
                          {manualRefundReasons.map((reason) => (
                            <option key={reason.code} value={reason.code}>
                              {reason.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="detail-form-field">
                        <span>Yönetici notu</span>
                        <textarea name="note" maxLength={1000} />
                      </label>
                      <div className="detail-form-actions">
                        <ConfirmDialog
                          triggerLabel={`${offer.creditCost} krediyi iade et`}
                          triggerClassName="btn btn-danger"
                          title="Kredi iade edilsin mi?"
                          consequence={
                            <>
                              <p>
                                {offer.creditCost} kredi {offer.provider.businessName} bakiyesine geri yüklenir. Kredi
                                hareketlerinde seçtiğiniz gerekçeyle “manuel iade” olarak, işlemi yapan yönetici
                                adıyla kalıcı olarak kaydedilir.
                              </p>
                              <p>
                                Hizmet verene kredi iadesi e-postası gider; yönetici notu e-postada yer almaz.
                                Teklifin durumu değişmez. İade geri alınamaz; yanlış bir iade ancak ayrı bir kredi
                                düşme işlemiyle dengelenir.
                              </p>
                            </>
                          }
                          confirmLabel="Evet, iade et"
                          testId="offer-refund"
                        />
                      </div>
                    </form>
                  ) : null}
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      ) : null}

      {activeTab === 'gecmis' ? (
        <div className="detail-panel" data-testid="offer-panel-gecmis">
          <SectionCard title="Bu teklifte neler oldu" subtitle="Kayıttaki zamanlardan, en yeni başta.">
            <OfferHistory offer={offer} />
          </SectionCard>
        </div>
      ) : null}
    </main>
  );
}

/* ---- "Yapabileceğin işlemler" ------------------------------------------- */

function ActionRow({
  title,
  description,
  when,
  children,
  testId,
}: {
  title: string;
  description: ReactNode;
  when?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <li className="action-list-item" data-testid={testId}>
      <div className="action-list-text">
        <p className="action-list-title">{title}</p>
        <p className="action-list-desc">{description}</p>
        {when ? (
          <p className="action-list-when">
            <strong>Ne zaman:</strong> {when}
          </p>
        ) : null}
      </div>
      {children}
    </li>
  );
}

function OperationsList({
  offer,
  isSuperAdmin,
  canUpdateStatus,
  apiLetsSessionDecide,
  offerIsClosed,
  canOfferStatusActions,
  canRefundHere,
  refundHref,
}: {
  offer: Offer;
  isSuperAdmin: boolean;
  canUpdateStatus: boolean;
  apiLetsSessionDecide: boolean;
  offerIsClosed: boolean;
  canOfferStatusActions: boolean;
  canRefundHere: boolean;
  refundHref: string;
}) {
  const isAccepted = offer.status === 'ACCEPTED';
  const canAccept = canOfferStatusActions && !isAccepted && offer.request.status === 'APPROVED';
  // The refund block a super admin's decision writes (OffersService): the
  // decision is recorded as the customer's, so the automatic refund no longer
  // applies to this offer.
  const refundBlockNote = isSuperAdmin
    ? ' Kararınız müşteri adına kaydedildiği için bu teklif, müşteri görmemiş olsa bile otomatik iade kapsamından çıkar.'
    : '';
  const acceptedWarning = (
    <p>
      <strong>Dikkat: bu teklif kabul edilmiş.</strong> Durumunu değiştirmek talebin eşleşmesini kaldırmaz: talep
      “Eşleşti” olarak bu teklife bağlı kalır ve kayıt tutarsız olur. Eşleşmeyi iptal eden bir işlem henüz yok.
    </p>
  );

  const notes: string[] = [];
  if (canUpdateStatus && !apiLetsSessionDecide) {
    notes.push(
      'Bu talep bir müşteri hesabına bağlı. Teklif kararını müşteri ya da süper yönetici verebilir; bu hesapla durum işlemi yapılamaz.',
    );
  } else if (canUpdateStatus && offerIsClosed) {
    notes.push(`Teklif “${statusLabel(offer.status)}” durumunda; durumu artık değiştirilemez.`);
  } else if (canOfferStatusActions && !isAccepted && offer.request.status !== 'APPROVED') {
    notes.push('Kabul yalnız yayındaki (onaylı ve henüz eşleşmemiş) bir talepte mümkün.');
  }

  const rows: ReactNode[] = [];

  if (canRefundHere) {
    rows.push(
      <ActionRow
        key="refund"
        title="Krediyi iade et"
        description={`Hizmet verenin bu teklif için harcadığı ${offer.creditCost} kredi hesabına geri yüklenir. Gerekçe seçmeniz gerekir; kayıt kredi hareketlerinde “iade” olarak görünür.`}
        when="Şikayet haklı bulunduğunda veya otomatik kuralın göremediği bir hata olduğunda."
        testId="offer-action-refund"
      >
        <Link className="btn btn-primary btn-sm" href={refundHref}>
          İade formuna git
        </Link>
      </ActionRow>,
    );
  }

  if (canAccept) {
    rows.push(
      <ActionRow
        key="accept"
        title="Kabul et"
        description="Müşteri adına bu teklifi kabul eder; müşteri panelindeki kabulle aynı akış çalışır."
        when="Müşteri seçimini size ilettiğinde."
        testId="offer-action-accept"
      >
        <form action={updateOfferStatusAction}>
          <input type="hidden" name="id" value={offer.id} />
          <input type="hidden" name="status" value="ACCEPTED" />
          <ConfirmDialog
            triggerLabel="Kabul et"
            triggerClassName="btn btn-primary btn-sm"
            tone="primary"
            title="Teklif müşteri adına kabul edilsin mi?"
            consequence={
              <>
                <p>
                  Talep bu teklifle eşleşir ve başka hizmet verenlere kapanır. Bu talebe gelen diğer açık teklifler
                  (gönderildi, görüntülendi, kısa listede) “başka teklif kabul edildi” gerekçesiyle reddedilir; bu
                  işlem onların kredisini iade etmez.
                </p>
                <p>
                  Müşteriye eşleşme e-postası, bu hizmet verene “teklifiniz kabul edildi”, diğerlerine “teklifiniz
                  seçilmedi” e-postası gider. İletişim paylaşımı açıksa iki tarafın iletişim bilgileri açılır; müşterinin
                  paylaşım onayı kayıtlı değilse işlem reddedilir.{refundBlockNote}
                </p>
                <p>Eşleşmeyi geri alan bir işlem yok.</p>
              </>
            }
            confirmLabel="Evet, kabul et"
            testId="offer-accept"
          />
        </form>
      </ActionRow>,
    );
  }

  if (canOfferStatusActions && offer.status !== 'SHORTLISTED') {
    rows.push(
      <ActionRow
        key="shortlist"
        title="Kısa listeye al"
        description="Teklif müşteri adına kısa listeye alınır. E-posta gönderilmez, kredi hareket etmez."
        testId="offer-action-shortlist"
      >
        <form action={updateOfferStatusAction}>
          <input type="hidden" name="id" value={offer.id} />
          <input type="hidden" name="status" value="SHORTLISTED" />
          {isAccepted ? (
            <ConfirmDialog
              triggerLabel="Kısa listeye al"
              triggerClassName="btn btn-secondary btn-sm"
              tone="primary"
              title="Kabul edilmiş teklif kısa listeye alınsın mı?"
              consequence={acceptedWarning}
              confirmLabel="Yine de kısa listeye al"
              testId="offer-shortlist"
            />
          ) : (
            <button className="btn btn-secondary btn-sm" type="submit" data-testid="offer-shortlist">
              Kısa listeye al
            </button>
          )}
        </form>
      </ActionRow>,
    );
  }

  if (canOfferStatusActions && offer.status !== 'REJECTED') {
    rows.push(
      <ActionRow
        key="reject"
        title="Reddet"
        description="Teklif müşteri adına reddedilir ve hizmet verene “teklifiniz seçilmedi” e-postası gider."
        when="Müşteri teklifi istemediğini size ilettiğinde."
        testId="offer-action-reject"
      >
        <form action={updateOfferStatusAction}>
          <input type="hidden" name="id" value={offer.id} />
          <input type="hidden" name="status" value="REJECTED" />
          <ConfirmDialog
            triggerLabel="Reddet"
            triggerClassName="btn btn-destructive btn-sm"
            title="Teklif müşteri adına reddedilsin mi?"
            consequence={
              <>
                {isAccepted ? acceptedWarning : null}
                <p>
                  Teklif reddedilir ve hizmet verene “teklifiniz seçilmedi” e-postası gider. Harcanan kredi bu işlemle
                  iade edilmez.{refundBlockNote}
                </p>
              </>
            }
            confirmLabel="Evet, reddet"
            testId="offer-reject"
          />
        </form>
      </ActionRow>,
    );
  }

  if (rows.length === 0 && notes.length === 0) {
    return <p className="detail-muted-note">Bu teklif için bu hesapla yapılabilecek bir işlem yok.</p>;
  }

  return (
    <>
      {rows.length > 0 ? (
        <ul className="action-list" data-testid="offer-actions">
          {rows}
        </ul>
      ) : null}
      {notes.map((note) => (
        <p className="detail-muted-note" role="note" key={note} data-testid="offer-actions-note">
          {note}
        </p>
      ))}
    </>
  );
}

/* ---- "Neler oldu" -------------------------------------------------------- */

function OfferHistory({ offer }: { offer: Offer }) {
  const steps: Array<{ key: string; label: string; at: string | null; actor?: string; note?: string | null }> = [
    {
      key: 'submitted',
      label: offer.creditSpentTransactionId
        ? `Teklif gönderildi, ${offer.creditCost} kredi düşüldü`
        : 'Teklif gönderildi',
      at: offer.submittedAt,
      actor: offer.provider.businessName,
    },
    { key: 'viewed', label: 'Müşteri teklifi görüntüledi', at: offer.viewedAt, actor: offer.request.customerName },
    { key: 'accepted', label: 'Kabul edildi', at: offer.acceptedAt },
    { key: 'rejected', label: 'Reddedildi', at: offer.rejectedAt },
    { key: 'withdrawn', label: 'Geri çekildi', at: offer.withdrawnAt, actor: offer.provider.businessName },
    {
      key: 'refunded',
      label: 'Kredi iadesi yapıldı',
      at: offer.creditRefundedAt,
      note: offer.creditRefundReason,
    },
  ];

  const happened: TimelineItem[] = steps
    .filter((step): step is typeof step & { at: string } => Boolean(step.at))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map((step) => ({
      key: step.key,
      when: formatDateTime(step.at),
      dateTime: step.at,
      title: step.label,
      actor: step.actor,
      note: step.note ?? undefined,
    }));
  const pending = steps.filter((step) => !step.at).map((step) => step.label);

  return (
    <div data-testid="offer-history">
      <Timeline items={happened} />
      {pending.length > 0 ? (
        <p className="detail-muted-note offer-history-pending">Henüz olmayanlar: {pending.join(' · ')}</p>
      ) : null}
    </div>
  );
}
