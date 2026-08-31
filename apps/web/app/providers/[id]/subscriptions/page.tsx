import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  OfferPackageCatalogue,
  ProviderEntitlement,
  ProviderEntitlements,
  PurchasableOfferPackage,
  apiFetch,
  formatDateTime,
  formatPrice,
  getCurrentUser,
} from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import { createPackagePurchaseAction } from '../package-purchases/actions';
import { AutoRenewControls } from './auto-renew-controls';

type PageProps = { params: Promise<{ id: string }> };

const TYPE_LABEL: Record<string, string> = {
  ONE_TIME_CREDITS: 'Tek seferlik kredi',
  MONTHLY_QUOTA: 'Aylık kota',
  CATEGORY_UNLIMITED: 'Kategori limitsiz',
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Aktif',
  EXPIRED: 'Süresi doldu',
  PAST_DUE: 'Ödeme alınamadı',
  CANCELLED: 'İptal edildi',
};

/**
 * What a failed renewal is allowed to say to the provider.
 *
 * Neutral by design. The API returns a failure class, never the payment
 * provider's words, and this map keeps it that way: nothing here mentions a
 * card, and nothing repeats a decline message.
 */
const RENEWAL_FAILURE_LABEL: Record<string, string> = {
  PROVIDER_UNSUPPORTED: 'Otomatik yenileme bu kurulumda yapılamıyor.',
  PAYMENT_METHOD_MISSING: 'Kayıtlı bir ödeme yöntemi bulunamadı.',
  PAYMENT_DECLINED: 'Ödeme alınamadı.',
  PROVIDER_UNAVAILABLE: 'Ödeme sağlayıcısına ulaşılamadı.',
  PROVIDER_REJECTED: 'Ödeme işlemi tamamlanamadı.',
  PROVIDER_TIMEOUT: 'Ödeme işlemi zaman aşımına uğradı.',
  AUTO_RENEW_DISABLED: 'Otomatik yenileme kapalı.',
  ENTITLEMENT_NOT_RENEWABLE: 'Bu paket yenilenebilir değil.',
};

export default async function ProviderSubscriptionsPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/subscriptions`);
  }

  const [entitlements, catalogue] = await Promise.all([
    apiFetch<ProviderEntitlements>(`/providers/${id}/entitlements`),
    apiFetch<OfferPackageCatalogue>(`/providers/${id}/offer-packages`),
  ]);

  const active = entitlements.entitlements.filter((item) => item.usable || item.queued);
  const past = entitlements.entitlements.filter((item) => !item.usable && !item.queued);

  const oneTime = catalogue.packages.filter((item) => item.type === 'ONE_TIME_CREDITS');
  const quota = catalogue.packages.filter((item) => item.type === 'MONTHLY_QUOTA');
  const unlimited = catalogue.packages.filter((item) => item.type === 'CATEGORY_UNLIMITED');

  return (
    <ProviderShell user={user} providerId={id} active="subscriptions">
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Paketlerim</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Abonelikler</span>
        <h1 className="pdash-page-title">Paketlerim</h1>
        <p className="pdash-page-sub">
          Aylık kota ve kategori limitsiz paketleriniz satın alma anından itibaren{' '}
          <strong>{catalogue.periodDays} gün</strong> geçerlidir. Takvim ayı kullanılmaz ve
          kullanılmayan kota dönem sonunda devretmez.
        </p>
      </header>

      {!entitlements.autoRenew.available && entitlements.autoRenew.message ? (
        <div className="pdash-notice" data-testid="auto-renew-unavailable">
          <span>
            <strong>Otomatik yenileme kullanılamıyor:</strong> {entitlements.autoRenew.message}
          </span>
        </div>
      ) : null}

      <section aria-label="Aktif paketler">
        <div className="pdash-section-head">
          <h2 className="pdash-section-title">
            <span>Aktif paketlerim</span>
            <span className="pdash-section-count">{active.length}</span>
          </h2>
        </div>

        {active.length === 0 ? (
          <div className="pdash-empty" data-testid="no-active-entitlements">
            <h3>Aktif bir dönemsel paketiniz yok</h3>
            <p>
              Aşağıdan aylık kota veya kategori limitsiz paket alabilirsiniz. Paketiniz yokken
              teklifleriniz tek seferlik kredi bakiyenizden düşer.
            </p>
          </div>
        ) : (
          <div className="pkg-grid">
            {active.map((item) => (
              <EntitlementCard
                key={item.id}
                providerId={id}
                entitlement={item}
                autoRenewAvailable={entitlements.autoRenew.available}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Satın alınabilir paketler" id="satin-al" style={{ marginTop: 32 }}>
        <div className="pdash-section-head">
          <h2 className="pdash-section-title">
            <span>Paket satın al</span>
          </h2>
        </div>

        <PackageGroup
          providerId={id}
          title="Aylık kota paketleri"
          note={`Belirli sayıda teklif kredisi, satın alma anından itibaren ${catalogue.periodDays} gün geçerli. Kullanılmayan kota devretmez.`}
          packages={quota}
        />
        <PackageGroup
          providerId={id}
          title="Kategori limitsiz paketler"
          note={`Yalnızca aşağıda yazan kategorilerde geçerlidir ve ${catalogue.periodDays} gün sürer. Diğer kategorilerdeki teklifleriniz kredi bakiyenizden düşmeye devam eder.`}
          packages={unlimited}
        />
        <PackageGroup
          providerId={id}
          title="Tek seferlik kredi paketleri"
          note="Süresi dolmaz, kredi bakiyenize eklenir."
          packages={oneTime}
        />
      </section>

      {past.length > 0 ? (
        <section aria-label="Geçmiş paketler" style={{ marginTop: 32 }}>
          <div className="pdash-section-head">
            <h2 className="pdash-section-title">
              <span>Geçmiş paketler</span>
              <span className="pdash-section-count">{past.length}</span>
            </h2>
          </div>
          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Paket</th>
                  <th>Tür</th>
                  <th>Dönem</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {past.map((item) => (
                  <tr key={item.id}>
                    <td>{item.packageName}</td>
                    <td>{TYPE_LABEL[item.type] ?? item.type}</td>
                    <td className="muted">
                      {formatDateTime(item.startAt)} – {formatDateTime(item.endAt)}
                    </td>
                    <td>
                      <span className="tag tag-neutral">
                        {STATUS_LABEL[item.status] ?? item.status}
                      </span>
                      {item.lastRenewalFailureCode ? (
                        <div className="muted" style={{ marginTop: 4 }}>
                          {RENEWAL_FAILURE_LABEL[item.lastRenewalFailureCode] ??
                            'Yenileme tamamlanamadı.'}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </ProviderShell>
  );
}

function EntitlementCard({
  providerId,
  entitlement,
  autoRenewAvailable,
}: {
  providerId: string;
  entitlement: ProviderEntitlement;
  autoRenewAvailable: boolean;
}) {
  return (
    <article className="pkg-card" data-testid="entitlement-card">
      <div className="pkg-head">
        <span className="pkg-name">{entitlement.packageName}</span>
        <span className="pkg-head-tag">{TYPE_LABEL[entitlement.type] ?? entitlement.type}</span>
      </div>

      <div className="pkg-body">
        <span className="pkg-note">
          {formatDateTime(entitlement.startAt)} – {formatDateTime(entitlement.endAt)} (
          {entitlement.periodDays} gün)
        </span>

        {entitlement.queued ? (
          <span className="tag tag-neutral">
            Sıraya alındı — mevcut döneminiz bitince başlar
          </span>
        ) : null}

        {entitlement.type === 'MONTHLY_QUOTA' && entitlement.quotaTotal !== null ? (
          <>
            <span className="pkg-credits">
              {entitlement.quotaRemaining}
              <small>/ {entitlement.quotaTotal} kredi kaldı</small>
            </span>
            <span className="pkg-note">Kullanılmayan kota dönem sonunda devretmez.</span>
          </>
        ) : null}

        {entitlement.type === 'CATEGORY_UNLIMITED' ? (
          <>
            <span className="pkg-note">
              <strong>Yalnız seçili kategorilerde geçerli:</strong>{' '}
              {entitlement.scope.map((scope) => scope.name).join(', ') || '—'}
            </span>
            <span className="pkg-note">
              {entitlement.dailyOfferLimit === null
                ? 'Günlük teklif sınırı yok.'
                : `Günlük teklif sınırı: ${entitlement.dailyOfferLimit} (bugün ${entitlement.dailyOfferUsed ?? 0} kullanıldı).`}
            </span>
            <span className="pkg-note">
              Kapsam dışındaki kategorilerde teklifleriniz kredi bakiyenizden düşer.
            </span>
          </>
        ) : null}

        {entitlement.lastRenewalFailureCode ? (
          <span className="tag tag-neutral" data-testid="renewal-failure">
            {RENEWAL_FAILURE_LABEL[entitlement.lastRenewalFailureCode] ??
              'Yenileme tamamlanamadı.'}
          </span>
        ) : null}
      </div>

      <div className="pkg-foot">
        <AutoRenewControls
          providerId={providerId}
          entitlementId={entitlement.id}
          autoRenewEnabled={entitlement.autoRenewEnabled}
          autoRenewAvailable={autoRenewAvailable}
          cancelledAt={entitlement.cancelledAt}
        />
      </div>
    </article>
  );
}

function PackageGroup({
  providerId,
  title,
  note,
  packages,
}: {
  providerId: string;
  title: string;
  note: string;
  packages: PurchasableOfferPackage[];
}) {
  if (packages.length === 0) {
    return null;
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3 className="pdash-section-title" style={{ fontSize: 18 }}>
        {title}
      </h3>
      <p className="pdash-credit-note">{note}</p>

      <div className="pkg-grid">
        {packages.map((pkg) => (
          <article className="pkg-card" key={pkg.id} data-testid={`package-${pkg.type}`}>
            <div className="pkg-head">
              <span className="pkg-name">{pkg.name}</span>
              <span className="pkg-head-tag">{TYPE_LABEL[pkg.type] ?? pkg.type}</span>
            </div>

            <div className="pkg-body">
              {pkg.type === 'ONE_TIME_CREDITS' ? (
                <span className="pkg-credits">
                  {pkg.creditAmount}
                  <small>kredi</small>
                </span>
              ) : null}
              {pkg.type === 'MONTHLY_QUOTA' ? (
                <span className="pkg-credits">
                  {pkg.quotaCredits}
                  <small>kredi kota</small>
                </span>
              ) : null}
              {pkg.type === 'CATEGORY_UNLIMITED' ? (
                <span className="pkg-credits">
                  Limitsiz
                  <small>seçili kategorilerde</small>
                </span>
              ) : null}

              <span className="pkg-note">
                {pkg.type === 'ONE_TIME_CREDITS'
                  ? 'Süresiz — kredi bakiyenize eklenir.'
                  : `${pkg.periodDays ?? 30} gün geçerli`}
              </span>

              {pkg.type === 'CATEGORY_UNLIMITED' ? (
                <>
                  <span className="pkg-note">
                    <strong>Yalnız seçili kategorilerde geçerli:</strong>{' '}
                    {pkg.scope.map((scope) => scope.name).join(', ') || '—'}
                  </span>
                  <span className="pkg-note">
                    {pkg.dailyOfferLimit === null
                      ? 'Günlük teklif sınırı yok.'
                      : `Günlük teklif sınırı: ${pkg.dailyOfferLimit}`}
                  </span>
                </>
              ) : null}

              <div className="pkg-price-block">
                <span className="pkg-price">{formatPrice(pkg.priceAmount, pkg.currency)}</span>
              </div>

              {pkg.description ? <ul className="pkg-benefits"><li>{pkg.description}</li></ul> : null}
            </div>

            <div className="pkg-foot">
              {pkg.purchasable ? (
                <form action={createPackagePurchaseAction} className="pdash-form">
                  <input type="hidden" name="providerId" value={providerId} />
                  <input type="hidden" name="packageId" value={pkg.id} />
                  <button className="pdash-btn pdash-btn-primary pdash-btn-block" type="submit">
                    Test Ödemesiyle Satın Al
                  </button>
                </form>
              ) : (
                <span className="pkg-note" data-testid="package-unavailable">
                  {pkg.unavailableReason ?? 'Bu paket şu anda satın alınamıyor.'}
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
