import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, getAccountProfile, getCurrentUser } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { CustomerShell } from '../../requests/customer-shell';
import { updateAccountProfileAction } from '../actions';

const ROLE_LABELS: Record<string, string> = {
  CUSTOMER: 'Müşteri',
  PROVIDER: 'Hizmet veren',
  SUPER_ADMIN: 'Yönetici',
};

type AccountProfilePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AccountProfilePage({ searchParams }: AccountProfilePageProps) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?redirectTo=/account/profile');
  }
  if (user.role !== 'CUSTOMER') {
    redirect('/');
  }

  const [profile, provinces] = await Promise.all([
    getAccountProfile(),
    // The same canonical list the API validates a city against, so the form can
    // only offer province names a save will accept.
    loadProvinces(),
  ]);

  const params = await searchParams;
  const saved = readParam(params, 'saved') === '1';
  const errorMessage = readParam(params, 'error')
    ? readParam(params, 'errorMessage') || DEFAULT_ERROR
    : null;

  // The session payload is the fallback for the two fields it also carries, so
  // an API hiccup renders a form with what is known rather than an empty one.
  const name = profile?.name ?? user.name ?? '';
  const email = profile?.email ?? user.email ?? '';
  const phone = profile?.phone ?? user.phone ?? '';
  const city = profile?.city ?? '';
  const role = ROLE_LABELS[user.role] ?? user.role;
  const displayName = name.trim() || email || 'Hesabım';

  return (
    <CustomerShell user={user} active="settings">
      <header className="cdash-page-head">
        <span className="kicker">Hesap</span>
        <h1 className="cdash-page-title">Profil ve ayarlar</h1>
        <p className="cdash-page-sub">
          Hesabınıza kayıtlı bilgileri buradan güncelleyebilirsiniz. Bu bilgiler yeni talep
          oluştururken iletişim bilgisi olarak kullanılır.
        </p>
      </header>

      <div className="split">
        <div className="split-main">
          {/*
            Both notices are ordinary page content rather than a toast: the save
            redirects here, and somebody who looked away for a moment — or who
            is reading with a screen reader — should still find out what
            happened. `role="status"` announces it without stealing focus.
          */}
          {saved ? (
            <div className="notice" role="status" data-testid="account-profile-saved">
              <span>Profil bilgileriniz güncellendi.</span>
            </div>
          ) : null}

          {errorMessage ? (
            <div
              className="notice cdash-notice-error"
              role="alert"
              data-testid="account-profile-error"
            >
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <section className="cdash-detail-card" aria-labelledby="account-profile-heading">
            <h2 id="account-profile-heading">Kişisel bilgiler</h2>

            <form action={updateAccountProfileAction} className="cdash-account-form">
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Ad soyad *</span>
                  <input
                    className="field-control"
                    name="name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={120}
                    autoComplete="name"
                    defaultValue={name}
                  />
                </label>

                <label className="field">
                  <span className="field-label">Telefon *</span>
                  <input
                    className="field-control"
                    name="phone"
                    type="tel"
                    required
                    inputMode="tel"
                    autoComplete="tel"
                    defaultValue={phone}
                    aria-describedby="account-phone-help"
                    placeholder="0555 123 45 67"
                  />
                  <small className="help-text" id="account-phone-help">
                    Teklif veren hizmet verenler eşleştiğinizde bu numaradan size ulaşır.
                  </small>
                </label>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Şehir</span>
                  <select
                    className="sel"
                    name="city"
                    autoComplete="address-level1"
                    defaultValue={city}
                    aria-describedby="account-city-help"
                  >
                    {/*
                      An explicit empty option, and the only way to clear the
                      field. A city is not required by anything in the product,
                      so the form neither insists on one nor invents one — and
                      "Seçilmedi" says which of the two an empty box means.
                    */}
                    <option value="">Seçilmedi</option>
                    {provinces.map((province) => (
                      <option key={province.code} value={province.name}>
                        {province.name}
                      </option>
                    ))}
                  </select>
                  <small className="help-text" id="account-city-help">
                    Zorunlu değildir. Her talep kendi il ve ilçesini ayrıca sorar.
                  </small>
                </label>

                <label className="field">
                  <span className="field-label">E-posta</span>
                  {/*
                    Read-only rather than disabled: a disabled field posts
                    nothing, and the address is shown because it is part of the
                    account — changing it needs proof of the new mailbox, which
                    this screen does not ask for.
                  */}
                  <input
                    className="field-control"
                    name="emailDisplay"
                    type="email"
                    readOnly
                    value={email}
                    autoComplete="email"
                    aria-describedby="account-email-help"
                  />
                  <small className="help-text" id="account-email-help">
                    E-posta adresi bu ekrandan değiştirilemez.
                  </small>
                </label>
              </div>

              <div className="inline-actions">
                <button className="cdash-btn cdash-btn-primary" type="submit">
                  Bilgileri kaydet
                </button>
              </div>
            </form>
          </section>

          <section className="cdash-detail-card" aria-labelledby="account-security-heading">
            <h2 id="account-security-heading">Güvenlik</h2>
            <p className="cdash-page-sub" style={{ margin: 0 }}>
              Şifrenizi değiştirdiğinizde bu tarayıcıdaki oturumunuz açık kalır, diğer
              cihazlardaki oturumlar kapatılır.
            </p>
            <div className="inline-actions">
              <Link className="cdash-btn cdash-btn-secondary" href="/account/password">
                Şifre değiştir
              </Link>
            </div>
          </section>
        </div>

        <aside className="split-rail" aria-label="Hesap kartı">
          <div className="rail-panel">
            <span className="avatar-sq" style={{ width: 64, height: 64, fontSize: 20 }} aria-hidden="true">
              {initialsOf(displayName)}
            </span>
            <div>
              <div className="cdash-brand-title">{displayName}</div>
              <div className="cdash-brand-sub">{role}</div>
            </div>
          </div>

          <div className="rail-note">
            <strong>Veri ve gizlilik.</strong> İletişim bilgileriniz yalnızca bir teklifi kabul
            ettiğinizde, eşleştiğiniz hizmet verenle paylaşılır ve paylaşım kaydı tutulur.
          </div>
        </aside>
      </div>
    </CustomerShell>
  );
}

const DEFAULT_ERROR =
  'Bilgileriniz kaydedilemedi. Ad soyad ve telefon alanlarını kontrol edip tekrar deneyin.';

/**
 * The province list, or an empty one.
 *
 * A form that cannot reach the list still has to render: the name and telephone
 * number are the fields that matter most here, and refusing the whole screen
 * because a dropdown could not be filled would be the worse trade. The select
 * then offers only "Seçilmedi" and the city the account already has.
 */
async function loadProvinces(): Promise<ProvinceWithDistricts[]> {
  try {
    return await apiFetch<ProvinceWithDistricts[]>('/locations/provinces');
  } catch {
    return [];
  }
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function initialsOf(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'M';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'M';
}
