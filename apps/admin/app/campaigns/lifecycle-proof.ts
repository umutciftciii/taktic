import type { CampaignStatus, CampaignVersionSummary } from '../../lib/api';
import { channelLabel, FACT_LABELS, TRIGGER_LABELS } from '../../lib/campaign-rules';

/**
 * Which confirmation "activate version N" needs, by the status the campaign
 * is in (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A) — one function for the
 * panel that draws the dialog and the action that demands its proof, judged
 * there against the status it reads from the API, never one the form claims.
 *
 * - DRAFT → `campaign.version-activate`: the first activation; promotional
 *   credit starts flowing on real events.
 * - ACTIVE → `campaign.version-switch`: the running rule is replaced at once.
 * - PAUSED → `campaign.version-resume`: PAUSED → ACTIVE with a new rule — a
 *   resumption, so it also takes a reason.
 * - ENDED: nothing can be activated.
 */
export type CampaignVersionProofKey = 'campaign.version-activate' | 'campaign.version-switch' | 'campaign.version-resume';

export function campaignVersionProofKey(status: CampaignStatus): CampaignVersionProofKey | null {
  if (status === 'DRAFT') return 'campaign.version-activate';
  if (status === 'ACTIVE') return 'campaign.version-switch';
  if (status === 'PAUSED') return 'campaign.version-resume';
  return null;
}

type VersionFacts = Pick<
  CampaignVersionSummary,
  | 'trigger'
  | 'eligibilityFacts'
  | 'benefitCredits'
  | 'benefitExpiresInDays'
  | 'maxRedemptionsPerProvider'
  | 'maxRedemptionsGlobal'
  | 'maxRedemptionsPerDay'
  | 'budgetCredits'
  | 'channel'
  | 'windowStartAt'
  | 'windowEndAt'
>;

export type VersionFact = { key: string; label: string; value: string };

function dateText(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' }).format(
    new Date(value),
  );
}

function limitText(value: number | null): string {
  return value === null ? 'sınırsız' : String(value);
}

/** One version's rule in the lines an operator decides on, from the stored version. */
export function versionFacts(version: VersionFacts): VersionFact[] {
  const start = dateText(version.windowStartAt);
  const end = dateText(version.windowEndAt);
  return [
    {
      key: 'trigger',
      label: 'Tetikleyici',
      value: (TRIGGER_LABELS as Record<string, string>)[version.trigger] ?? version.trigger,
    },
    ...(version.eligibilityFacts.length > 0
      ? [
          {
            key: 'facts',
            label: 'Koşul olguları',
            value: version.eligibilityFacts.map((fact) => (FACT_LABELS as Record<string, string>)[fact] ?? fact).join(', '),
          },
        ]
      : []),
    {
      key: 'credit',
      label: 'Kredi',
      value: `${version.benefitCredits} promosyon kredisi, ${version.benefitExpiresInDays} gün içinde kullanılmalı`,
    },
    {
      key: 'limit',
      label: 'Limit',
      value: `hizmet veren başına ${version.maxRedemptionsPerProvider} · toplam ${limitText(version.maxRedemptionsGlobal)} · günlük ${limitText(version.maxRedemptionsPerDay)}`,
    },
    {
      key: 'budget',
      label: 'Bütçe',
      value: version.budgetCredits === null ? 'sınırsız' : `${version.budgetCredits} kredi`,
    },
    { key: 'channel', label: 'Kanal', value: channelLabel(version.channel) },
    {
      key: 'window',
      label: 'Süre',
      value: start || end ? `${start ?? 'hemen'} → ${end ?? 'süresiz'}` : 'süresiz (başlangıç ve bitiş yok)',
    },
  ];
}

export type VersionChange = { key: string; label: string; from: string; to: string };

/** The lines that differ between the running version and the one replacing it. */
export function versionChanges(from: VersionFacts, to: VersionFacts): VersionChange[] {
  const before = versionFacts(from);
  const after = versionFacts(to);
  const keys = [...new Set([...before.map((fact) => fact.key), ...after.map((fact) => fact.key)])];
  const changes: VersionChange[] = [];
  for (const key of keys) {
    const was = before.find((fact) => fact.key === key);
    const will = after.find((fact) => fact.key === key);
    const fromValue = was?.value ?? '—';
    const toValue = will?.value ?? '—';
    if (fromValue !== toValue) {
      changes.push({ key, label: (will ?? was)!.label, from: fromValue, to: toValue });
    }
  }
  return changes;
}
