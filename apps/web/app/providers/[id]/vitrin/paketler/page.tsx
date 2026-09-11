import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getCurrentUser,
  type ProviderProfile,
  type ShowcasePackage,
  type ShowcasePackageTerms,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import { SHOWCASE_ERROR_MESSAGES } from '../showcase-errors';
import { PackagePicker } from './package-picker';

type Props = {
  params: Promise<{ id: string }>;
  /** `card`: the vitrin card the bought right should return to. */
  searchParams: Promise<{ card?: string; error?: string }>;
};

/**
 * The shop: one screen, one choice, one button.
 *
 * With no sellable package or no terms in force there is no sale to make, and
 * the screen says so in one sentence rather than showing a form that cannot be
 * submitted.
 */
export default async function ShowcasePackagesPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { card, error } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/paketler`);
  }

  const [provider, creditBalance, packages, terms] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    readCreditBalance(id),
    apiFetch<{ packages: ShowcasePackage[] }>(`/providers/${id}/showcase/packages`)
      .then((body) => body.packages)
      .catch(() => [] as ShowcasePackage[]),
    // No terms means no sale can be made; the picker then shows nothing technical.
    apiFetch<ShowcasePackageTerms>(`/providers/${id}/showcase/packages/terms`).catch(() => null),
  ]);

  const unavailable = packages.length === 0 || terms === null;

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
        <span>Vitrin paketi</span>
      </nav>
      <header className="pdash-page-head">
        <span className="kicker">Vitrin</span>
        <h1 className="pdash-page-title">Vitrin paketi al</h1>
        <p className="pdash-page-sub">
          Ödeme tamamlanınca bir vitrin hakkı kazanırsınız; kartınızı bu hakla oluşturur, onaylandığında otomatik
          yayına girer.
        </p>
      </header>

      {error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[error] ?? 'Bu paket şu an satın alınamıyor.'}
        </div>
      ) : null}

      {unavailable ? (
        <div className="vitrin-empty" data-testid="showcase-package-unavailable">
          <p style={{ margin: 0 }}>Bu paket şu an satın alınamıyor.</p>
          <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/vitrin`}>Vitrin kartlarıma dön</Link>
        </div>
      ) : (
        <PackagePicker providerId={id} packages={packages} terms={terms} returnCard={card ?? null} />
      )}
    </ProviderShell>
  );
}
