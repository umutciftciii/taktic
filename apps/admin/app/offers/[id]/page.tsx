import Link from 'next/link';
import {
  apiFetch,
  Offer,
  OfferStatus,
  RefundRecommendedAction,
  statusLabel,
  statusBadgeClass,
  refundActionLabel,
  refundActionBadgeClass,
  formatPrice,
  formatDate,
  formatDateTime,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';
import { refundOfferCreditAction, updateOfferStatusAction } from '../actions';

type StatTone = 'neutral' | 'success' | 'warning' | 'error';

/**
 * The three actions this screen can actually perform.
 *
 * It used to offer all eight states, because the endpoint behind it wrote
 * `status` directly. It no longer does: an admin action runs the same cascade a
 * customer action runs, and only accept, reject and shortlist have one. The
 * other five are refused by the API — VIEWED and WITHDRAWN because they record
 * something a customer or a provider did, the rest because nothing in the
 * product transitions an offer into them — so listing them here would only
 * invite an error screen.
 */
const statuses: OfferStatus[] = ['SHORTLISTED', 'ACCEPTED', 'REJECTED'];

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

function statusTone(status: OfferStatus): StatTone {
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
      return 'error';
    default:
      return 'neutral';
  }
}

function refundTone(action: RefundRecommendedAction): StatTone {
  return action === 'FULL_REFUND' ? 'success' : 'neutral';
}

type TimelineEvent = {
  key: string;
  label: string;
  at: string | null;
  emphasis?: boolean;
};

function buildTimeline(offer: Offer): TimelineEvent[] {
  return [
    { key: 'submitted', label: 'Gönderildi', at: offer.submittedAt, emphasis: true },
    { key: 'viewed', label: 'Müşteri görüntüledi', at: offer.viewedAt },
    { key: 'accepted', label: 'Kabul edildi', at: offer.acceptedAt, emphasis: true },
    { key: 'rejected', label: 'Reddedildi', at: offer.rejectedAt },
    { key: 'withdrawn', label: 'Geri çekildi', at: offer.withdrawnAt },
    { key: 'refunded', label: 'Kredi iadesi yapıldı', at: offer.creditRefundedAt, emphasis: true },
  ];
}

type OfferDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ refunded?: string; statusSaved?: string }>;
};

export default async function OfferDetailPage({ params, searchParams }: OfferDetailPageProps) {
  const { id } = await params;
  const search = (await searchParams) ?? {};
  const justRefunded = search.refunded === '1';
  const justStatusSaved = search.statusSaved === '1';

  const offer = await apiFetch<Offer>(`/offers/${id}`);

  const timeline = buildTimeline(offer);
  const customerName = offer.request.customerName;
  const customerPhone = offer.request.customerPhone;
  const customerEmail = offer.request.customerEmail;
  const customerLinkedAccount = offer.request.customer;
  const isRefunded = Boolean(offer.creditRefundedAt);
  const offerRef = offer.offerNumber ?? `#${offer.id.slice(-8)}`;
  const requestRef = offer.request.requestNumber ?? `#${offer.request.id.slice(-8)}`;

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Teklifler', href: '/offers' },
          { label: 'Detay' },
        ]}
        title={offer.provider.businessName}
        subtitle={
          <>
            <span className={statusBadgeClass(offer.status)}>{statusLabel(offer.status)}</span>{' '}
            <span className="muted">
              · <code>{offerRef}</code> · {formatPrice(offer.priceAmount, offer.currency)} ·{' '}
              {offer.request.category.name}
            </span>
          </>
        }
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href={`/requests/${offer.request.id}`}>
              Talebi aç
            </Link>
            <Link className="btn btn-secondary btn-sm" href={`/providers/${offer.provider.id}`}>
              Hizmet vereni aç
            </Link>
            <Link
              className="btn btn-ghost btn-sm"
              href={`/offers?requestId=${offer.request.id}`}
            >
              Bu talebin tüm teklifleri
            </Link>
          </>
        }
      />

      {justRefunded ? (
        <div className="notice-success" role="status" style={{ marginBottom: 14 }}>
          Manuel iade tamamlandı. Kredi hizmet verenin bakiyesine eklendi.
        </div>
      ) : null}
      {justStatusSaved ? (
        <div className="notice-success" role="status" style={{ marginBottom: 14 }}>
          Teklif durumu güncellendi.
        </div>
      ) : null}

      <section className="stat-grid">
        <StatCard label="Fiyat" value={formatPrice(offer.priceAmount, offer.currency)} />
        <StatCard label="Kredi maliyeti" value={offer.creditCost} />
        <StatCard
          label="Durum"
          value={statusLabel(offer.status)}
          tone={statusTone(offer.status)}
        />
        <StatCard
          label="İade uygunluğu"
          value={
            isRefunded
              ? 'İade tamamlandı'
              : refundActionLabel(offer.refundEligibility.recommendedAction)
          }
          tone={isRefunded ? 'success' : refundTone(offer.refundEligibility.recommendedAction)}
          hint={
            isRefunded
              ? offer.creditRefundedAt
                ? formatDateTime(offer.creditRefundedAt)
                : undefined
              : offer.refundEligibility.hoursSinceSubmitted !== null
                ? `${offer.refundEligibility.hoursSinceSubmitted} sa geçti`
                : undefined
          }
        />
      </section>

      <div className="detail-grid">
        <div className="stack">
          <SectionCard title="Teklif özeti">
            <dl className="meta-row">
              <dt>Teklif No</dt>
              <dd>
                <code>{offerRef}</code>
                {offer.offerNumber ? (
                  <details className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                    <summary>Teknik ID</summary>
                    <code style={{ fontSize: 11 }}>{offer.id}</code>
                  </details>
                ) : null}
              </dd>
              <dt>Fiyat</dt>
              <dd>
                <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
              </dd>
              <dt>Mesaj</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{offer.message}</dd>
              <dt>Garanti</dt>
              <dd className="muted">{offer.warrantyNote ?? '-'}</dd>
              <dt>İç not</dt>
              <dd className="muted">{offer.internalNote ?? '-'}</dd>
              <dt>Tahmini başlangıç</dt>
              <dd>{formatDate(offer.estimatedStartDate)}</dd>
              <dt>Tahmini bitiş</dt>
              <dd>{formatDate(offer.estimatedCompletionDate)}</dd>
            </dl>
          </SectionCard>

          <SectionCard title="Durum çizelgesi">
            <ol className="offer-timeline">
              {timeline.map((event) => {
                const className = [
                  'offer-timeline-item',
                  event.at ? 'is-done' : 'is-pending',
                  event.emphasis ? 'is-emphasis' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <li key={event.key} className={className}>
                    <span className="offer-timeline-dot" aria-hidden="true" />
                    <div className="offer-timeline-body">
                      <span className="offer-timeline-label">{event.label}</span>
                      <span className="offer-timeline-time">
                        {event.at ? formatDateTime(event.at) : '—'}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </SectionCard>

          <SectionCard title="Kredi ve İade">
            <dl className="meta-row">
              <dt>Kredi maliyeti</dt>
              <dd>{offer.creditCost}</dd>
              <dt>Harcama işlemi</dt>
              <dd>
                {offer.creditSpentTransactionId ? (
                  <code style={{ fontSize: 12 }}>{offer.creditSpentTransactionId}</code>
                ) : (
                  '-'
                )}
              </dd>
              <dt>İade işlemi</dt>
              <dd>
                {offer.creditRefundedTransactionId ? (
                  <code style={{ fontSize: 12 }}>{offer.creditRefundedTransactionId}</code>
                ) : (
                  '-'
                )}
              </dd>
              <dt>İade tarihi</dt>
              <dd>{offer.creditRefundedAt ? formatDateTime(offer.creditRefundedAt) : '-'}</dd>
              <dt>İade sebebi</dt>
              <dd className="muted">{offer.creditRefundReason ?? '-'}</dd>
              <dt>Uygunluk</dt>
              <dd>
                {isRefunded ? (
                  <span className="badge badge-good">İade tamamlandı</span>
                ) : (
                  <span
                    className={
                      offer.refundEligibility.eligible ? 'badge badge-good' : 'badge badge-muted'
                    }
                  >
                    {offer.refundEligibility.eligible ? 'Uygun' : 'Uygun değil'}
                  </span>
                )}
              </dd>
              <dt>Öneri</dt>
              <dd>
                {isRefunded ? (
                  <span className="badge badge-good">İade edildi</span>
                ) : (
                  <span
                    className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}
                  >
                    {refundActionLabel(offer.refundEligibility.recommendedAction)}
                  </span>
                )}
              </dd>
              <dt>Sebep kodu</dt>
              <dd>
                <code style={{ fontSize: 12 }}>{offer.refundEligibility.reasonCode}</code>
              </dd>
              <dt>Detay</dt>
              <dd className="muted">{offer.refundEligibility.details}</dd>
              <dt>Gönderim sonrası saat</dt>
              <dd>{offer.refundEligibility.hoursSinceSubmitted ?? '-'}</dd>
            </dl>
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <Link
                className="btn btn-ghost btn-sm"
                href={`/providers/${offer.provider.id}/credits`}
              >
                Hizmet veren kredi geçmişi
              </Link>
            </div>
          </SectionCard>
        </div>

        <div className="stack">
          <SectionCard title="Hizmet Veren">
            <dl className="meta-row">
              <dt>İşletme</dt>
              <dd>{offer.provider.businessName}</dd>
              <dt>Yetkili</dt>
              <dd>{offer.provider.contactName}</dd>
              <dt>Telefon</dt>
              <dd>
                {offer.provider.phone ? (
                  <a className="cell-link" href={`tel:${offer.provider.phone}`}>
                    {offer.provider.phone}
                  </a>
                ) : (
                  '-'
                )}
              </dd>
              <dt>E-posta</dt>
              <dd>
                {offer.provider.email ? (
                  <a className="cell-link" href={`mailto:${offer.provider.email}`}>
                    {offer.provider.email}
                  </a>
                ) : (
                  '-'
                )}
              </dd>
              <dt>Konum</dt>
              <dd>
                {offer.provider.city}/{offer.provider.district}
              </dd>
              <dt>Durum</dt>
              <dd>
                <span className={statusBadgeClass(offer.provider.status)}>
                  {statusLabel(offer.provider.status)}
                </span>
              </dd>
            </dl>
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <Link
                className="btn btn-ghost btn-sm"
                href={`/providers/${offer.provider.id}/credits`}
              >
                Kredi geçmişi
              </Link>
              <Link
                className="btn btn-ghost btn-sm"
                href={`/offers?providerId=${offer.provider.id}`}
              >
                Diğer teklifleri
              </Link>
            </div>
          </SectionCard>

          <SectionCard title="Talep ve Müşteri">
            <dl className="meta-row">
              <dt>Talep No</dt>
              <dd>
                <Link className="cell-link" href={`/requests/${offer.request.id}`}>
                  <code>{requestRef}</code>
                </Link>
              </dd>
              <dt>Kategori</dt>
              <dd>{offer.request.category.name}</dd>
              <dt>Konum</dt>
              <dd>
                {offer.request.city}/{offer.request.district}
                {offer.request.neighborhood ? ` · ${offer.request.neighborhood}` : ''}
              </dd>
              <dt>Talep durumu</dt>
              <dd>
                <span className={statusBadgeClass(offer.request.status)}>
                  {statusLabel(offer.request.status)}
                </span>
              </dd>
              <dt>Kalite</dt>
              <dd>{offer.request.qualityScore}/100</dd>
              <dt>Müşteri</dt>
              <dd>{customerName || '-'}</dd>
              <dt>Telefon</dt>
              <dd>
                {customerPhone ? (
                  <a className="cell-link" href={`tel:${customerPhone}`}>
                    {customerPhone}
                  </a>
                ) : (
                  '-'
                )}
              </dd>
              <dt>E-posta</dt>
              <dd>
                {customerEmail ? (
                  <a className="cell-link" href={`mailto:${customerEmail}`}>
                    {customerEmail}
                  </a>
                ) : (
                  '-'
                )}
              </dd>
              {customerLinkedAccount ? (
                <>
                  <dt>Kullanıcı hesabı</dt>
                  <dd className="muted">
                    {customerLinkedAccount.name ?? customerLinkedAccount.email ?? customerLinkedAccount.phone ?? customerLinkedAccount.id}
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="inline-actions" style={{ marginTop: 12 }}>
              <Link className="btn btn-ghost btn-sm" href={`/requests/${offer.request.id}`}>
                Talep detayı
              </Link>
            </div>
          </SectionCard>

          <SectionCard title="Durumu Güncelle">
            <form action={updateOfferStatusAction} style={{ display: 'grid', gap: 12 }}>
              <input type="hidden" name="id" value={offer.id} />
              <label className="form-row">
                <span>İşlem</span>
                {/*
                  Not defaulted to the offer's current status: the list is a set
                  of actions to take, and several offers are in a state that is
                  not one of them.
                */}
                <select name="status" defaultValue="SHORTLISTED">
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Bu işlem müşteri panelindeki işlemle aynı akışı çalıştırır: kabul, talebi
                eşleştirir ve diğer teklifleri kapatır; ilgili bildirim e-postaları gönderilir.
              </p>
              <div>
                <button className="btn btn-primary btn-block" type="submit">
                  Durumu Kaydet
                </button>
              </div>
            </form>
          </SectionCard>

          {/*
            Two things, kept apart on purpose.

            The card states where the offer stands under the automatic 48-hour
            policy — the promise providers are actually shown, which the worker
            keeps without being asked. Below it sits the operations refund: the
            remedy for cases the rule cannot see. It is not the policy, nothing
            provider- or customer-facing mentions it, and it files its own
            ledger reason so a report can always separate the two.
          */}
          <SectionCard title="Kredi İadesi">
            {offer.creditRefundedAt ? (
              <div className="notice-success">
                Bu teklifin kredi iadesi tamamlandı.{' '}
                <span className="muted">{formatDateTime(offer.creditRefundedAt)}</span>
                {offer.creditRefundReason ? (
                  <>
                    {' · '}
                    <code style={{ fontSize: 12 }}>{offer.creditRefundReason}</code>
                  </>
                ) : null}
              </div>
            ) : (
              <>
                {offer.refundEligibility.policyStatus ? (
                  <>
                    <p style={{ marginTop: 0 }}>
                      <span
                        className={refundActionBadgeClass(offer.refundEligibility.recommendedAction)}
                      >
                        {offer.refundEligibility.policyStatusLabel}
                      </span>
                    </p>
                    <p className="muted" style={{ fontSize: 13 }}>
                      {offer.refundEligibility.details}
                    </p>
                  </>
                ) : (
                  <div className="notice-warning">
                    Bu teklif, 48 saat iade kuralı yürürlüğe girmeden önce gönderildi ve bu kural
                    kapsamında değil.
                  </div>
                )}

                {offer.creditSpentTransactionId ? (
                  <form action={refundOfferCreditAction} style={{ display: 'grid', gap: 12 }}>
                    <input type="hidden" name="id" value={offer.id} />
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                      <strong>Manuel iade (operasyon).</strong> Standart iade politikası değildir ve
                      hizmet verene duyurulmaz. Yapılan işlem, işlemi yapan yönetici ve gerekçesiyle
                      birlikte kalıcı olarak kaydedilir.
                    </p>
                    <label className="form-row">
                      <span>Operasyon gerekçesi *</span>
                      <select name="reasonCode" defaultValue="INVALID_REQUEST">
                        {manualRefundReasons.map((reason) => (
                          <option key={reason.code} value={reason.code}>
                            {reason.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-row">
                      <span>Yönetici notu</span>
                      <textarea name="note" />
                    </label>
                    <div>
                      <button className="btn btn-danger btn-block" type="submit">
                        Krediyi manuel iade et
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="notice-warning">Bu teklifin kredi harcama işlemi yok.</div>
                )}
              </>
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
