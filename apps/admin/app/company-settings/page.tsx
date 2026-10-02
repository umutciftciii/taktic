import {
  apiFetch,
  COMPANY_SETTINGS_ISSUE_LABELS,
  CompanySettings,
  formatDateTime,
  getCompanySettingsHistory,
  requireAdmin,
} from '../../lib/api';
import { AUDIT_SINCE_NOTE, AuditTimeline } from '../../components/audit-timeline';
import { parsePage } from '../../lib/list-query';
import { DetailFormFooter } from '../../components/detail-form-footer';
import { CompanySettingsSubmit } from './company-settings-submit';
import { KeyValueList } from '../../components/key-value-list';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { saveCompanySettingsAction } from './actions';

/**
 * The company's public details, and nothing technical (#44, design `company`,
 * paket 2 `48-sirket-ve-eposta-bilgileri`, ADMIN-DESIGN-001 Faz 3G).
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
 *
 * The design's layout: the footer card with the completeness notice at its
 * top, the "Teknik ayarlar burada değil" card beside it with the last save and
 * who made it, and the save band under the fields. The band is the form's own
 * (Vazgeç resets, the save posts `saveCompanySettingsAction` unchanged), not
 * the sticky bar: a rejected save redirects with the typed values in the URL,
 * so the bar's "unsaved changes" state could not tell the truth after it.
 * Not drawn: the design's "faturalarda ve yasal metinlerde" (these values are
 * the e-mail footer only).
 *
 * "Son değişiklikler" (ADMIN-ACTION-AUDIT-001) is the field log behind the
 * form: each save that changed something, with only the fields it changed,
 * their old and new values, the operator and the moment.
 */

export const dynamic = 'force-dynamic';

type CompanySettingsPageProps = {
  searchParams: Promise<{
    error?: string;
    ok?: string;
    legalName?: string;
    supportEmail?: string;
    postalAddress?: string;
    gecmisSayfa?: string;
  }>;
};

const OK_MESSAGES: Record<string, string> = {
  saved: 'Şirket ve e-posta ayarları kaydedildi. Bundan sonraki e-postalar bu bilgileri kullanır.',
};

export default async function CompanySettingsPage({ searchParams }: CompanySettingsPageProps) {
  const { can } = await requireAdmin('COMPANY_SETTINGS_READ');
  // PUT /company-settings asks for COMPANY_SETTINGS_WRITE; a read-only role
  // sees the stored values as text instead of a form it cannot submit.
  const canWrite = can('COMPANY_SETTINGS_WRITE');

  const params = await searchParams;
  const errorMessage = (params.error ?? '').trim();
  const okMessage = params.ok ? (OK_MESSAGES[params.ok] ?? null) : null;

  const historyPage = parsePage(params.gecmisSayfa);
  const [settings, history] = await Promise.all([
    apiFetch<CompanySettings>('/company-settings'),
    getCompanySettingsHistory(historyPage),
  ]);

  // A rejected save carries the operator's own values back in the query, so the
  // form re-hydrates with what they typed rather than with what is stored.
  const legalName = params.legalName ?? settings.legalName ?? '';
  const supportEmail = params.supportEmail ?? settings.supportEmail ?? '';
  const postalAddress = params.postalAddress ?? settings.postalAddress ?? '';
  const lastSaveNote = settings.updatedAt
    ? `Son kayıt: ${formatDateTime(settings.updatedAt)}${settings.updatedBy?.name ? `, ${settings.updatedBy.name}` : ''}. Kayıt bundan sonra gönderilen e-postaları etkiler.`
    : 'Henüz kaydedilmedi. Kayıttan sonra gönderilen e-postalar bu bilgileri kullanır.';

  return (
    <main className="system-page company-settings-page">
      <PageHeader
        title="Şirket ve e-posta bilgileri"
        subtitle="Buradaki bilgiler müşterilere ve hizmet verenlere gönderilen e-postaların altbilgisinde görünür. Kaydettiğiniz andan sonra gönderilen tüm e-postalar yeni bilgiyle çıkar."
      />

      {errorMessage ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="company-settings-error">
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success detail-notice" role="status">
          {okMessage}
        </div>
      ) : null}

      <div className="admin-module-layout system-two-column">
        <div className="admin-main-column">
          <SectionCard
            title="E-posta altbilgisinde görünen bilgiler"
            className="detail-tab-card"
            testId="company-settings-card"
          >
            {settings.issues.length > 0 ? (
              <div className="notice notice-warning company-settings-status" role="status" data-testid="company-settings-issues">
                <strong>Bu bilgilerle e-posta gönderilemez.</strong>
                <ul>
                  {settings.issues.map((issue) => (
                    <li key={issue}>{COMPANY_SETTINGS_ISSUE_LABELS[issue]}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="notice notice-success company-settings-status" role="status" data-testid="company-settings-complete">
                Şirket bilgileri eksiksiz. E-posta altbilgisi bu bilgilerle gönderilir.
              </div>
            )}

            {canWrite ? (
              <form action={saveCompanySettingsAction} className="compact-form" data-testid="company-settings-form">
                <div className="compact-field-grid">
                  <label className="field field-12">
                    <span>
                      Yasal unvan <span className="field-tag">Zorunlu</span>
                    </span>
                    <input
                      name="legalName"
                      required
                      minLength={2}
                      maxLength={200}
                      defaultValue={legalName}
                      placeholder="Örn. Örnek Teknoloji Anonim Şirketi"
                    />
                    <span className="help-text">Gönderilen her e-postanın altbilgisinde bu isim görünür.</span>
                  </label>
                  <label className="field field-12">
                    <span>
                      Destek e-postası <span className="field-tag">Zorunlu</span>
                    </span>
                    <input
                      name="supportEmail"
                      type="email"
                      required
                      maxLength={254}
                      defaultValue={supportEmail}
                      placeholder="destek@sirketiniz.com.tr"
                    />
                    <span className="help-text">
                      Müşterilerin yanıtlarını okuduğunuz adres. Gönderici adresinden bağımsızdır ve bu ekran adresin
                      size ait olduğunu doğrulamaz.
                    </span>
                  </label>
                  <label className="field field-12">
                    <span>
                      Posta adresi <span className="field-tag">İsteğe bağlı</span>
                    </span>
                    <textarea
                      name="postalAddress"
                      maxLength={500}
                      rows={3}
                      defaultValue={postalAddress}
                      placeholder="İsteğe bağlı"
                    />
                    <span className="help-text">Boş bırakırsanız altbilgide o satır hiç görünmez.</span>
                  </label>
                </div>
                <DetailFormFooter note={lastSaveNote}>
                  <CompanySettingsSubmit
                    stored={{
                      legalName: settings.legalName,
                      supportEmail: settings.supportEmail,
                      postalAddress: settings.postalAddress,
                    }}
                  />
                </DetailFormFooter>
              </form>
            ) : (
              <div data-testid="company-settings-readonly">
                <KeyValueList
                  items={[
                    { label: 'Yasal unvan', value: settings.legalName || null },
                    { label: 'Destek e-postası', value: settings.supportEmail || null },
                    {
                      label: 'Posta adresi',
                      value: settings.postalAddress ? (
                        <span className="company-settings-address">{settings.postalAddress}</span>
                      ) : null,
                    },
                  ]}
                />
                <p className="detail-muted-note company-settings-readonly-note">
                  Bu bilgileri değiştirme yetkiniz yok; yalnız görüntüleyebilirsiniz.
                </p>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="admin-side-column">
          <SectionCard title="Teknik e-posta ayarları burada değil" className="detail-tab-card" testId="company-settings-technical">
            <p className="detail-muted-note">
              E-posta taşıyıcısı, API anahtarı, doğrulanmış gönderici adresi ve uygulamanın genel adresi dağıtım
              yapılandırmasıdır. Bunlar sunucu ortam değişkenlerinde tutulur, bu ekranda görüntülenmez ve buradan
              değiştirilemez — bir yönetici oturumu bu bilgileri okuyabilecek bir yer olmasın diye.
            </p>
            <KeyValueList
              items={[
                {
                  label: 'Durum',
                  value: (
                    <span className={settings.configured ? 'badge badge-good' : 'badge badge-muted'}>
                      {settings.configured ? 'Kayıtlı' : 'Henüz kaydedilmedi'}
                    </span>
                  ),
                },
                { label: 'Son kayıt', value: settings.updatedAt ? formatDateTime(settings.updatedAt) : null },
                { label: 'Son düzenleyen', value: settings.updatedBy?.name ?? null },
              ]}
            />
          </SectionCard>
        </div>
      </div>

      <AuditTimeline
        page={history}
        title="Son değişiklikler"
        meta="Değişen alan, eski ve yeni değer"
        empty="Kayıt tutulmaya başladığından beri bu bilgiler değiştirilmedi."
        footnote={`${AUDIT_SINCE_NOTE} Değer değiştirmeyen kayıtlar listelenmez.`}
        testId="company-settings-history"
        pager={{ path: '/company-settings', params: {}, pageParam: 'gecmisSayfa' }}
      />
    </main>
  );
}
