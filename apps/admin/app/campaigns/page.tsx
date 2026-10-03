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
import { CursorPagination } from '../../components/pagination';
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
 * redemptions, last change). The list is cursor-paged by the API.
 *
 * ADMIN-BACKEND-TRUTH-002: the API now also sends the exact `total` and a
 * `previousCursor`, so the footer says "N kampanyanın bu sayfadaki M'si" and
 * offers Önceki as well as Sonraki — `?before=` reads the page before, the
 * cursor stays the canonical page key, and there is no offset.
 */

export const dynamic = 'force-dynamic';

type CampaignsPageProps = {
  searchParams: Promise<{ cursor?: string; before?: string }>;
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
  // One direction at a time; a hand-made URL carrying both reads forward.
  if (params.cursor) query.set('cursor', params.cursor);
  else if (params.before) query.set('before', params.before);
  const paged = Boolean(params.cursor || params.before);

  const data = await apiFetch<CampaignListResponse>(`/admin/campaigns?${query.toString()}`);
  const running = data.items.filter((item) => item.status === 'ACTIVE').length;
  const subtitle =
    data.total === 0
      ? 'Henüz kampanya yok'
      : `${formatCount(data.total)} kampanya · bu sayfada ${running === 0 ? 'etkin olan yok' : `${formatCount(running)} etkin`}`;

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
              title={paged || data.total > 0 ? 'Bu sayfada kampanya yok' : 'Henüz kampanya yok'}
              description="İlk taslağı yazın. Bir kampanya ancak motor açıkken etkinleştirilebilir."
              action={
                paged ? (
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

          {data.items.length > 0 || paged ? (
            <>
              <CursorPagination
                count={data.items.length}
                total={data.total}
                previousHref={data.previousCursor ? `/campaigns?before=${encodeURIComponent(data.previousCursor)}` : null}
                nextHref={data.nextCursor ? `/campaigns?cursor=${encodeURIComponent(data.nextCursor)}` : null}
                noun="kampanya"
                summaryTestId="campaign-page-summary"
              />
              {paged ? (
                <p className="pagination-first">
                  <Link className="btn btn-ghost btn-sm" href="/campaigns" data-testid="campaign-page-first">
                    İlk sayfa
                  </Link>
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
