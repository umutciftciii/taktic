import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  type PackagePurchase,
  type ProviderProfile,
} from '../../../../../../lib/api';
import { ProviderShell } from '../../../../provider-shell';
import { readCreditBalance } from '../../../../provider-data';

type Props = {
  params: Promise<{ id: string; purchaseId: string }>;
  /** `card`: the vitrin card the bought right should return to. */
  searchParams: Promise<{ checkout?: string; card?: string }>;
};

/**
 * Where the provider lands after paying. Reads the canonical status from the
 * API — never the query string — and says one of three things: the right is
 * ready, the payment is still open, or nothing was granted.
 */
export default async function ShowcasePaymentReturnPage({ params, searchParams }: Props) {
  const { id, purchaseId } = await params;
  const { card } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/odeme/${purchaseId}`);
  }

  const [provider, creditBalance, purchase] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    readCreditBalance(id),
    fetchOrNotFound(() => apiFetch<PackagePurchase>(`/providers/${id}/package-purchases/${purchaseId}`)),
  ]);

  // A credit package has its own screen after payment; this one is the vitrin's.
  if (purchase.kind !== 'SHOWCASE_PACKAGE') {
    redirect(`/providers/${id}/package-purchases/${purchaseId}`);
  }

  const cardQuery = card ? `card=${encodeURIComponent(card)}` : '';
  const cardHref = card ? `/providers/${id}/vitrin/${card}` : null;
  const createHref = `/providers/${id}/vitrin/yeni`;
  const packagesHref = `/providers/${id}/vitrin/paketler${cardQuery ? `?${cardQuery}` : ''}`;
  const continueHref =
    purchase.providerCheckoutUrl ??
    `/providers/${id}/package-purchases/${purchaseId}/checkout?return=vitrin${cardQuery ? `&${cardQuery}` : ''}`;

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase"
      creditBalance={creditBalance}
      status={provider.status}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link>
        <span aria-hidden="true">/</span>
        <span>Ödeme</span>
      </nav>

      {purchase.status === 'PAID' ? (
        <section className="vitrin-return" data-testid="showcase-payment-paid">
          <span className="kicker">{purchase.packageNameSnapshot}</span>
          <h1>Vitrin hakkınız hazır</h1>
          <p>
            {cardHref
              ? 'Hakkınızı bu karta bağlayıp yayına alabilirsiniz.'
              : 'Şimdi kartınızı oluşturun; incelemeden geçtiği an vitrinde yayına girer.'}
          </p>
          {cardHref ? (
            <Link className="pdash-btn pdash-btn-primary" href={cardHref}>Kartı yayınla</Link>
          ) : (
            <Link className="pdash-btn pdash-btn-primary" href={createHref} data-testid="showcase-create-after-payment">
              Şimdi kartınızı oluşturun
            </Link>
          )}
        </section>
      ) : purchase.status === 'PENDING' ? (
        <section className="vitrin-return" data-testid="showcase-payment-pending">
          <span className="kicker">{purchase.packageNameSnapshot}</span>
          <h1>Ödemeniz henüz tamamlanmadı</h1>
          <p>Ödeme sayfanız hâlâ açık. Tamamladığınızda vitrin hakkınız burada hazır olacak.</p>
          <div className="pdash-form-foot" style={{ padding: 0 }}>
            <Link className="pdash-btn pdash-btn-ghost" href={packagesHref}>Paket seçimine dön</Link>
            <a className="pdash-btn pdash-btn-primary" href={continueHref}>Ödemeye devam et</a>
          </div>
        </section>
      ) : (
        <section className="vitrin-return" data-testid="showcase-payment-failed">
          <span className="kicker">{purchase.packageNameSnapshot}</span>
          <h1>Ödeme tamamlanmadı</h1>
          <p>Bu işlem için vitrin hakkı oluşmadı ve ücret alınmadı. Dilerseniz yeniden paket seçebilirsiniz.</p>
          <Link className="pdash-btn pdash-btn-primary" href={packagesHref}>Paket seçimine dön</Link>
        </section>
      )}
    </ProviderShell>
  );
}
