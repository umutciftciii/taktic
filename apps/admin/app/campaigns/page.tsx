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
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { CampaignEngineNotice } from './engine-notice';
import { CampaignQuestions } from './campaign-questions';

/**
 * Campaigns (CMP-002 S1, S2B2): what has been defined, which version of it
 * runs, and what it has granted so far.
 *
 * Status, the running version and the cumulative counters come from the API
 * row; the engine notice above the table says whether anything can run at
 * all. Nothing on this screen changes a campaign or the engine switch.
 *
 * ADMIN-DESIGN-001 Faz 3E (design `campaigns`): the engine callout, the static
 * "three questions" card and the design's table — who it covers, what it
 * gives, how many times it paid out — with every column the old table had
 * (status, trigger, channel, credit, days, running and latest version,
 * redemptions, last change). The list is cursor-paged by the API, so the
 * footer says how many rows are on this page, not a total it does not have.
 */

export const dynamic = 'force-dynamic';

type CampaignsPageProps = {
  searchParams: Promise<{ cursor?: string }>;
};

const SCREEN_INFO =
  'Kampanya, belirli bir olayda koşulu sağlayan hizmet verene süreli promosyon kredisi veren kuraldır. Burada taslak yazılır ve sürümlenir; bir sürüm yalnız kampanya ayrıntısından, motor açıkken etkinleştirilir. Bu liste hiçbir kampanyayı ya da motoru değiştirmez.';

const COLUMNS: DataColumn[] = [
  { key: 'campaign', label: 'Kampanya' },
  { key: 'covers', label: 'Kimi kapsıyor' },
  { key: 'gives', label: 'Ne veriyor' },
  { key: 'redemptions', label: 'Hak ediş', align: 'end' },
  { key: 'versions', label: 'Sürüm' },
  { key: 'updated', label: 'Son değişiklik' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function CampaignsPage({ searchParams }: CampaignsPageProps) {
  const { can } = await requireAdmin('CAMPAIGNS_READ');
  const canWrite = can('CAMPAIGNS_WRITE');
  const params = await searchParams;
  const query = new URLSearchParams({ limit: '25' });
  if (params.cursor) query.set('cursor', params.cursor);

  const data = await apiFetch<CampaignListResponse>(`/admin/campaigns?${query.toString()}`);
  const running = data.items.filter((item) => item.status === 'ACTIVE').length;
  const subtitle =
    data.items.length === 0
      ? 'Henüz kampanya yok'
      : `Bu sayfada ${formatCount(data.items.length)} kampanya · ${running === 0 ? 'hiçbiri etkin değil' : `${formatCount(running)} etkin`}`;

  return (
    <main className="campaigns-page">
      <PageHeader
        title="Kampanyalar"
        subtitle={subtitle}
        info={SCREEN_INFO}
        actions={
          canWrite ? (
            <Link className="btn btn-primary" href="/campaigns/new" data-testid="campaign-new-link">
              Yeni kampanya yaz
            </Link>
          ) : undefined
        }
      />

      <div className="campaigns-stack">
        <CampaignEngineNotice
          engineEnabled={data.engineEnabled}
          queue={data.evaluationQueue}
          canOpenOperationsSettings={can('OPERATIONS_SETTINGS_READ')}
        />

        <CampaignQuestions />

        <section className="data-list-card" aria-labelledby="campaign-list-title">
          <header className="data-list-card-head">
            <h2 id="campaign-list-title">Kampanya listesi</h2>
            <p className="cell-muted">Ayrıntı, sürüm geçmişi ve yaşam döngüsü için kampanyayı açın.</p>
          </header>

          {data.items.length === 0 ? (
            <EmptyState
              className="campaigns-empty"
              title={params.cursor ? 'Bu sayfada kampanya yok' : 'Henüz kampanya yok'}
              description="İlk taslağı yazın. Bir kampanya ancak motor açıkken etkinleştirilebilir."
              action={
                params.cursor ? (
                  <Link className="btn btn-secondary btn-sm" href="/campaigns">
                    İlk sayfaya dön
                  </Link>
                ) : canWrite ? (
                  <Link className="btn btn-primary btn-sm" href="/campaigns/new">
                    Yeni kampanya yaz
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <DataTable caption="Kampanyalar" columns={COLUMNS} minWidth={1080} testId="campaigns-table">
              {data.items.map((item) => {
                // The running version describes an ACTIVE/PAUSED campaign; the latest stored one describes a draft.
                const shown = item.activeVersion ?? item.currentVersion;
                return (
                  <tr key={item.id} data-testid="campaign-row" data-campaign-key={item.key}>
                    <td>
                      <div className="cell-stack">
                        <Link className="cell-link" href={`/campaigns/${item.id}`}>
                          <strong className="cell-break">{item.name}</strong>
                        </Link>
                        <code className="cell-muted cell-break">{item.key}</code>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span>{shown ? (TRIGGER_LABELS[shown.trigger as CampaignTrigger] ?? shown.trigger) : '—'}</span>
                        <span className="cell-muted">
                          Kanal:{' '}
                          <span data-testid="campaign-row-channel" data-channel={shown?.channel ?? ''}>
                            {shown ? channelLabel(shown.channel) : '—'}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="cell-nowrap">
                      {shown ? `${formatCount(shown.benefitCredits)} kredi · ${formatCount(shown.benefitExpiresInDays)} gün geçerli` : '—'}
                    </td>
                    <td className="is-num">
                      <strong>{formatCount(item.redemptionCount)}</strong>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span>çalışan {item.activeVersion ? `v${item.activeVersion.versionNumber}` : '—'}</span>
                        <span className="cell-muted">son {item.currentVersion ? `v${item.currentVersion.versionNumber}` : '—'}</span>
                      </div>
                    </td>
                    <td className="cell-nowrap">{formatDateTime(item.updatedAt)}</td>
                    <td>
                      <span className={campaignStatusBadgeClass(item.status)} data-testid="campaign-row-status">
                        {campaignStatusLabel(item.status)}
                      </span>
                    </td>
                    <td className="col-actions">
                      <Link className="btn btn-secondary btn-sm" href={`/campaigns/${item.id}`} aria-label={`Aç: ${item.name}`}>
                        Aç
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}

          {data.items.length > 0 || params.cursor ? (
            <nav className="pagination" aria-label="Sayfalama">
              <p className="pagination-summary" data-testid="campaign-page-summary">
                {data.items.length === 0
                  ? 'Bu sayfada kampanya yok'
                  : `Bu sayfada ${formatCount(data.items.length)} kampanya`}
              </p>
              <div className="pagination-links">
                {params.cursor ? (
                  <Link className="btn btn-secondary btn-sm" href="/campaigns" data-testid="campaign-page-first">
                    İlk sayfa
                  </Link>
                ) : null}
                {data.nextCursor ? (
                  <Link
                    className="btn btn-secondary btn-sm is-next"
                    rel="next"
                    href={`/campaigns?cursor=${encodeURIComponent(data.nextCursor)}`}
                    data-testid="campaign-page-next"
                  >
                    Sonraki sayfa
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </section>
      </div>
    </main>
  );
}
