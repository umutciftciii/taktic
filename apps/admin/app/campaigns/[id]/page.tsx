import Link from 'next/link';
import {
  apiFetch,
  campaignEventStatusLabel,
  campaignRedemptionStatusLabel,
  campaignRevokeReasonLabel,
  campaignStatusBadgeClass,
  campaignStatusLabel,
  fetchOrNotFound,
  formatDateTime,
  promoLotStatusLabel,
  requireAdmin,
  type CampaignAuditEntry,
  type CampaignDetailResponse,
  type CampaignEvaluationEventPage,
  type CampaignRedemptionPage,
  type CampaignVersion,
} from '../../../lib/api';
import {
  ARGUMENT_LABELS,
  CONDITION_LABELS,
  ENUM_VALUE_LABELS,
  FACT_LABELS,
  SOURCE_CHANNEL_LABELS,
  STACK_POLICY_LABEL,
  TRIGGER_LABELS,
  adminDeductPolicyLabel,
  channelLabel,
  spendPriorityLabel,
  formFromDefinition,
  type CampaignConditionType,
  type CampaignFact,
  type CampaignTrigger,
} from '../../../lib/campaign-rules';
import { cursorSummary, formatCount } from '../../../lib/pagination';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailHeader } from '../../../components/detail-header';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { Timeline } from '../../../components/timeline';
import { CampaignDefinitionForm } from '../campaign-definition-form';
import { CampaignEngineNotice } from '../engine-notice';
import { CampaignLifecyclePanel } from '../lifecycle-panel';
import { RetryEventButton, RevokeRedemptionForm } from '../operations-panels';

/**
 * One campaign: the version the engine runs (if any), the latest stored
 * version, every version that came before, who did what, and the lifecycle
 * desk.
 *
 * The version history is the audit trail of the definition itself — each
 * row is a snapshot that was never edited — and the audit list beside it is
 * the trail of *actions*: creation, revision, activation, pause, resume, end.
 * The revision form at the bottom is pre-filled from the latest version and
 * produces the next one; it never touches a stored version, and it never
 * changes what runs — only activation moves `activeVersionId`.
 *
 * Below the versions sits the operations desk (CMP-003 S3): the campaign's
 * redemptions with their lot and revoke state, and the events its rule is a
 * candidate for with their queue state. Each is one page at a time
 * (`rcursor` / `ecursor`). A GRANTED redemption can be revoked with a
 * reason; a parked event can be put back in the worker's queue. Nothing on
 * this screen grants, deducts an arbitrary balance, or turns the engine on.
 *
 * ADMIN-DESIGN-001 Faz 3E: the shared detail template — the summary card and
 * strip (running and latest version, channel, redemptions, credit given),
 * the design's tables for versions, redemptions and events, and "Neler oldu"
 * as a timeline. Ending a campaign, closing a draft and revoking a redemption
 * now ask first (ConfirmDialog); every gate is the one the API route asks for.
 */

export const dynamic = 'force-dynamic';

type CampaignDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; v?: string; rcursor?: string; ecursor?: string }>;
};

const OPS_PAGE = 20;

const OK_MESSAGES: Record<string, string> = {
  created: 'Taslak oluşturuldu (sürüm 1). Etkinleştirilene kadar hiçbir olay değerlendirilmez.',
  revised: 'Yeni sürüm kaydedildi. Önceki sürümler değiştirilmedi; çalışan kural yalnız etkinleştirmeyle değişir.',
  activate: 'Sürüm etkinleştirildi. Kampanya bu sürümün kuralıyla değerlendiriliyor.',
  pause: 'Kampanya duraklatıldı. Yeni hak ediş üretilmez; mevcut promosyon lotları çalışmaya devam eder.',
  resume: 'Kampanya devam ettirildi.',
  end: 'Kampanya sonlandırıldı. Bu durum kalıcıdır.',
  close: 'Taslak kapatıldı. Kampanya hiç etkinleşmedi; hak ediş, promosyon kredisi veya olay oluşmadı. Bu durum kalıcıdır.',
  revoke: 'Hak ediş geri alındı: kullanılmamış promosyon kredisi cüzdandan düşüldü, harcanan kısım kayda geçti; borç oluşmaz.',
  retry: 'Olay kuyruğa alındı. Değerlendirme işçisi bir sonraki turda sahiplenir; bu ekran kendisi değerlendirme yapmaz.',
};

export default async function CampaignDetailPage({ params, searchParams }: CampaignDetailPageProps) {
  const { can } = await requireAdmin('CAMPAIGNS_READ');
  const canWrite = can('CAMPAIGNS_WRITE');
  const canLifecycle = can('CAMPAIGNS_LIFECYCLE');
  const canRevoke = can('CAMPAIGN_REDEMPTION_REVOKE');
  const canRetry = can('CAMPAIGN_EVENT_RETRY');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenOperationsSettings = can('OPERATIONS_SETTINGS_READ');
  const canOpenLedger = can('FINANCE_LEDGER_READ');
  const { id } = await params;
  const query = await searchParams;
  const base = `/admin/campaigns/${encodeURIComponent(id)}`;
  const pageQuery = (cursor: string | undefined) => `?limit=${OPS_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const [data, redemptions, events] = await Promise.all([
    fetchOrNotFound(() => apiFetch<CampaignDetailResponse>(base)),
    fetchOrNotFound(() => apiFetch<CampaignRedemptionPage>(`${base}/redemptions${pageQuery(query.rcursor)}`)),
    fetchOrNotFound(() => apiFetch<CampaignEvaluationEventPage>(`${base}/evaluation-events${pageQuery(query.ecursor)}`)),
  ]);
  const okMessage = query.ok ? (OK_MESSAGES[query.ok] ?? null) : null;
  const { campaign, currentVersion, activeVersion } = data;
  const canRevise = canWrite && campaign.status !== 'ENDED';
  const detailHref = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ rcursor: query.rcursor, ecursor: query.ecursor, ...params })) {
      if (value) search.set(key, value);
    }
    const encoded = search.toString();
    return `/campaigns/${campaign.id}${encoded ? `?${encoded}` : ''}`;
  };

  const shownVersion = activeVersion ?? currentVersion;
  const facts: SummaryItem[] = [
    {
      label: 'Çalışan sürüm',
      value: activeVersion ? `v${activeVersion.versionNumber}` : '—',
      note: activeVersion ? undefined : 'henüz etkinleşmedi',
      testId: 'campaign-fact-active',
    },
    { label: 'Son sürüm', value: currentVersion ? `v${currentVersion.versionNumber}` : '—' },
    { label: 'Kanal', value: shownVersion ? channelLabel(shownVersion.channel) : '—' },
    {
      label: 'Kredi kuralı',
      value: shownVersion ? spendPriorityLabel(shownVersion.spendPriority) : '—',
      note: shownVersion?.adminDeductPolicy ? `kesinti: ${adminDeductPolicyLabel(shownVersion.adminDeductPolicy).toLocaleLowerCase('tr')}` : undefined,
      testId: 'campaign-fact-credit-policy',
    },
    { label: 'Hak ediş', value: formatCount(campaign.redemptionCount), testId: 'campaign-fact-redemptions' },
    {
      label: 'Verilen kredi',
      value: formatCount(campaign.budgetConsumedCredits),
      note: activeVersion?.budgetCredits ? `bütçe ${formatCount(activeVersion.budgetCredits)}` : undefined,
    },
    { label: 'Son değişiklik', value: formatDateTime(campaign.updatedAt) },
  ];

  return (
    <main className="campaigns-page campaign-detail-page">
      <DetailHeader
        back={{ href: '/campaigns', label: 'Kampanyalar' }}
        badges={
          <span className={campaignStatusBadgeClass(campaign.status)} data-testid="campaign-status" data-status={campaign.status}>
            {campaignStatusLabel(campaign.status)}
          </span>
        }
        meta={
          <>
            <code className="cell-break">{campaign.key}</code> · oluşturan {campaign.createdBy.name ?? '—'} ·{' '}
            {formatDateTime(campaign.createdAt)}
          </>
        }
        title={campaign.name}
        subtitle={shownVersion ? (TRIGGER_LABELS[shownVersion.trigger as CampaignTrigger] ?? shownVersion.trigger) : undefined}
        facts={facts}
        factsLabel="Kampanya özeti"
        testId="campaign-header"
      />

      <div className="campaigns-stack">
        {okMessage ? (
          <div className="notice notice-success" role="status" data-testid="campaign-ok">
            {okMessage}
          </div>
        ) : null}

        <CampaignEngineNotice
          engineEnabled={data.engineEnabled}
          queue={data.evaluationQueue}
          canOpenOperationsSettings={canOpenOperationsSettings}
        />

        <div className="admin-module-layout campaign-detail-layout">
          <div className="admin-main-column">
            {activeVersion ? (
              <SectionCard
                title={`Çalışan kural — sürüm ${activeVersion.versionNumber}`}
                subtitle={`Motor bu sürümü değerlendirir. Hak ediş: ${campaign.redemptionCount} · verilen kredi: ${campaign.budgetConsumedCredits}${activeVersion.budgetCredits ? ` / ${activeVersion.budgetCredits}` : ''}.`}
              >
                <div data-testid="campaign-active-definition">
                  <VersionDefinition version={activeVersion} />
                </div>
              </SectionCard>
            ) : null}

            <SectionCard
              title={currentVersion ? `${activeVersion && currentVersion.id !== activeVersion.id ? 'Bekleyen revizyon' : 'Son kayıtlı tanım'} — sürüm ${currentVersion.versionNumber}` : 'Son kayıtlı tanım'}
              subtitle={
                activeVersion && currentVersion && currentVersion.id !== activeVersion.id
                  ? 'Kaydedildi ama çalışmıyor; çalışan kuralı değiştirmek için yaşam döngüsü panelinden etkinleştirin.'
                  : 'Kaydedilmiş tanım; değiştirmek için aşağıda yeni revizyon oluşturun.'
              }
            >
              {currentVersion ? <VersionDefinition version={currentVersion} /> : <p>Sürüm yok.</p>}
            </SectionCard>

            <SectionCard title="Sürüm geçmişi" subtitle="Her satır değiştirilemez bir anlık görüntüdür; en yeni üstte." padded={false}>
              <DataTable caption="Sürüm geçmişi" columns={VERSION_COLUMNS} minWidth={1420} testId="campaign-versions">
                {data.versions.map((version) => (
                  <tr key={version.id} data-testid="campaign-version-row" data-version={version.versionNumber} data-active={activeVersion?.id === version.id ? 'true' : 'false'}>
                    <td className="is-num cell-nowrap">
                      v{version.versionNumber}
                      {activeVersion?.id === version.id ? ' (çalışan)' : ''}
                      {currentVersion?.id === version.id ? ' (son)' : ''}
                    </td>
                    <td>{TRIGGER_LABELS[version.trigger as CampaignTrigger] ?? version.trigger}</td>
                    <td data-testid="campaign-version-channel" data-channel={version.channel}>
                      {channelLabel(version.channel)}
                    </td>
                    <td data-testid="campaign-version-spend-priority" data-value={version.spendPriority ?? ''}>
                      {spendPriorityLabel(version.spendPriority)}
                    </td>
                    <td data-testid="campaign-version-admin-deduct-policy" data-value={version.adminDeductPolicy ?? ''}>
                      {adminDeductPolicyLabel(version.adminDeductPolicy)}
                    </td>
                    <td className="is-num">{version.benefitCredits}</td>
                    <td className="is-num">{version.benefitExpiresInDays}</td>
                    <td className="is-num">{version.maxRedemptionsPerProvider}</td>
                    <td className="is-num">{version.maxRedemptionsGlobal ?? '—'}</td>
                    <td className="is-num">{version.maxRedemptionsPerDay ?? '—'}</td>
                    <td className="is-num">{version.budgetCredits ?? '—'}</td>
                    <td className="is-num">{version.maxRevokesPerDay ?? '—'}</td>
                    <td className="is-num">{version.priority}</td>
                    <td>{version.createdBy.name ?? '—'}</td>
                    <td className="cell-nowrap">{formatDateTime(version.createdAt)}</td>
                  </tr>
                ))}
              </DataTable>
            </SectionCard>

            {canRevise ? (
              <SectionCard title="Yeni revizyon" subtitle="Son sürümden başlar; kaydetmek yeni bir sürüm numarası üretir, çalışan kuralı değiştirmez.">
                {currentVersion ? (
                  <CampaignDefinitionForm
                    mode="revise"
                    campaignId={campaign.id}
                    campaignName={campaign.name}
                    revisingVersionNumber={currentVersion.versionNumber}
                    initialForm={formFromDefinition(currentVersion.definition)}
                  />
                ) : null}
              </SectionCard>
            ) : null}

            <SectionCard
              title="Hak edişler"
              subtitle="Bu kampanyanın verdiği promosyon lotları; en yeni üstte. Geri alma yalnız verilmiş bir hak edişi hedefler ve kullanılmamış krediyi düşer."
              padded={false}
            >
              {redemptions.items.length === 0 ? (
                <p className="campaign-ops-empty" data-testid="campaign-redemptions-empty">
                  Henüz hak ediş yok.
                </p>
              ) : (
                <DataTable caption="Hak edişler" columns={REDEMPTION_COLUMNS} minWidth={1100} testId="campaign-redemptions">
                  {redemptions.items.map((row) => (
                    <tr key={row.id} data-testid="campaign-redemption-row" data-redemption={row.id} data-status={row.status}>
                      <td>
                        <span className={redemptionBadgeClass(row.status)}>{campaignRedemptionStatusLabel(row.status)}</span>
                      </td>
                      <td className="campaign-ops-wrap">
                        {canOpenProvider ? (
                          <Link className="cell-link" href={`/providers/${row.provider.id}`}>
                            {row.provider.businessName}
                          </Link>
                        ) : (
                          row.provider.businessName
                        )}
                        <span className="campaign-ops-meta">{TRIGGER_LABELS[row.trigger as CampaignTrigger] ?? row.trigger}</span>
                      </td>
                      <td className="is-num">v{row.versionNumber}</td>
                      <td className="is-num">{row.grantedCredits}</td>
                      <td>
                        {row.lot ? (
                          <>
                            {promoLotStatusLabel(row.lot.status)}
                            {/* The unspent balance is the ledger's: drawn only when the API sent it (FINANCE_LEDGER_READ). */}
                            {row.lot.remainingCredits !== undefined ? ` · kalan ${row.lot.remainingCredits}` : null}
                            <span className="campaign-ops-meta">son kullanma {formatDateTime(row.lot.expiresAt)}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="cell-nowrap">{formatDateTime(row.grantedAt)}</td>
                      <td className="campaign-ops-wrap">
                        {row.status === 'REVOKED' ? (
                          <>
                            {campaignRevokeReasonLabel(row.revokeReason)} · düşülen {row.revokedCredits ?? 0} · harcanan {row.spentAtRevoke ?? 0}
                            <span className="campaign-ops-meta">
                              {row.revokedAt ? formatDateTime(row.revokedAt) : ''}
                              {row.revokedBy ? ` · ${row.revokedBy.name ?? '—'}` : row.revokedByWebhookEventId ? ' · ödeme sağlayıcısı' : ''}
                              {row.revokeNote ? ` · ${row.revokeNote}` : ''}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {canRevoke && row.status === 'GRANTED' ? (
                          <RevokeRedemptionForm
                            campaignId={campaign.id}
                            redemptionId={row.id}
                            providerName={row.provider.businessName}
                            grantedCredits={row.grantedCredits}
                            remainingCredits={row.lot?.remainingCredits ?? null}
                            revokeThreshold={activeVersion?.maxRevokesPerDay ?? null}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
              <Pager
                testId="campaign-redemptions-pager"
                count={redemptions.items.length}
                noun="hak ediş"
                first={query.rcursor ? detailHref({ rcursor: undefined }) : null}
                next={redemptions.nextCursor ? detailHref({ rcursor: redemptions.nextCursor }) : null}
              />
            </SectionCard>

            <SectionCard
              title="Değerlendirme kuyruğu"
              subtitle="Bu kampanyanın kuralına aday olan olaylar ve işçi kuyruğundaki durumları. “Kuyruğa al” yalnız bekleyen denemeyi öne çeker; değerlendirme işçide, ayrı bir işlemde yapılır."
              padded={false}
            >
              {events.items.length === 0 ? (
                <p className="campaign-ops-empty" data-testid="campaign-events-empty">
                  Bu kurala aday olay yok.
                </p>
              ) : (
                <DataTable caption="Değerlendirme kuyruğu" columns={EVENT_COLUMNS} minWidth={1100} testId="campaign-events">
                  {events.items.map((row) => (
                    <tr key={row.id} data-testid="campaign-event-row" data-event={row.id} data-status={row.status} data-retryable={row.retryable ? 'true' : 'false'}>
                      <td>
                        <span className={eventBadgeClass(row.status)}>{campaignEventStatusLabel(row.status)}</span>
                        {row.status === 'PROCESSING' && row.leaseUntil ? (
                          <span className="campaign-ops-meta">sahiplik {formatDateTime(row.leaseUntil)}{row.retryable ? ' (düştü)' : ''}</span>
                        ) : null}
                      </td>
                      <td className="campaign-ops-wrap">
                        <code className="cell-break">{row.triggerEventKey}</code>
                        <span className="campaign-ops-meta" data-testid="campaign-event-channel" data-channel={row.sourceChannel}>
                          kaynak kanal: {SOURCE_CHANNEL_LABELS[row.sourceChannel] ?? row.sourceChannel}
                        </span>
                        <span className="campaign-ops-meta">
                          ilk {formatDateTime(row.firstSeenAt)} · son {formatDateTime(row.lastSeenAt)}
                        </span>
                      </td>
                      <td className="is-num">
                        {row.attemptCount}
                        <span className="campaign-ops-meta">değerlendirme {row.evaluationCount}</span>
                      </td>
                      <td className="cell-nowrap">{row.status === 'PENDING' || row.status === 'RETRY_WAIT' ? formatDateTime(row.nextAttemptAt) : '—'}</td>
                      <td>
                        {row.lastErrorCode ? (
                          <>
                            <code>{row.lastErrorCode}</code>
                            {row.lastErrorAt ? <span className="campaign-ops-meta">{formatDateTime(row.lastErrorAt)}</span> : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="campaign-ops-wrap">
                        {row.settledByCampaignId === campaign.id ? (
                          <span className="badge badge-good">hak ediş verildi</span>
                        ) : row.lastOutcome ? (
                          <>
                            <code>{row.lastOutcome.outcome}</code>
                            {row.lastOutcome.reasonCode ? ` (${row.lastOutcome.reasonCode})` : ''}
                            <span className="campaign-ops-meta">{formatDateTime(row.lastOutcome.evaluatedAt)}</span>
                          </>
                        ) : row.settledByCampaignId ? (
                          <span className="badge badge-muted">başka kampanya kazandı</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {canRetry && row.retryable && data.engineEnabled ? (
                          <RetryEventButton campaignId={campaign.id} eventId={row.id} />
                        ) : canRetry && row.retryable ? (
                          <span className="campaign-ops-meta">motor kapalı — kuyruğa alınamaz</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
              <Pager
                testId="campaign-events-pager"
                count={events.items.length}
                noun="olay"
                first={query.ecursor ? detailHref({ ecursor: undefined }) : null}
                next={events.nextCursor ? detailHref({ ecursor: events.nextCursor }) : null}
              />
            </SectionCard>
          </div>

          <aside className="admin-side-column">
            <CampaignLifecyclePanel
              campaign={campaign}
              engineEnabled={data.engineEnabled}
              activeVersion={activeVersion}
              currentVersion={currentVersion}
              currentVersionChannel={data.currentVersionChannel}
              canLifecycle={canLifecycle}
            />

            <SectionCard title="Neler oldu" subtitle="Kim, ne zaman, hangi sürümü; en yeni üstte.">
              <div data-testid="campaign-audit">
                <Timeline
                  items={data.audit.map((entry) => ({
                    key: entry.id,
                    when: formatDateTime(entry.createdAt),
                    dateTime: entry.createdAt,
                    title: auditActionLabel(entry),
                    actor: auditActorLabel(entry),
                    note: auditDetails(entry) || undefined,
                  }))}
                  empty={<p className="detail-muted-note">Henüz kayıt yok.</p>}
                />
              </div>
            </SectionCard>

            <SectionCard title="Bu ekranda yapılamayanlar">
              <p className="detail-muted-note">
                Motor anahtarı bu ekrandan değiştirilemez; yalnız{' '}
                {canOpenOperationsSettings ? (
                  <Link href="/operations-settings#kampanya-motoru">Operasyon Ayarları</Link>
                ) : (
                  'Operasyon Ayarları'
                )}{' '}
                ekranından, açık onayla açılıp kapatılır. Hak edişler yalnız motor tarafından üretilir; promosyon satırları{' '}
                {canOpenLedger ? (
                  <Link href="/finance/credit-ledger?type=CAMPAIGN_GRANT">kredi hareketlerinde</Link>
                ) : (
                  'kredi hareketlerinde'
                )}{' '}
                kampanya adıyla görünür.
              </p>
            </SectionCard>
          </aside>
        </div>
      </div>
    </main>
  );
}

const VERSION_COLUMNS: DataColumn[] = [
  { key: 'version', label: 'Sürüm', align: 'end' },
  { key: 'trigger', label: 'Tetikleyici' },
  { key: 'channel', label: 'Kanal' },
  { key: 'spendPriority', label: 'Harcama önceliği' },
  { key: 'adminDeductPolicy', label: 'Yönetici kesintisi' },
  { key: 'credits', label: 'Kredi', align: 'end' },
  { key: 'days', label: 'Gün', align: 'end' },
  { key: 'perProvider', label: 'HV başına', align: 'end' },
  { key: 'global', label: 'Toplam', align: 'end' },
  { key: 'daily', label: 'Günlük', align: 'end' },
  { key: 'budget', label: 'Bütçe', align: 'end' },
  { key: 'revokes', label: 'Geri alma/gün', align: 'end' },
  { key: 'priority', label: 'Öncelik', align: 'end' },
  { key: 'by', label: 'Oluşturan' },
  { key: 'at', label: 'Tarih' },
];

const REDEMPTION_COLUMNS: DataColumn[] = [
  { key: 'status', label: 'Durum' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'version', label: 'Sürüm', align: 'end' },
  { key: 'credits', label: 'Kredi', align: 'end' },
  { key: 'lot', label: 'Lot' },
  { key: 'granted', label: 'Verildi' },
  { key: 'revoke', label: 'Geri alma' },
  { key: 'action', label: 'İşlem' },
];

const EVENT_COLUMNS: DataColumn[] = [
  { key: 'status', label: 'Durum' },
  { key: 'event', label: 'Olay' },
  { key: 'attempts', label: 'Deneme', align: 'end' },
  { key: 'next', label: 'Sonraki deneme' },
  { key: 'error', label: 'Son hata' },
  { key: 'outcome', label: 'Bu kampanya için' },
  { key: 'action', label: 'İşlem' },
];

/** The rest of an audit row after its title and actor, in the order the old list wrote it. */
function auditDetails(entry: CampaignAuditEntry): string {
  const parts: string[] = [];
  if (entry.summary?.versionNumber) {
    parts.push(
      `sürüm ${entry.summary.versionNumber}${entry.summary.previousActiveVersionNumber ? ` (önceki: sürüm ${entry.summary.previousActiveVersionNumber})` : ''}`,
    );
  }
  if ((entry.action === 'VERSION_CREATED' || entry.action === 'VERSION_ACTIVATED') && entry.summary) {
    parts.push(`kanal: ${channelLabel(entry.summary.channel)}`);
  }
  if (entry.summary?.changedFields && entry.summary.changedFields.length > 0) {
    parts.push(`değişen: ${entry.summary.changedFields.join(', ')}`);
  }
  if (entry.action === 'AUTO_PAUSED') {
    parts.push(`bugün ${entry.summary?.revokeCount ?? '?'} geri alma, eşik ${entry.summary?.maxRevokesPerDay ?? '?'}`);
  } else if (entry.summary?.reason) {
    parts.push(`gerekçe: ${entry.summary.reason}`);
  }
  if (entry.action === 'REDEMPTION_REVOKED' && entry.summary) {
    parts.push(`düşülen ${entry.summary.revokedCredits ?? 0}, harcanan ${entry.summary.spentAtRevoke ?? 0}`);
  }
  if (entry.action === 'EVENT_RETRY_REQUESTED' && entry.summary?.triggerEventKey) {
    parts.push(entry.summary.triggerEventKey);
  }
  return parts.join(' · ');
}

function auditActionLabel(entry: CampaignAuditEntry): string {
  switch (entry.action) {
    case 'AUTO_PAUSED':
      return 'Kampanya kendini duraklattı (geri alma eşiği)';
    case 'REDEMPTION_REVOKED':
      return 'Hak ediş geri alındı';
    case 'EVENT_RETRY_REQUESTED':
      return 'Olay kuyruğa alındı';
    case 'CREATED':
      return 'Kampanya oluşturuldu';
    case 'VERSION_CREATED':
      return 'Sürüm kaydedildi';
    case 'VERSION_ACTIVATED':
      return 'Sürüm etkinleştirildi';
    case 'ACTIVATED':
      return 'Kampanya etkinleştirildi';
    case 'PAUSED':
      return 'Kampanya duraklatıldı';
    case 'RESUMED':
      return 'Kampanya devam ettirildi';
    case 'ENDED':
      return entry.summary?.fromStatus === 'DRAFT' ? 'Taslak kapatıldı (hiç etkinleşmedi)' : 'Kampanya sonlandırıldı';
    default:
      return entry.action;
  }
}

/**
 * The actor line of an audit row: the person, or "Sistem" for the system's
 * own acts. Since CMP-004 S4 those rows carry no actor at all; the summary's
 * SYSTEM marker still decides for the rows S3 wrote against a nominal person.
 */
function auditActorLabel(entry: CampaignAuditEntry): string {
  if (entry.actor === null || entry.summary?.actorKind === 'SYSTEM') {
    return entry.summary?.source === 'PAYMENT_REVERSED' ? 'Sistem (ödeme iadesi)' : 'Sistem';
  }
  return entry.actor.name ?? '—';
}

function redemptionBadgeClass(status: string): string {
  return status === 'GRANTED' ? 'badge badge-good' : status === 'REVOKED' ? 'badge badge-warn' : 'badge badge-muted';
}

function eventBadgeClass(status: string): string {
  switch (status) {
    case 'SETTLED':
      return 'badge badge-good';
    case 'RETRY_WAIT':
      return 'badge badge-warn';
    case 'PROCESSING':
      return 'badge badge-info';
    default:
      return 'badge badge-muted';
  }
}

/**
 * One page of a cursor-paged desk table: how many rows are here, back to the
 * first page, and on to the next. The API has no "previous" cursor, so there
 * is none here either.
 */
function Pager({
  testId,
  count,
  noun,
  first,
  next,
}: {
  testId: string;
  count: number;
  noun: string;
  first: string | null;
  next: string | null;
}) {
  if (!first && !next) return null;
  return (
    <nav className="pagination" aria-label={`Sayfalama: ${noun}`} data-testid={testId}>
      <p className="pagination-summary">{cursorSummary(count, noun)}</p>
      <div className="pagination-links">
        {first ? (
          <Link className="btn btn-secondary btn-sm" href={first}>
            İlk sayfa
          </Link>
        ) : null}
        {next ? (
          <Link className="btn btn-secondary btn-sm is-next" rel="next" href={next}>
            Sonraki sayfa
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

/** A stored definition, read for a human — the same catalogue labels the builder uses. */
function VersionDefinition({ version }: { version: CampaignVersion }) {
  const form = formFromDefinition(version.definition);
  return (
    <dl className="campaign-summary" data-testid="campaign-current-definition">
      <dt>Tetikleyici</dt>
      <dd>{TRIGGER_LABELS[form.trigger] ?? form.trigger}</dd>
      <dt>Kanal</dt>
      <dd>
        <span className="badge badge-info" data-testid="campaign-definition-channel" data-channel={version.channel}>
          {channelLabel(version.channel)}
        </span>
      </dd>
      {form.facts.length > 0 ? (
        <>
          <dt>Olgu kümesi</dt>
          <dd>{form.facts.map((fact) => FACT_LABELS[fact as CampaignFact] ?? fact).join(' + ')}</dd>
        </>
      ) : null}
      <dt>Koşullar</dt>
      <dd>
        {form.conditions.length === 0 ? (
          'Yok — tetikleyici tek başına yeter'
        ) : (
          <ul className="campaign-condition-summary">
            {form.conditions.map((row) => (
              <li key={row.id}>
                <span className={`badge ${row.group === 'any' ? 'badge-warn' : 'badge-muted'}`}>
                  {row.group === 'any' ? 'alternatif' : 'zorunlu'}
                </span>{' '}
                {CONDITION_LABELS[row.type as CampaignConditionType] ?? row.type}
                {describeArguments(row.args)}
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt>Fayda</dt>
      <dd>
        {version.benefitCredits} promosyon kredisi, {version.benefitExpiresInDays} gün içinde kullanılmalı
      </dd>
      {version.spendPriority || version.adminDeductPolicy ? (
        <>
          <dt>Harcama önceliği</dt>
          <dd data-testid="campaign-definition-spend-priority" data-value={version.spendPriority ?? ''}>
            {spendPriorityLabel(version.spendPriority)}
          </dd>
          <dt>Yönetici kredi kesintisi</dt>
          <dd data-testid="campaign-definition-admin-deduct-policy" data-value={version.adminDeductPolicy ?? ''}>
            {adminDeductPolicyLabel(version.adminDeductPolicy)}
          </dd>
        </>
      ) : null}
      <dt>Limitler</dt>
      <dd>
        hizmet veren başına {version.maxRedemptionsPerProvider} · toplam {version.maxRedemptionsGlobal ?? 'sınırsız'} ·
        günlük {version.maxRedemptionsPerDay ?? 'sınırsız'} · bütçe {version.budgetCredits ?? 'sınırsız'} kredi ·
        günlük geri alma eşiği {version.maxRevokesPerDay ?? 'kapalı'}
      </dd>
      <dt>Pencere</dt>
      <dd>
        {version.windowStartAt ? formatDateTime(version.windowStartAt) : 'hemen'} →{' '}
        {version.windowEndAt ? formatDateTime(version.windowEndAt) : 'süresiz'}
      </dd>
      <dt>Öncelik / stack</dt>
      <dd>
        {version.priority} · {STACK_POLICY_LABEL}
      </dd>
    </dl>
  );
}

function describeArguments(args: Record<string, string | string[]>): string {
  const parts = Object.entries(args)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== ''))
    .map(([name, value]) => {
      const rendered = Array.isArray(value) ? value.map((v) => ENUM_VALUE_LABELS[v] ?? v).join(', ') : ENUM_VALUE_LABELS[value] ?? value;
      return `${ARGUMENT_LABELS[name] ?? name}: ${rendered}`;
    });
  return parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
}
