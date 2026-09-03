import {
  apiFetch,
  formatDateTime,
  OPERATIONS_SETTING_LABELS,
  OperationsSettings,
  requireAdmin,
} from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { saveOperationsSettingsAction } from './actions';

/**
 * The commercial terms an operator maintains, starting with the one this
 * platform makes to every provider: how long a customer has to open an offer
 * before the provider's credit comes back.
 *
 * The two things this screen is careful about are both about time.
 *
 * It changes the *next* offer, never one that exists. Every offer snapshots the
 * window it was sold under when it is created, and the refund worker reads that
 * snapshot — so an offer sold at 48 hours keeps 48 hours after this value moves
 * to 72, and moving it to 12 cannot pay one out early. The panel says so, in
 * those words, because an operator who believes otherwise would use this screen
 * to try to fix a past case.
 *
 * And it records who changed it. The audit list below is the platform's answer
 * to "what was the window on the third, and who set it?" — a question a
 * settings row that overwrites itself cannot answer.
 */

export const dynamic = 'force-dynamic';

type OperationsSettingsPageProps = {
  searchParams: Promise<{
    error?: string;
    ok?: string;
    unviewedOfferRefundWindowHours?: string;
  }>;
};

const OK_MESSAGES: Record<string, string> = {
  saved:
    'Operasyon ayarları kaydedildi. Yeni süre yalnızca bundan sonra oluşturulan teklifler için geçerlidir.',
};

export default async function OperationsSettingsPage({
  searchParams,
}: OperationsSettingsPageProps) {
  await requireAdmin();

  const params = await searchParams;
  const errorMessage = (params.error ?? '').trim();
  const okMessage = params.ok ? (OK_MESSAGES[params.ok] ?? null) : null;

  const settings = await apiFetch<OperationsSettings>('/operations-settings');

  // A rejected save carries the operator's own value back in the query, so the
  // form re-hydrates with what they typed rather than with what is stored.
  const windowHours =
    params.unviewedOfferRefundWindowHours ??
    String(settings.unviewedOfferRefundWindowHours);

  return (
    <main>
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Operasyon Ayarları' }]}
        title="Operasyon Ayarları"
        subtitle="Hizmet verenlere verilen ticari sözlerin yönetildiği yer."
      />

      {errorMessage ? (
        <div
          className="notice notice-error"
          role="alert"
          data-testid="operations-settings-error"
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

      <div className="admin-meta-pills">
        <span
          className={settings.configured ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}
        >
          {settings.configured
            ? 'Kayıtlı'
            : `Varsayılan (${settings.defaultUnviewedOfferRefundWindowHours} saat)`}
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
            title="Kredi iadesi"
            subtitle="Müşteri teklifi bu süre içinde görüntülemezse teklif kredisi otomatik olarak hizmet verene iade edilir."
          >
            <form
              action={saveOperationsSettingsAction}
              className="compact-form"
              data-testid="operations-settings-form"
            >
              <div className="compact-field-grid">
                <label className="field field-12">
                  <span>Görüntülenmeyen teklif için kredi iade süresi (saat) *</span>
                  <input
                    name="unviewedOfferRefundWindowHours"
                    type="number"
                    required
                    step={1}
                    min={settings.minUnviewedOfferRefundWindowHours}
                    max={settings.maxUnviewedOfferRefundWindowHours}
                    defaultValue={windowHours}
                  />
                  <small className="muted">
                    Yalnız tam saat girilebilir. En az{' '}
                    {settings.minUnviewedOfferRefundWindowHours}, en fazla{' '}
                    {settings.maxUnviewedOfferRefundWindowHours} saat. Varsayılan{' '}
                    {settings.defaultUnviewedOfferRefundWindowHours} saattir.
                  </small>
                </label>
              </div>
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button className="btn btn-primary" type="submit">
                  Kaydet
                </button>
              </div>
            </form>
          </SectionCard>

          <SectionCard
            title="Ayar değişiklikleri"
            subtitle="Her değişiklikte eski değer, yeni değer, işlemi yapan yönetici ve zaman kaydedilir."
          >
            {settings.recentChanges.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Henüz bir değişiklik kaydı yok.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="operations-settings-audit">
                  <thead>
                    <tr>
                      <th>Ayar</th>
                      <th>Eski</th>
                      <th>Yeni</th>
                      <th>Yönetici</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.recentChanges.map((change) => (
                      <tr key={change.id}>
                        <td>{OPERATIONS_SETTING_LABELS[change.setting] ?? change.setting}</td>
                        <td>
                          {change.previousValue ?? (
                            <span className="muted">
                              varsayılan ({settings.defaultUnviewedOfferRefundWindowHours})
                            </span>
                          )}
                        </td>
                        <td>{change.newValue}</td>
                        <td>{change.changedBy?.name ?? '-'}</td>
                        <td>{formatDateTime(change.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="admin-side-column">
          <SectionCard title="Yalnız yeni teklifleri etkiler">
            <p className="muted" style={{ margin: 0 }}>
              Her teklif, oluşturulduğu andaki iade süresini ve kesin iade zamanını kendi üzerinde
              saklar. İade işçisi bu kaydı okur, güncel ayarı değil. Bugün{' '}
              {settings.defaultUnviewedOfferRefundWindowHours} saatle oluşturulmuş bir teklif,
              yarın bu ayar değişse bile kendi süresini korur.
            </p>
          </SectionCard>

          <SectionCard title="Hizmet verene gösterilen metin">
            <p className="muted" style={{ margin: 0 }} data-testid="operations-settings-notice">
              {settings.unviewedOfferRefundNotice}
            </p>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
