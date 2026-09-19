import Link from 'next/link';
import {
  apiFetch,
  campaignStatusBadgeClass,
  campaignStatusLabel,
  formatDateTime,
  requireAdmin,
  type CampaignListResponse,
} from '../../lib/api';
import { TRIGGER_LABELS, type CampaignTrigger } from '../../lib/campaign-rules';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { CampaignEngineNotice } from './engine-notice';

/**
 * Campaign drafts (CMP-002 S1): what has been defined, and the fact that none
 * of it runs yet.
 *
 * Every row is DRAFT in this slice. The status column is rendered from the
 * API's value rather than hard-coded, so the day a campaign can be activated
 * the list already tells the truth — and until then the engine notice above
 * the table says, in as many words, that nothing here grants anything.
 */

export const dynamic = 'force-dynamic';

type CampaignsPageProps = {
  searchParams: Promise<{ cursor?: string }>;
};

export default async function CampaignsPage({ searchParams }: CampaignsPageProps) {
  await requireAdmin();
  const params = await searchParams;
  const query = new URLSearchParams({ limit: '25' });
  if (params.cursor) query.set('cursor', params.cursor);

  const data = await apiFetch<CampaignListResponse>(`/admin/campaigns?${query.toString()}`);

  return (
    <main className="campaigns-page">
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Kampanyalar' }]}
        title="Kampanyalar"
        subtitle="Tetikleyici, koşul, fayda ve limitten oluşan kampanya taslakları."
        actions={
          <Link className="btn btn-primary btn-sm" href="/campaigns/new" data-testid="campaign-new-link">
            Yeni taslak
          </Link>
        }
      />

      <div style={{ marginBottom: 12 }}>
        <CampaignEngineNotice engineEnabled={data.engineEnabled} />
      </div>

      <div className="table-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Taslak listesi</h2>
            <p className="table-header-sub">Ayrıntı ve sürüm geçmişi için kampanya adına tıklayın.</p>
          </div>
          <span className="admin-toolbar-summary">{data.items.length} kayıt</span>
        </div>

        {data.items.length === 0 ? (
          <div style={{ padding: 18 }}>
            <EmptyState
              className="campaigns-empty"
              title="Henüz kampanya taslağı yok"
              description="İlk taslağı oluşturun. Motor kapalı olduğu sürece taslaklar yalnızca saklanır."
              action={
                <Link className="btn btn-primary btn-sm" href="/campaigns/new">
                  Yeni taslak oluştur
                </Link>
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
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Gün</th>
                  <th className="col-num">Sürüm</th>
                  <th>Güncellenme</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
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
                      <span className={campaignStatusBadgeClass(item.status)}>{campaignStatusLabel(item.status)}</span>
                    </td>
                    <td>
                      {item.currentVersion
                        ? (TRIGGER_LABELS[item.currentVersion.trigger as CampaignTrigger] ?? item.currentVersion.trigger)
                        : '—'}
                    </td>
                    <td className="col-num">{item.currentVersion?.benefitCredits ?? '—'}</td>
                    <td className="col-num">{item.currentVersion?.benefitExpiresInDays ?? '—'}</td>
                    <td className="col-num">{item.currentVersion ? `v${item.currentVersion.versionNumber}` : '—'}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                  </tr>
                ))}
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
