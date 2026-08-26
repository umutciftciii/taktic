import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, getCurrentUser, ProviderOffer } from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { OffersTable } from './offers-table';

type ProviderOffersPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderOffersPage({ params }: ProviderOffersPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/offers`);
  }

  const [offers, creditBalance] = await Promise.all([
    apiFetch<ProviderOffer[]>(`/providers/${id}/offers`),
    readCreditBalance(id),
  ]);

  /*
   * Counted from the provider's own offers — there is no summary endpoint, and
   * a rate is only shown once there is something to divide by.
   */
  const total = offers.length;
  const won = offers.filter((offer) => offer.status === 'ACCEPTED').length;
  const viewed = offers.filter((offer) => offer.viewedAt !== null).length;
  const refunded = offers.filter((offer) => offer.creditRefundedAt !== null).length;
  const pending = offers.filter(
    (offer) =>
      offer.status === 'SUBMITTED' || offer.status === 'VIEWED' || offer.status === 'SHORTLISTED',
  ).length;

  return (
    <ProviderShell
      user={user}
      providerId={id}
      active="offers"
      creditBalance={creditBalance}
      counts={{ offers: pending }}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Tekliflerim</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Teklif akışı</span>
        <h1 className="pdash-page-title">Tekliflerim</h1>
        <p className="pdash-page-sub">
          Gönderdiğiniz tüm teklifleri, durumlarını ve kredi hareketlerini buradan izleyin.
        </p>
      </header>

      <section className="metric-strip" aria-label="Teklif özetleri">
        <div className="metric-cell">
          <span className="metric-label">Gönderilen</span>
          <span className="metric-value">{total}</span>
          <span className="metric-hint">toplam teklif</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Kazanılan</span>
          <span className="metric-value">{won}</span>
          <span className="metric-hint">{total > 0 ? `%${percent(won, total)}` : 'henüz teklif yok'}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Görüntülenen</span>
          <span className="metric-value">{viewed}</span>
          <span className="metric-hint">
            {total > 0 ? `%${percent(viewed, total)}` : 'henüz teklif yok'}
          </span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">İade</span>
          <span className="metric-value">{refunded}</span>
          <span className="metric-hint">kredi iadesi yapılan teklif</span>
        </div>
      </section>

      {offers.length === 0 ? (
        <div className="pdash-empty">
          <h3>Henüz teklif vermediniz</h3>
          <p>Eşleşen talepleri inceleyip ilk teklifinizi gönderebilirsiniz.</p>
          <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/requests`}>
            Uygun Talepleri Gör
          </Link>
        </div>
      ) : (
        <OffersTable providerId={id} offers={offers} />
      )}

      <p className="pdash-page-footer">
        İade politikası: teklifini kendin geri çekersen kredi iadesi yapılmaz. Görüntülenmeyen veya
        geçersiz hale gelen taleplerde iade uygunluğu otomatik taranır ve sonucu her teklifin
        satırında görünür.
      </p>
    </ProviderShell>
  );
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 100);
}
