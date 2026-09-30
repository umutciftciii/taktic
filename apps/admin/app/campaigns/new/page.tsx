import Link from 'next/link';
import { apiFetch, requireAdmin, type CampaignListResponse } from '../../../lib/api';
import { emptyForm } from '../../../lib/campaign-rules';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { CampaignDefinitionForm } from '../campaign-definition-form';
import { CampaignEngineNotice } from '../engine-notice';

export const dynamic = 'force-dynamic';

/**
 * A new campaign draft (CMP-002 S1).
 *
 * ADMIN-DESIGN-001 Faz 3E: the form template — a way back to the list, the
 * title with its ⓘ (what "Doğrula" and "Taslağı kaydet" do, which used to be
 * the side card), the engine callout, and the builder grouped by the design's
 * three questions. The builder itself posts exactly what it posted before.
 */
export default async function NewCampaignPage() {
  // The engine badge below is read from the list route (CAMPAIGNS_READ), so
  // the screen asks for both rather than redirecting halfway through.
  const { can } = await requireAdmin('CAMPAIGNS_WRITE', 'CAMPAIGNS_READ');
  // Only for the badge: the list endpoint is the cheapest reader of the switch.
  const { engineEnabled } = await apiFetch<CampaignListResponse>('/admin/campaigns?limit=1');

  return (
    <main className="campaigns-page campaign-form-page">
      <Link className="detail-back" href="/campaigns">
        <span aria-hidden="true">‹</span> Kampanyalar
      </Link>
      <PageHeader
        title="Yeni kampanya taslağı"
        subtitle="Katalogdan tetikleyici, koşul, fayda ve limit seçin; tanım kaydedilmeden önce doğrulanır."
        infoLabel="Taslak nasıl kaydedilir?"
        info={
          <span className="popover-list">
            <span>&ldquo;Doğrula&rdquo; tanımı API’ye gönderir, hiçbir şey kaydetmez.</span>
            <span>&ldquo;Taslağı kaydet&rdquo; kampanyayı ve 1. sürümü oluşturur.</span>
            <span>Her kayıt yeni, değiştirilemez bir sürümdür; eski sürüm silinmez.</span>
            <span>Uygunluk geçişi tetikleyicisi olgu kümesi ister; e-posta/telefon kanıtı onay olayında koşul olamaz.</span>
          </span>
        }
      />

      <div className="campaigns-stack">
        <CampaignEngineNotice engineEnabled={engineEnabled} canOpenOperationsSettings={can('OPERATIONS_SETTINGS_READ')} />

        <SectionCard title="Tanım" subtitle="Serbest metin yalnızca ad ve anahtardır; kural alanları katalogla sınırlıdır.">
          <CampaignDefinitionForm mode="create" initialForm={emptyForm()} />
        </SectionCard>
      </div>
    </main>
  );
}
