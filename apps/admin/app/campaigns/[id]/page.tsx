import Link from 'next/link';
import {
  apiFetch,
  campaignStatusBadgeClass,
  campaignStatusLabel,
  fetchOrNotFound,
  formatDateTime,
  requireAdmin,
  type CampaignDetailResponse,
  type CampaignVersion,
} from '../../../lib/api';
import {
  ARGUMENT_LABELS,
  CONDITION_LABELS,
  ENUM_VALUE_LABELS,
  FACT_LABELS,
  STACK_POLICY_LABEL,
  TRIGGER_LABELS,
  formFromDefinition,
  type CampaignConditionType,
  type CampaignFact,
  type CampaignTrigger,
} from '../../../lib/campaign-rules';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { CampaignDefinitionForm } from '../campaign-definition-form';
import { CampaignEngineNotice } from '../engine-notice';
import { CampaignLifecyclePanel } from '../lifecycle-panel';

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
 */

export const dynamic = 'force-dynamic';

type CampaignDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; v?: string }>;
};

const OK_MESSAGES: Record<string, string> = {
  created: 'Taslak oluşturuldu (sürüm 1). Etkinleştirilene kadar hiçbir olay değerlendirilmez.',
  revised: 'Yeni sürüm kaydedildi. Önceki sürümler değiştirilmedi; çalışan kural yalnız etkinleştirmeyle değişir.',
  activate: 'Sürüm etkinleştirildi. Kampanya bu sürümün kuralıyla değerlendiriliyor.',
  pause: 'Kampanya duraklatıldı. Yeni hak ediş üretilmez; mevcut promosyon lotları çalışmaya devam eder.',
  resume: 'Kampanya devam ettirildi.',
  end: 'Kampanya sonlandırıldı. Bu durum kalıcıdır.',
};

export default async function CampaignDetailPage({ params, searchParams }: CampaignDetailPageProps) {
  await requireAdmin();
  const { id } = await params;
  const query = await searchParams;
  const data = await fetchOrNotFound(() =>
    apiFetch<CampaignDetailResponse>(`/admin/campaigns/${encodeURIComponent(id)}`),
  );
  const okMessage = query.ok ? (OK_MESSAGES[query.ok] ?? null) : null;
  const { campaign, currentVersion, activeVersion } = data;
  const canRevise = campaign.status !== 'ENDED';

  return (
    <main className="campaigns-page">
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Kampanyalar', href: '/campaigns' }, { label: campaign.name }]}
        title={campaign.name}
        subtitle={
          <>
            <code>{campaign.key}</code> · oluşturan {campaign.createdBy.name ?? '—'} · {formatDateTime(campaign.createdAt)}
          </>
        }
        actions={
          <span className={campaignStatusBadgeClass(campaign.status)} data-testid="campaign-status" data-status={campaign.status}>
            {campaignStatusLabel(campaign.status)}
          </span>
        }
      />

      {okMessage ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }} data-testid="campaign-ok">
          {okMessage}
        </div>
      ) : null}

      <div style={{ marginBottom: 12 }}>
        <CampaignEngineNotice engineEnabled={data.engineEnabled} />
      </div>

      <div className="admin-module-layout">
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
                ? 'Kaydedildi ama çalışmıyor; çalışan kuralı değiştirmek için sağdaki panelden etkinleştirin.'
                : 'Kaydedilmiş tanım; değiştirmek için aşağıda yeni revizyon oluşturun.'
            }
          >
            {currentVersion ? <VersionDefinition version={currentVersion} /> : <p>Sürüm yok.</p>}
          </SectionCard>

          <SectionCard title="Sürüm geçmişi" subtitle="Her satır değiştirilemez bir anlık görüntüdür; en yeni üstte.">
            <div className="table-scroll">
              <table className="data-table" data-testid="campaign-versions">
                <thead>
                  <tr>
                    <th className="col-num">Sürüm</th>
                    <th>Tetikleyici</th>
                    <th className="col-num">Kredi</th>
                    <th className="col-num">Gün</th>
                    <th className="col-num">HV başına</th>
                    <th className="col-num">Toplam</th>
                    <th className="col-num">Günlük</th>
                    <th className="col-num">Bütçe</th>
                    <th className="col-num">Öncelik</th>
                    <th>Oluşturan</th>
                    <th>Tarih</th>
                  </tr>
                </thead>
                <tbody>
                  {data.versions.map((version) => (
                    <tr key={version.id} data-testid="campaign-version-row" data-version={version.versionNumber} data-active={activeVersion?.id === version.id ? 'true' : 'false'}>
                      <td className="col-num">
                        v{version.versionNumber}
                        {activeVersion?.id === version.id ? ' (çalışan)' : ''}
                        {currentVersion?.id === version.id ? ' (son)' : ''}
                      </td>
                      <td>{TRIGGER_LABELS[version.trigger as CampaignTrigger] ?? version.trigger}</td>
                      <td className="col-num">{version.benefitCredits}</td>
                      <td className="col-num">{version.benefitExpiresInDays}</td>
                      <td className="col-num">{version.maxRedemptionsPerProvider}</td>
                      <td className="col-num">{version.maxRedemptionsGlobal ?? '—'}</td>
                      <td className="col-num">{version.maxRedemptionsPerDay ?? '—'}</td>
                      <td className="col-num">{version.budgetCredits ?? '—'}</td>
                      <td className="col-num">{version.priority}</td>
                      <td>{version.createdBy.name ?? '—'}</td>
                      <td>{formatDateTime(version.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
        </div>

        <aside className="admin-side-column">
          <CampaignLifecyclePanel
            campaign={campaign}
            engineEnabled={data.engineEnabled}
            activeVersion={activeVersion}
            currentVersion={currentVersion}
          />

          <SectionCard title="Denetim izi" subtitle="Kim, ne zaman, hangi sürümü.">
            <ol className="campaign-audit" data-testid="campaign-audit">
              {data.audit.map((entry) => (
                <li key={entry.id} className="campaign-audit-entry">
                  <div className="campaign-audit-head">
                    <strong>{auditActionLabel(entry.action)}</strong>
                    <span>{formatDateTime(entry.createdAt)}</span>
                  </div>
                  <div className="campaign-audit-meta">
                    {entry.actor.name ?? '—'}
                    {entry.summary?.versionNumber ? ` · sürüm ${entry.summary.versionNumber}` : ''}
                    {entry.summary?.previousActiveVersionNumber ? ` (önceki: sürüm ${entry.summary.previousActiveVersionNumber})` : ''}
                    {entry.summary?.changedFields && entry.summary.changedFields.length > 0
                      ? ` · değişen: ${entry.summary.changedFields.join(', ')}`
                      : ''}
                    {entry.summary?.reason ? ` · gerekçe: ${entry.summary.reason}` : ''}
                  </div>
                </li>
              ))}
            </ol>
          </SectionCard>
          <div className="admin-action-panel">
            <h3>Bu sürümde yok</h3>
            <p>
              Hak ediş listesi, değerlendirme kayıtları ve geri alma (S3) ile hizmet veren promosyon yüzeyi (S4) sonraki
              dilimlerde gelir. Motor anahtarı bu ekrandan değiştirilemez.
            </p>
            <Link className="btn btn-secondary btn-sm" href="/campaigns">
              Listeye dön
            </Link>
          </div>
        </aside>
      </div>
    </main>
  );
}

function auditActionLabel(action: string): string {
  switch (action) {
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
      return 'Kampanya sonlandırıldı';
    default:
      return action;
  }
}

/** A stored definition, read for a human — the same catalogue labels the builder uses. */
function VersionDefinition({ version }: { version: CampaignVersion }) {
  const form = formFromDefinition(version.definition);
  return (
    <dl className="campaign-summary" data-testid="campaign-current-definition">
      <dt>Tetikleyici</dt>
      <dd>{TRIGGER_LABELS[form.trigger] ?? form.trigger}</dd>
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
      <dt>Limitler</dt>
      <dd>
        hizmet veren başına {version.maxRedemptionsPerProvider} · toplam {version.maxRedemptionsGlobal ?? 'sınırsız'} ·
        günlük {version.maxRedemptionsPerDay ?? 'sınırsız'} · bütçe {version.budgetCredits ?? 'sınırsız'} kredi
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
