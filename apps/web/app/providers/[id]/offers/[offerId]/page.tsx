import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  ProviderOffer,
  refundActionLabel,
  formatPrice,
  formatDateTime,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import {
  canWithdrawOffer,
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

  const canWithdraw = canWithdrawOffer(offer.status, offer.request.status);
  // Still live, but on a request that no longer takes offers. Worth explaining;
  // a closed offer needs no explanation because its own status already is one.
  const withdrawBlockedByRequest = !canWithdraw && isWithdrawableOfferStatus(offer.status);

  return (
    <ProviderShell user={user} providerId={id} active="offers">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/offers`}>Tekliflerim</Link>
        <span aria-hidden="true">/</span>
        <span>Teklif Detayı</span>
      </p>

      <header className="pdash-page-head">
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
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
              {offer.message}
            </p>
            {offer.warrantyNote ? (
              <>
                <h3>Garanti notu</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14, color: 'var(--text-2)' }}>
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
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
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

          <div className="pdash-notice">
            Bu fazda müşteriyle iletişim ve ödeme akışı henüz aktif değildir.
          </div>

          <div className="pdash-actions">
            <Link
              className="pdash-btn pdash-btn-secondary"
              href={`/providers/${id}/requests/${offer.request.id}`}
            >
              Talep Detayı
            </Link>
            <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/offers`}>
              Tüm Tekliflerim
            </Link>
          </div>
        </div>
      </div>
    </ProviderShell>
  );
}
