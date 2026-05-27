import { apiFetch, OfferCreditPackage, requireAdmin, formatPrice } from '../../lib/api';
import {
  createCreditPackageAction,
  updateCreditPackageAction,
  updateCreditPackageStatusAction,
} from './actions';

export default async function CreditPackagesPage() {
  await requireAdmin();
  const packages = await apiFetch<OfferCreditPackage[]>('/credit-packages?includeInactive=true');

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Kredi Paketleri</h1>
        <p className="page-subtitle">Mevcut paketleri düzenleyin veya yeni paket oluşturun.</p>
      </header>

      <div className="list-stack">
        {packages.map((creditPackage) => (
          <article className="list-card" key={creditPackage.id}>
            <div className="list-card-header">
              <div>
                <h2 className="list-card-title">{creditPackage.name}</h2>
                <p className="list-card-meta">
                  <span>Slug: <code style={{ fontSize: 12 }}>{creditPackage.slug}</code></span>
                  <span>{creditPackage.creditAmount} kredi</span>
                  <span>{formatPrice(creditPackage.priceAmount, creditPackage.currency)}</span>
                </p>
              </div>
              <div className="inline-actions">
                <span className={creditPackage.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                  {creditPackage.isActive ? 'Aktif' : 'Pasif'}
                </span>
              </div>
            </div>
            <form action={updateCreditPackageAction} className="form-card" style={{ maxWidth: 'none' }}>
              <input type="hidden" name="id" value={creditPackage.id} />
              <PackageFields creditPackage={creditPackage} />
              <div className="form-actions" style={{ borderTop: 0, paddingTop: 0 }}>
                <button className="btn btn-primary" type="submit">Paketi kaydet</button>
              </div>
            </form>
            <form action={updateCreditPackageStatusAction}>
              <input type="hidden" name="id" value={creditPackage.id} />
              <input type="hidden" name="isActive" value={String(!creditPackage.isActive)} />
              <button className={creditPackage.isActive ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'} type="submit">
                {creditPackage.isActive ? 'Pasifleştir' : 'Aktifleştir'}
              </button>
            </form>
          </article>
        ))}
      </div>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18 }}>Yeni Paket Oluştur</h2>
        <form action={createCreditPackageAction} className="form-card">
          <section className="form-section">
            <h2>Paket Bilgileri</h2>
            <PackageFields />
          </section>
          <div className="form-actions">
            <button className="btn btn-primary" type="submit">Paket Oluştur</button>
          </div>
        </form>
      </section>
    </main>
  );
}

function PackageFields({ creditPackage }: { creditPackage?: OfferCreditPackage }) {
  return (
    <>
      <div className="form-grid">
        <label className="form-row">
          <span>İsim</span>
          <input name="name" required defaultValue={creditPackage?.name ?? ''} />
        </label>
        <label className="form-row">
          <span>Slug</span>
          <input
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            defaultValue={creditPackage?.slug ?? ''}
          />
        </label>
        <label className="form-row">
          <span>Kredi</span>
          <input
            name="creditAmount"
            type="number"
            min="1"
            required
            defaultValue={creditPackage?.creditAmount ?? 1}
          />
        </label>
        <label className="form-row">
          <span>Fiyat</span>
          <input
            name="priceAmount"
            type="number"
            min="1"
            required
            defaultValue={creditPackage?.priceAmount ?? 1}
          />
        </label>
        <label className="form-row">
          <span>Para birimi</span>
          <input name="currency" defaultValue={creditPackage?.currency ?? 'TRY'} />
        </label>
        <label className="form-row">
          <span>Sıralama</span>
          <input
            name="sortOrder"
            type="number"
            min="0"
            defaultValue={creditPackage?.sortOrder ?? 0}
          />
        </label>
      </div>
      <label className="form-row">
        <span>Açıklama</span>
        <textarea name="description" defaultValue={creditPackage?.description ?? ''} />
      </label>
      <input type="hidden" name="isActive" value={String(creditPackage?.isActive ?? true)} />
    </>
  );
}
