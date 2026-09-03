import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  ProviderRequestDetail,
  RequestQualityBreakdownComponent,
  formatPrice,
  formatDate,
  formatDateTime,
  qualityLabel,
  qualityBreakdownLabel,
  statusLabel,
  urgencyLabel,
  UNVIEWED_OFFER_REFUND_NOTICE,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import {
  providerStatusBadgeClass,
  providerRefundBadgeClass,
  formatBudgetRange,
} from '../../../provider-ui';
import { createOfferAction } from './actions';

type ProviderRequestDetailPageProps = {
  params: Promise<{ id: string; requestId: string }>;
  searchParams: Promise<{ offerError?: string; shownCost?: string; currentCost?: string }>;
};

export default async function ProviderRequestDetailPage({
  params,
  searchParams,
}: ProviderRequestDetailPageProps) {
  const { id, requestId } = await params;
  const { offerError, shownCost, currentCost } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/requests/${requestId}`);
  }

  // A request that does not exist, is not open, is unverified while the phone
  // gate is on, or sits outside this provider's categories and service areas
  // all come back as one indistinguishable 404 — so a provider cannot probe for
  // requests it may not see, and none of those cases reaches the error boundary.
  const request = await fetchOrNotFound(() =>
    apiFetch<ProviderRequestDetail>(`/providers/${id}/requests/${requestId}`),
  );
  const creditBalance = request.providerCreditBalance ?? 0;
  // The cost comes from the request's category. When it is null the category is
  // inactive or unpriced, and offering is impossible.
  const offerCreditCost = request.offerCreditCost;
  const canOffer = request.canOffer;
  const hasEnoughCredit = offerCreditCost !== null && creditBalance >= offerCreditCost;
  // The detail payload already carries the balance for an approved provider;
  // the credits route is only consulted when it does not.
  const sidebarBalance = request.providerCreditBalance ?? (await readCreditBalance(id));

  return (
    <ProviderShell
      user={user}
      providerId={id}
      active="requests"
      creditBalance={sidebarBalance}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/requests`}>Uygun Talepler</Link>
        <span aria-hidden="true">/</span>
        <span>{request.category.name}</span>
      </nav>

      <div className="split">
        <div className="split-main">
          <div className="inline-actions" style={{ marginBottom: 12 }}>
            <span className="tag tag-accent">
              Kalite {request.qualityScore}/100 · {qualityLabel(request.qualityLabel)}
            </span>
            {request.urgency ? (
              <span className="tag tag-neutral">{urgencyLabel(request.urgency)}</span>
            ) : null}
          </div>

          <h1 className="pdash-page-title">
            {request.category.name}
            {request.district ? ` · ${request.district}` : ''}
          </h1>
          <p className="pdash-page-sub">
            {request.city}/{request.district}
            {request.neighborhood ? `/${request.neighborhood}` : ''} ·{' '}
            {formatDateTime(request.submittedAt)}
          </p>

          <hr className="hr" />

          <section className="pdash-detail-card" style={{ border: 0, padding: 0 }}>
            <h2>Müşteri açıklaması</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}>
              {request.description ?? 'Müşteri ek açıklama yazmadı.'}
            </p>
            {request.addressNote ? (
              <p className="pdash-card-sub">Adres notu: {request.addressNote}</p>
            ) : null}
          </section>

          {request.answers.length > 0 ? (
            <section className="pdash-table-card" style={{ marginTop: 24 }}>
              <div className="pdash-table-head">
                <h2>Kategori soruları</h2>
              </div>
              <div className="pdash-table-scroll">
                <table className="pdash-table">
                  <tbody>
                    {request.answers.map((answer) => (
                      <tr key={answer.id}>
                        <th scope="row" style={{ width: 200, borderBottom: '1px solid var(--color-divider)' }}>
                          {answer.questionLabel}
                        </th>
                        <td>{formatValue(answer.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="metric-strip" aria-label="Talep künyesi">
            <div className="metric-cell">
              <span className="metric-label">Bütçe</span>
              <span className="metric-value" style={{ fontSize: 20 }}>
                {formatBudgetRange(request.budgetMin, request.budgetMax, (n) => formatPrice(n))}
              </span>
            </div>
            <div className="metric-cell">
              <span className="metric-label">Tercih edilen tarih</span>
              <span className="metric-value" style={{ fontSize: 20 }}>
                {request.preferredDate ? formatDate(request.preferredDate) : '—'}
              </span>
            </div>
            <div className="metric-cell">
              <span className="metric-label">Yanıtlanan soru</span>
              <span className="metric-value" style={{ fontSize: 20 }}>
                {request.answers.length}
              </span>
            </div>
            <div className="metric-cell">
              <span className="metric-label">Teklif kredisi</span>
              <span className="metric-value" style={{ fontSize: 20 }}>
                {canOffer && offerCreditCost !== null ? offerCreditCost : '—'}
              </span>
            </div>
          </section>

          <section className="pdash-table-card">
            <div className="pdash-table-head">
              <h2>Kalite kırılımı</h2>
            </div>
            <div className="pdash-table-scroll">
              <table className="pdash-table">
                <thead>
                  <tr>
                    <th>Bileşen</th>
                    <th>Puan</th>
                    <th>Maks.</th>
                    <th>Geçti</th>
                  </tr>
                </thead>
                <tbody>{renderBreakdownRows(request.qualityScoreBreakdown)}</tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="split-rail" aria-label="Teklif">
          <section className="pdash-detail-card">
            <div className="pdash-card-head">
              <h2 style={{ border: 0, padding: 0 }}>Teklif Ver</h2>
              {canOffer && offerCreditCost !== null ? (
                <span className="tag tag-accent">{offerCreditCost} kredi</span>
              ) : null}
            </div>

            {canOffer && offerCreditCost !== null ? (
              <p className="pdash-card-sub">
                Bu teklif <strong data-testid="offer-credit-cost">{offerCreditCost}</strong> kredi
                kullanır. Bakiyen{' '}
                <strong data-testid="provider-credit-balance">{creditBalance}</strong>.
              </p>
            ) : (
              <p className="pdash-card-sub">
                Mevcut kredi: <strong>{creditBalance}</strong>
              </p>
            )}

            {offerError === 'costChanged' ? (
              <div className="pdash-notice pdash-notice-warn" role="alert">
                <span>
                  <strong>Teklif gönderilmedi, kredi düşülmedi.</strong> Bu kategorinin teklif
                  maliyeti siz formu doldururken güncellendi
                  {shownCost ? <> (gördüğünüz: {shownCost} kredi)</> : null}. Güncel maliyet{' '}
                  <strong>{currentCost ?? offerCreditCost}</strong> kredi. Devam etmek isterseniz
                  formu tekrar gönderin.
                </span>
              </div>
            ) : null}

            {offerError === 'priceUnset' ? (
              <div className="pdash-notice pdash-notice-error" role="alert">
                <span>
                  <strong>Teklif gönderilmedi, kredi düşülmedi.</strong> Bu kategori için teklif
                  kredisi tanımlı değil.
                </span>
              </div>
            ) : null}

            {offerError === 'categoryInactive' ? (
              <div className="pdash-notice pdash-notice-error" role="alert">
                <span>
                  <strong>Teklif gönderilmedi, kredi düşülmedi.</strong> Bu kategori pasif duruma
                  alındı; yeni teklif verilemez.
                </span>
              </div>
            ) : null}

            {!canOffer ? (
              <div className="pdash-notice pdash-notice-error">
                {request.offerBlockedReason === 'CATEGORY_INACTIVE'
                  ? 'Bu kategori pasif durumda. Bu talebe yeni teklif verilemez.'
                  : 'Bu kategori için teklif kredisi tanımlı değil. Teklif verilemez; yönetim ekibiyle iletişime geçin.'}
              </div>
            ) : null}

            {request.existingOffer ? (
              <>
                <dl className="cdash-meta-list">
                  <dt>Teklifin</dt>
                  <dd>
                    <strong>{formatPrice(request.existingOffer.priceAmount)}</strong>{' '}
                    <span className={providerStatusBadgeClass(request.existingOffer.status)}>
                      {statusLabel(request.existingOffer.status)}
                    </span>
                  </dd>
                  <dt>Gönderim</dt>
                  <dd>{formatDateTime(request.existingOffer.submittedAt)}</dd>
                  <dt>Kullanılan kredi</dt>
                  <dd>{request.existingOffer.creditCost}</dd>
                  <dt>Kredi iadesi</dt>
                  <dd>
                    {request.existingOffer.creditRefundedAt
                      ? `${formatDateTime(request.existingOffer.creditRefundedAt)} — ${
                          request.existingOffer.creditRefundReason ?? '-'
                        }`
                      : 'Yok'}
                  </dd>
                  {/* Omitted for an offer from before the policy: it has no
                      standing under this rule to report. */}
                  {request.existingOffer.refundEligibility.policyStatus ? (
                    <>
                      <dt>İade durumu</dt>
                      <dd>
                        <span
                          className={providerRefundBadgeClass(
                            request.existingOffer.refundEligibility.policyStatus,
                          )}
                        >
                          {request.existingOffer.refundEligibility.policyStatusLabel}
                        </span>
                      </dd>
                    </>
                  ) : null}
                </dl>

                <div className="pdash-notice">
                  Bu talebe daha önce teklif gönderdiniz. Aynı talebe yeniden teklif verilemez.
                </div>

                <div className="pdash-actions">
                  <Link
                    className="pdash-btn pdash-btn-primary"
                    href={`/providers/${id}/offers/${request.existingOffer.id}`}
                  >
                    Teklif Detayını Gör
                  </Link>
                  <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${id}/offers`}>
                    Tekliflerime Git
                  </Link>
                </div>
              </>
            ) : !canOffer ? null : (
              <form action={createOfferAction} className="pdash-form">
                <input type="hidden" name="providerId" value={id} />
                <input type="hidden" name="requestId" value={requestId} />
                {/*
                  The cost this page rendered. The API compares it for equality
                  against the live category price inside the offer transaction and
                  refuses the submit if they differ, so the provider is never
                  charged a price they did not see. It never sets the charge.
                */}
                <input type="hidden" name="expectedCreditCost" value={offerCreditCost ?? ''} />

                <label className="pdash-form-row">
                  <span>Teklif tutarı *</span>
                  <input
                    name="priceAmount"
                    type="number"
                    step="0.01"
                    min="1"
                    inputMode="decimal"
                    placeholder="Örn. 1500.00"
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontWeight: 800,
                      fontSize: 18,
                    }}
                    required
                  />
                  <small>Ondalıklı fiyat girebilirsiniz. Örn: 149,90 veya 1500.00 TRY.</small>
                </label>

                <div className="pdash-form-grid">
                  <label className="pdash-form-row">
                    <span>Para birimi</span>
                    <input name="currency" defaultValue="TRY" />
                  </label>
                  <label className="pdash-form-row">
                    <span>Tahmini başlangıç</span>
                    <input name="estimatedStartDate" type="date" />
                  </label>
                  <label className="pdash-form-row">
                    <span>Tahmini bitiş</span>
                    <input name="estimatedCompletionDate" type="date" />
                  </label>
                </div>

                <label className="pdash-form-row">
                  <span>Mesaj *</span>
                  <textarea name="message" required placeholder="Müşteriye iletmek istediğiniz açıklama" />
                </label>
                <label className="pdash-form-row">
                  <span>Garanti notu</span>
                  <textarea name="warrantyNote" />
                </label>
                <label className="pdash-form-row">
                  <span>İç not</span>
                  <textarea name="internalNote" placeholder="Müşteri görmez, sadece sizin notunuz" />
                </label>

                {offerCreditCost !== null ? (
                  <p
                    className="pdash-card-sub"
                    style={{ paddingTop: 12, borderTop: '1px solid var(--color-divider)' }}
                  >
                    Teklif sonrası bakiye: <strong>{creditBalance - offerCreditCost}</strong> kredi
                  </p>
                ) : null}

                {canOffer && !hasEnoughCredit ? (
                  <div className="pdash-notice pdash-notice-warn">
                    Teklif göndermek için {offerCreditCost} kredi gerekir; bakiyeniz {creditBalance}.
                  </div>
                ) : null}

                <button
                  className="pdash-btn pdash-btn-primary pdash-btn-block"
                  type="submit"
                  disabled={!canOffer || !hasEnoughCredit}
                >
                  Teklifi Gönder{offerCreditCost !== null ? ` · ${offerCreditCost} kredi` : ''}
                </button>

                <p className="pdash-card-sub">{UNVIEWED_OFFER_REFUND_NOTICE}</p>
              </form>
            )}
          </section>
        </aside>
      </div>
    </ProviderShell>
  );
}

function renderBreakdownRows(breakdown: Record<string, RequestQualityBreakdownComponent> | null) {
  if (!breakdown) {
    return (
      <tr>
        <td colSpan={4} className="muted">
          Kırılım kaydı yok.
        </td>
      </tr>
    );
  }

  return Object.entries(breakdown).map(([key, component]) => (
    <tr key={key}>
      <td>{qualityBreakdownLabel(key)}</td>
      <td>{component.points}</td>
      <td>{component.max}</td>
      <td>
        <span className={component.passed ? 'tag tag-ink' : 'tag tag-neutral'}>
          {component.passed ? 'Evet' : 'Hayır'}
        </span>
      </td>
    </tr>
  ));
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Evet' : 'Hayır';
  }

  if (value === null || value === undefined) {
    return '-';
  }

  return String(value);
}
