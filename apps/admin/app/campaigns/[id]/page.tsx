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

/**
 * One campaign: its current draft, every version that came before it, and
 * who did what.
 *
 * The version history is the audit trail of the definition itself — each
 * row is a snapshot that was never edited — and the audit list below it is
 * the trail of *actions*. The revision form at the bottom is pre-filled from
 * the current version and produces the next one; it never touches this one.
 */

export const dynamic = 'force-dynamic';

type CampaignDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; v?: string }>;
};

const OK_MESSAGES: Record<string, string> = {
  created: 'Taslak oluşturuldu (sürüm 1). Motor kapalı: bu kayıt kredi vermez.',
  revised: 'Yeni sürüm kaydedildi. Önceki sürüm değiştirilmedi; motor kapalı olduğundan hiçbir şey çalışmaz.',
};

export default async function CampaignDetailPage({ params, searchParams }: CampaignDetailPageProps) {
  await requireAdmin();
  const { id } = await params;
  const query = await searchParams;
  const data = await fetchOrNotFound(() =>
    apiFetch<CampaignDetailResponse>(`/admin/campaigns/${encodeURIComponent(id)}`),
  );
  const okMessage = query.ok ? (OK_MESSAGES[query.ok] ?? null) : null;
  const { campaign, currentVersion } = data;

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
          <span className={campaignStatusBadgeClass(campaign.status)} data-testid="campaign-status">
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
          <SectionCard
            title={currentVersion ? `Güncel taslak — sürüm ${currentVersion.versionNumber}` : 'Güncel taslak'}
            subtitle="Kaydedilmiş tanım; değiştirmek için aşağıda yeni revizyon oluşturun."
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
                    <tr key={version.id} data-testid="campaign-version-row" data-version={version.versionNumber}>
                      <td className="col-num">
                        v{version.versionNumber}
                        {currentVersion?.id === version.id ? ' (güncel)' : ''}
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

          <SectionCard title="Yeni revizyon" subtitle="Güncel sürümden başlar; kaydetmek yeni bir sürüm numarası üretir.">
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
        </div>

        <aside className="admin-side-column">
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
                    {entry.summary?.changedFields && entry.summary.changedFields.length > 0
                      ? ` · değişen: ${entry.summary.changedFields.join(', ')}`
                      : ''}
                  </div>
                </li>
              ))}
            </ol>
          </SectionCard>
          <div className="admin-action-panel">
            <h3>Bu sürümde yok</h3>
            <p>
              Etkinleştirme, duraklatma, sonlandırma ve hak ediş kayıtları kampanya motoruyla birlikte gelir. Bu
              ekran yalnızca taslak tanımlar.
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
