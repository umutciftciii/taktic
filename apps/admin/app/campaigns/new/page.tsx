import { apiFetch, requireAdmin, type CampaignListResponse } from '../../../lib/api';
import { emptyForm } from '../../../lib/campaign-rules';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { CampaignDefinitionForm } from '../campaign-definition-form';
import { CampaignEngineNotice } from '../engine-notice';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  await requireAdmin();
  // Only for the badge: the list endpoint is the cheapest reader of the switch.
  const { engineEnabled } = await apiFetch<CampaignListResponse>('/admin/campaigns?limit=1');

  return (
    <main className="campaigns-page">
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Kampanyalar', href: '/campaigns' }, { label: 'Yeni taslak' }]}
        title="Yeni kampanya taslağı"
        subtitle="Katalogdan tetikleyici, koşul, fayda ve limit seçin; tanım kaydedilmeden önce doğrulanır."
      />

      <div style={{ marginBottom: 12 }}>
        <CampaignEngineNotice engineEnabled={engineEnabled} />
      </div>

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard title="Tanım" subtitle="Serbest metin yalnızca ad ve anahtardır; kural alanları katalogla sınırlıdır.">
            <CampaignDefinitionForm mode="create" initialForm={emptyForm()} />
          </SectionCard>
        </div>
        <aside className="admin-side-column">
          <div className="helper-card">
            <h4>Nasıl çalışır?</h4>
            <ul>
              <li>&ldquo;Doğrula&rdquo; tanımı API’ye gönderir, hiçbir şey kaydetmez.</li>
              <li>&ldquo;Taslağı kaydet&rdquo; kampanyayı ve 1. sürümü oluşturur.</li>
              <li>Her kayıt yeni, değiştirilemez bir sürümdür; eski sürüm silinmez.</li>
              <li>Uygunluk geçişi tetikleyicisi olgu kümesi ister; e-posta/telefon kanıtı onay olayında koşul olamaz.</li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
