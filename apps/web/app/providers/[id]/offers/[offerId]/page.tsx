import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  getMatchedContactOrNull,
  MatchedCustomerContact,
  ProviderAcceptedWorkScope,
  ProviderOffer,
  refundActionLabel,
  formatDate,
  formatPrice,
  formatDateTime,
  urgencyLabel,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import {
  canOpenRequestDetail,
  canWithdrawOffer,
  formatBudgetRange,
  isWithdrawableOfferStatus,
  providerOfferStatusLabel,
  providerRefundBadgeClass,
  providerStatusBadgeClass,
} from '../../../provider-ui';
import { withdrawOfferAction } from './actions';

type ProviderOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
  searchParams?: Promise<{ withdrawError?: string }>;
};

export default async function ProviderOfferDetailPage({
  params,
  searchParams,
}: ProviderOfferDetailPageProps) {
  const { id, offerId } = await params;
  const { withdrawError } = (await searchParams) ?? {};
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/offers/${offerId}`);
  }

  const offer = await fetchOrNotFound(() =>
    apiFetch<ProviderOffer>(`/providers/${id}/offers/${offerId}`),
  );

  // Its own request, and the API answers it for exactly one provider: the one
  // whose offer this request was matched to. A losing offer gets null here, so
  // the section below never renders for it.
  const [matchedContact, creditBalance] = await Promise.all([
    getMatchedContactOrNull<MatchedCustomerContact>(
      `/providers/${id}/offers/${offerId}/matched-contact`,
    ),
    readCreditBalance(id),
  ]);

  const canWithdraw = canWithdrawOffer(offer.status, offer.request.status);
  // Still live, but on a request that no longer takes offers. Worth explaining;
  // a closed offer needs no explanation because its own status already is one.
  const withdrawBlockedByRequest = !canWithdraw && isWithdrawableOfferStatus(offer.status);
  // The provider panel's request screen is the discovery screen, and discovery
  // stops answering for a request that is no longer taking offers. Linking to
  // it anyway is what put a provider whose offer had just been accepted on a
  // 404 — the one moment they are most sure the job is theirs.
  const requestDetailOpens = canOpenRequestDetail(offer.request.status);
  // Served only for an offer the API itself sees as ACCEPTED, and only to the
  // provider that owns it. The screen renders what it was given; it does not
  // decide who may see a brief.
  const workScope = offer.acceptedWorkScope ?? null;

  return (
    <ProviderShell user={user} providerId={id} active="offers" creditBalance={creditBalance}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/offers`}>Tekliflerim</Link>
        <span aria-hidden="true">/</span>
        <span>Teklif Detayı</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Teklif</span>
        <h1 className="pdash-page-title">Teklif Detayı</h1>
        <p className="pdash-page-sub">
          {offer.request.category.name} · {offer.request.city}/{offer.request.district}
          <span style={{ marginLeft: 8 }}>
            <span className={providerStatusBadgeClass(offer.status)} data-testid="offer-status">
              {providerOfferStatusLabel(offer.status)}
            </span>
          </span>
        </p>
      </header>

      <div className="pdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card">
            <h2>Özet</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Fiyat</dt>
                <dd>
                  <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Durum</dt>
                <dd>
                  <span className={providerStatusBadgeClass(offer.status)}>{providerOfferStatusLabel(offer.status)}</span>
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Gönderim</dt>
                <dd>{formatDateTime(offer.submittedAt)}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Talep kategorisi</dt>
                <dd>{offer.request.category.name}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Talep konumu</dt>
                <dd>
                  {offer.request.city}/{offer.request.district}
                </dd>
              </div>
            </dl>
          </section>

          <section className="pdash-detail-card">
            <h2>Mesaj</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14, }}>
              {offer.message}
            </p>
            {offer.warrantyNote ? (
              <>
                <h3>Garanti notu</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14, }}>
                  {offer.warrantyNote}
                </p>
              </>
            ) : null}
            {offer.internalNote ? (
              <>
                <h3>İç not</h3>
                <p
                  style={{
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  {offer.internalNote}
                </p>
              </>
            ) : null}
          </section>

          {workScope ? (
            <WorkScopeCard offer={offer} workScope={workScope} />
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {matchedContact ? (
            <section className="pdash-detail-card" data-testid="matched-contact">
              <h2>Müşteri İletişim</h2>
              <p className="pdash-card-sub" style={{ marginTop: -4 }}>
                Teklifiniz kabul edildi. Müşteriye aşağıdaki bilgilerden ulaşabilirsiniz.
              </p>
              <dl className="pdash-info-grid">
                <div className="pdash-info-row">
                  <dt>Ad Soyad</dt>
                  <dd data-testid="matched-contact-name">{matchedContact.customer.customerName}</dd>
                </div>
                <div className="pdash-info-row">
                  <dt>Telefon</dt>
                  <dd>
                    <a
                      href={`tel:${matchedContact.customer.customerPhone}`}
                      data-testid="matched-contact-phone"
                    >
                      {matchedContact.customer.customerPhone}
                    </a>
                  </dd>
                </div>
                <div className="pdash-info-row">
                  <dt>E-posta</dt>
                  <dd>
                    {matchedContact.customer.customerEmail ? (
                      <a href={`mailto:${matchedContact.customer.customerEmail}`}>
                        {matchedContact.customer.customerEmail}
                      </a>
                    ) : (
                      '-'
                    )}
                  </dd>
                </div>
                <div className="pdash-info-row">
                  <dt>Paylaşım</dt>
                  <dd>{formatDateTime(matchedContact.revealedAt)}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          <section className="pdash-detail-card">
            <h2>Kredi ve İade</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Kullanılan kredi</dt>
                <dd>{offer.creditCost}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Harcama işlem</dt>
                <dd>{offer.creditSpentTransactionId ?? '-'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>İade tarihi</dt>
                <dd>
                  {offer.creditRefundedAt
                    ? `${formatDateTime(offer.creditRefundedAt)} — ${offer.creditRefundReason ?? '-'}`
                    : 'Yok'}
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Öneri</dt>
                <dd>
                  <span className={providerRefundBadgeClass(offer.refundEligibility.recommendedAction)}>
                    {refundActionLabel(offer.refundEligibility.recommendedAction)}
                  </span>
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Neden</dt>
                <dd>{offer.refundEligibility.reasonLabel}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Detay</dt>
                <dd style={{ color: 'var(--muted)', fontSize: 13 }}>{offer.refundEligibility.details}</dd>
              </div>
            </dl>
          </section>

          {withdrawError ? (
            <div className="pdash-notice pdash-notice-error" role="alert" data-testid="withdraw-error">
              {withdrawError === 'conflict'
                ? 'Bu teklif artık geri çekilemez. Güncel durumu yukarıda görebilirsiniz.'
                : 'Bu işlem için yetkiniz yok.'}
            </div>
          ) : null}

          {canWithdraw ? (
            <section className="pdash-detail-card" id="geri-cek">
              <h2>Teklifi Geri Çek</h2>
              <p className="pdash-card-sub" style={{ marginTop: -4 }}>
                Teklifinizi müşteriye kapatabilirsiniz.
              </p>
              {/*
                A two-step disclosure, not a one-click button: the action is
                irreversible and costs the provider the credit it already spent,
                so the consequences are on screen before the confirm exists.
              */}
              <details className="pdash-withdraw">
                <summary data-testid="withdraw-open">Teklifi geri çek</summary>
                <ul className="pdash-withdraw-list">
                  <li>Teklifiniz geri çekilecek.</li>
                  <li>Bu işlem geri alınamaz.</li>
                  <li>Kredi iadesi yapılmaz.</li>
                </ul>
                <form action={withdrawOfferAction}>
                  <input type="hidden" name="providerId" value={id} />
                  <input type="hidden" name="offerId" value={offer.id} />
                  <button
                    className="pdash-btn pdash-btn-danger pdash-btn-block"
                    type="submit"
                    data-testid="withdraw-confirm"
                  >
                    Evet, teklifi geri çek
                  </button>
                </form>
              </details>
            </section>
          ) : null}

          {withdrawBlockedByRequest ? (
            <div className="pdash-notice pdash-notice-warn">
              Bu talep artık teklif almıyor; teklifiniz geri çekilemez.
            </div>
          ) : null}

          {matchedContact ? null : (
            <div className="pdash-notice">
              Bu fazda müşteriyle iletişim ve ödeme akışı henüz aktif değildir.
            </div>
          )}

          {/*
            Only where there is nothing better to say. A won offer carries the
            brief further up this page, so telling its provider that a screen
            they no longer need will not open would be noise.
          */}
          {requestDetailOpens || workScope ? null : (
            <p className="pdash-card-sub" data-testid="request-detail-closed">
              Talep artık teklif almıyor; talep ekranı yalnız açık talepler için görüntülenir.
            </p>
          )}

          <div className="pdash-actions">
            {requestDetailOpens ? (
              <Link
                className="pdash-btn pdash-btn-secondary"
                href={`/providers/${id}/requests/${offer.request.id}`}
                data-testid="request-detail-link"
              >
                Talep Detayı
              </Link>
            ) : null}
            <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/offers`}>
              Tüm Tekliflerim
            </Link>
          </div>
        </div>
      </div>
    </ProviderShell>
  );
}

/**
 * What the job is, for the provider that won it.
 *
 * Every field here is one the platform already showed this provider while the
 * request was open — it is the same brief, kept reachable after the request
 * closed, not a new disclosure. What it deliberately does not carry is anyone's
 * name, telephone or e-mail, the address note, or the neighbourhood: whether a
 * provider may reach the customer, and where exactly, is the contact-sharing
 * flow's decision, made behind its own flag and its own disclosure and written
 * to its own audit row. The section above this one is where that answer
 * appears, when it has been given.
 *
 * The location is the city and district the offer itself already quoted.
 */
function WorkScopeCard({
  offer,
  workScope,
}: {
  offer: ProviderOffer;
  workScope: ProviderAcceptedWorkScope;
}) {
  return (
    <section className="pdash-detail-card" data-testid="work-scope">
      <h2>İş kapsamı</h2>
      <p className="pdash-card-sub" style={{ marginTop: -4 }}>
        Teklifiniz kabul edildi. İşin kapsamı, müşterinin talebinde bildirdiği şekliyle aşağıdadır.
      </p>

      <dl className="pdash-info-grid">
        <div className="pdash-info-row">
          <dt>Kategori</dt>
          <dd>{offer.request.category.name}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Konum</dt>
          <dd data-testid="work-scope-location">
            {offer.request.city}/{offer.request.district}
          </dd>
        </div>
        <div className="pdash-info-row">
          <dt>Tercih edilen tarih</dt>
          <dd>{offer.request.preferredDate ? formatDate(offer.request.preferredDate) : '-'}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Aciliyet</dt>
          <dd>{offer.request.urgency ? urgencyLabel(offer.request.urgency) : '-'}</dd>
        </div>
        {/* Only when the customer gave one: an absent budget is not a zero. */}
        {offer.request.budgetMin !== null || offer.request.budgetMax !== null ? (
          <div className="pdash-info-row">
            <dt>Bütçe</dt>
            <dd data-testid="work-scope-budget">
              {formatBudgetRange(offer.request.budgetMin, offer.request.budgetMax, (amount) =>
                formatPrice(amount),
              )}
            </dd>
          </div>
        ) : null}
      </dl>

      <h3>Müşterinin açıklaması</h3>
      <p
        style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}
        data-testid="work-scope-description"
      >
        {workScope.description?.trim() ? workScope.description : 'Müşteri açıklama yazmadı.'}
      </p>

      {workScope.requiredAnswers.length > 0 ? (
        <>
          <h3>Zorunlu kategori soruları</h3>
          <dl className="pdash-info-grid" data-testid="work-scope-answers">
            {workScope.requiredAnswers.map((answer) => (
              <div className="pdash-info-row" key={answer.questionKey}>
                <dt>{answer.questionLabel}</dt>
                <dd>{formatAnswerValue(answer.value)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </section>
  );
}

/** Mirrors the discovery screen's rendering, so one brief reads the same twice. */
function formatAnswerValue(value: unknown) {
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
