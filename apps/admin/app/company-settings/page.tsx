import {
  apiFetch,
  COMPANY_SETTINGS_ISSUE_LABELS,
  CompanySettings,
  formatDateTime,
  requireAdmin,
} from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { saveCompanySettingsAction } from './actions';

/**
 * The company's public details, and nothing technical.
 *
 * These three values are the footer of every transactional e-mail the platform
 * sends. They used to live in the environment, which meant correcting a typo
 * needed a redeploy and a shell — and meant a real message once went out
 * telling a customer to write to a placeholder address. They are business
 * facts, so this is where they are maintained.
 *
 * What is deliberately absent is the other half. The transport, the API key and
 * the verified sender address stay in deployment configuration: they are
 * secrets or close to it, they are chosen once per environment, and a screen
 * that could display them would turn an admin session into a way to read them.
 * The panel below says which transport is in play only in the sense that it
 * warns when the footer is unpublishable — it cannot see or change it.
 */

export const dynamic = 'force-dynamic';

type CompanySettingsPageProps = {
  searchParams: Promise<{
    error?: string;
    ok?: string;
    legalName?: string;
    supportEmail?: string;
    postalAddress?: string;
  }>;
};

const OK_MESSAGES: Record<string, string> = {
  saved: 'Şirket ve e-posta ayarları kaydedildi. Bundan sonraki e-postalar bu bilgileri kullanır.',
};

export default async function CompanySettingsPage({ searchParams }: CompanySettingsPageProps) {
  await requireAdmin();

  const params = await searchParams;
  const errorMessage = (params.error ?? '').trim();
  const okMessage = params.ok ? (OK_MESSAGES[params.ok] ?? null) : null;

  const settings = await apiFetch<CompanySettings>('/company-settings');

  // A rejected save carries the operator's own values back in the query, so the
  // form re-hydrates with what they typed rather than with what is stored.
  const legalName = params.legalName ?? settings.legalName ?? '';
  const supportEmail = params.supportEmail ?? settings.supportEmail ?? '';
  const postalAddress = params.postalAddress ?? settings.postalAddress ?? '';

  return (
    <main>
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Şirket ve E-posta' }]}
        title="Şirket ve E-posta Ayarları"
        subtitle="Gönderilen tüm e-postaların altbilgisinde görünen şirket bilgileri."
      />

      {errorMessage ? (
        <div
          className="notice notice-error"
          role="alert"
          data-testid="company-settings-error"
          style={{ marginBottom: 12 }}
        >
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }}>
          {okMessage}
        </div>
      ) : null}

      {settings.issues.length > 0 ? (
        <div
          className="notice notice-warning"
          role="status"
          data-testid="company-settings-issues"
          style={{ marginBottom: 12 }}
        >
          <strong>Bu bilgilerle e-posta gönderilemez.</strong>
          <ul style={{ margin: '8px 0 0 18px' }}>
            {settings.issues.map((issue) => (
              <li key={issue}>{COMPANY_SETTINGS_ISSUE_LABELS[issue]}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          className="notice notice-success"
          role="status"
          data-testid="company-settings-complete"
          style={{ marginBottom: 12 }}
        >
          Şirket bilgileri eksiksiz. E-posta altbilgisi bu bilgilerle gönderilir.
        </div>
      )}

      <div className="admin-meta-pills">
        <span
          className={settings.configured ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}
        >
          {settings.configured ? 'Kayıtlı' : 'Henüz kaydedilmedi'}
        </span>
        {settings.updatedAt ? (
          <span className="meta-pill">güncellenme {formatDateTime(settings.updatedAt)}</span>
        ) : null}
        {settings.updatedBy?.name ? (
          <span className="meta-pill">son düzenleyen {settings.updatedBy.name}</span>
        ) : null}
      </div>

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Şirket bilgileri"
            subtitle="Yasal unvan ve destek adresi zorunludur; posta adresi isteğe bağlıdır ve boş bırakılırsa altbilgide o satır hiç görünmez."
          >
            <form
              action={saveCompanySettingsAction}
              className="compact-form"
              data-testid="company-settings-form"
            >
              <div className="compact-field-grid">
                <label className="field field-12">
                  <span>Yasal unvan *</span>
                  <input
                    name="legalName"
                    required
                    minLength={2}
                    maxLength={200}
                    defaultValue={legalName}
                    placeholder="Örn. Örnek Teknoloji Anonim Şirketi"
                  />
                </label>
                <label className="field field-12">
                  <span>Destek e-postası *</span>
                  <input
                    name="supportEmail"
                    type="email"
                    required
                    maxLength={254}
                    defaultValue={supportEmail}
                    placeholder="destek@sirketiniz.com.tr"
                  />
                  <small className="muted">
                    Müşterilerin yanıtlarını okuduğunuz adres. Gönderici adresinden bağımsızdır ve
                    bu ekran adresin size ait olduğunu doğrulamaz.
                  </small>
                </label>
                <label className="field field-12">
                  <span>Posta adresi</span>
                  <textarea
                    name="postalAddress"
                    maxLength={500}
                    rows={3}
                    defaultValue={postalAddress}
                    placeholder="İsteğe bağlı"
                  />
                </label>
              </div>
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button className="btn btn-primary" type="submit">
                  Kaydet
                </button>
              </div>
            </form>
          </SectionCard>
        </div>

        <div className="admin-side-column">
          <SectionCard title="Teknik ayarlar burada değildir">
            <p className="muted" style={{ margin: 0 }}>
              E-posta taşıyıcısı, API anahtarı, doğrulanmış gönderici adresi ve uygulamanın public
              adresi dağıtım yapılandırmasıdır. Bunlar sunucu ortam değişkenlerinde tutulur, bu
              ekranda görüntülenmez ve buradan değiştirilemez.
            </p>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
