import Link from 'next/link';
import {
  apiFetch,
  campaignStatusBadgeClass,
  campaignStatusLabel,
  formatDateTime,
  requireAdmin,
  type CampaignListResponse,
} from '../../lib/api';
import { TRIGGER_LABELS, channelLabel, type CampaignTrigger } from '../../lib/campaign-rules';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { CampaignEngineNotice } from './engine-notice';

/**
 * Campaigns (CMP-002 S1, S2B2): what has been defined, which version of it
 * runs, and what it has granted so far.
 *
 * Status, the running version and the cumulative counters come from the API
 * row; the engine notice above the table says whether anything can run at
 * all. Nothing on this screen changes a campaign or the engine switch.
 */

export const dynamic = 'force-dynamic';

type CampaignsPageProps = {
  searchParams: Promise<{ cursor?: string }>;
};

export default async function CampaignsPage({ searchParams }: CampaignsPageProps) {
  const { can } = await requireAdmin('CAMPAIGNS_READ');
  const canWrite = can('CAMPAIGNS_WRITE');
  const params = await searchParams;
  const query = new URLSearchParams({ limit: '25' });
  if (params.cursor) query.set('cursor', params.cursor);

  const data = await apiFetch<CampaignListResponse>(`/admin/campaigns?${query.toString()}`);

  return (
    <main className="campaigns-page">
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Kampanyalar' }]}
        title="Kampanyalar"
        subtitle="Tetikleyici, koşul, fayda ve limitten oluşan kampanyalar; durum ve çalışan sürüm."
        actions={
          canWrite ? (
            <Link className="btn btn-primary btn-sm" href="/campaigns/new" data-testid="campaign-new-link">
              Yeni taslak
            </Link>
          ) : undefined
        }
      />

      <div style={{ marginBottom: 12 }}>
        <CampaignEngineNotice
          engineEnabled={data.engineEnabled}
          queue={data.evaluationQueue}
          canOpenOperationsSettings={can('OPERATIONS_SETTINGS_READ')}
        />
      </div>

      <div className="table-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Kampanya listesi</h2>
            <p className="table-header-sub">Ayrıntı, sürüm geçmişi ve yaşam döngüsü için kampanya adına tıklayın.</p>
          </div>
          <span className="admin-toolbar-summary">{data.items.length} kayıt</span>
        </div>

        {data.items.length === 0 ? (
          <div style={{ padding: 18 }}>
            <EmptyState
              className="campaigns-empty"
              title="Henüz kampanya yok"
              description="İlk taslağı oluşturun. Bir kampanya ancak motor açıkken etkinleştirilebilir."
              action={
                canWrite ? (
                  <Link className="btn btn-primary btn-sm" href="/campaigns/new">
                    Yeni taslak oluştur
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="campaigns-table">
              <thead>
                <tr>
                  <th>Kampanya</th>
                  <th>Durum</th>
                  <th>Tetikleyici</th>
                  <th>Kanal</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Gün</th>
                  <th className="col-num">Çalışan</th>
                  <th className="col-num">Son</th>
                  <th className="col-num">Hak ediş</th>
                  <th>Güncellenme</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  // The running version describes an ACTIVE/PAUSED campaign; the latest stored one describes a draft.
                  const shown = item.activeVersion ?? item.currentVersion;
                  return (
                  <tr key={item.id} data-testid="campaign-row" data-campaign-key={item.key}>
                    <td>
                      <Link href={`/campaigns/${item.id}`} >
                        {item.name}
                      </Link>
                      <div className="help-text" style={{ marginTop: 2 }}>
                        <code>{item.key}</code>
                      </div>
                    </td>
                    <td>
                      <span className={campaignStatusBadgeClass(item.status)} data-testid="campaign-row-status">{campaignStatusLabel(item.status)}</span>
                    </td>
                    <td>
                      {shown
                        ? (TRIGGER_LABELS[shown.trigger as CampaignTrigger] ?? shown.trigger)
                        : '—'}
                    </td>
                    <td data-testid="campaign-row-channel" data-channel={shown?.channel ?? ''}>
                      {shown ? channelLabel(shown.channel) : '—'}
                    </td>
                    <td className="col-num">{shown?.benefitCredits ?? '—'}</td>
                    <td className="col-num">{shown?.benefitExpiresInDays ?? '—'}</td>
                    <td className="col-num">{item.activeVersion ? `v${item.activeVersion.versionNumber}` : '—'}</td>
                    <td className="col-num">{item.currentVersion ? `v${item.currentVersion.versionNumber}` : '—'}</td>
                    <td className="col-num">{item.redemptionCount}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data.nextCursor ? (
          <div className="compact-actions" style={{ padding: '0 18px 18px' }}>
            <Link className="btn btn-secondary btn-sm" href={`/campaigns?cursor=${encodeURIComponent(data.nextCursor)}`}>
              Sonraki sayfa
            </Link>
          </div>
        ) : null}
      </div>
    </main>
  );
}
