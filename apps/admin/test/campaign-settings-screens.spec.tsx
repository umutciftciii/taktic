import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CampaignQuestions, CAMPAIGN_QUESTIONS } from '../app/campaigns/campaign-questions';
import { CampaignEngineNotice } from '../app/campaigns/engine-notice';
import { CampaignLifecyclePanel } from '../app/campaigns/lifecycle-panel';
import { RevokeConsequence, RevokeRedemptionForm } from '../app/campaigns/operations-panels';
import { CampaignEngineToggle, EngineConsequence } from '../app/operations-settings/campaign-engine-toggle';
import { SchedulerToggle } from '../app/operations-settings/scheduler-toggle';
import { AuditTable, SettingRow, switchStateLabel } from '../app/operations-settings/setting-row';
import { DecisionConsequence, EligibilityDecisionForm } from '../app/promotion-eligibility/[eventId]/decision-form';
import { ConfirmDialog, shadowedFormId } from '../components/confirm-dialog';
import type { Campaign, CampaignStatus, CampaignVersionSummary } from '../lib/api';

/**
 * ADMIN-DESIGN-001 Faz 3E — the pieces of the campaign, eligibility and
 * operations-settings screens that decide something on their own: which
 * moves ask first and what the dialogs promise, which controls a permission
 * draws, and that no 3E form can lose a ConfirmDialog's value to a field
 * named "id" (the Faz 3D trap).
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

const VERSION: CampaignVersionSummary = {
  id: 'v1',
  versionNumber: 1,
  trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
  eligibilityFacts: [],
  factSetKey: null,
  benefitType: 'PROMO_CREDITS',
  benefitCredits: 10,
  benefitExpiresInDays: 30,
  maxRedemptionsPerProvider: 1,
  maxRedemptionsGlobal: null,
  maxRedemptionsPerDay: null,
  budgetCredits: null,
  maxRevokesPerDay: null,
  windowStartAt: null,
  windowEndAt: null,
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
  channel: 'WEB',
  spendPriority: 'PROMO_FIRST',
  adminDeductPolicy: 'PAID_ONLY',
  createdAt: '2026-09-30T10:00:00.000Z',
  createdBy: { id: 'a1', name: 'Yönetici' },
};

function campaign(status: CampaignStatus, activeVersionId: string | null): Campaign {
  return {
    id: 'c1',
    key: 'ilk-paket',
    name: 'İlk paket bonusu',
    status,
    activeVersionId,
    redemptionCount: 0,
    budgetConsumedCredits: 0,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    createdBy: { id: 'a1', name: 'Yönetici' },
  };
}

function panel(status: CampaignStatus, canLifecycle: boolean, engineEnabled = true): string {
  const running = status === 'DRAFT' ? null : VERSION;
  return html(
    <CampaignLifecyclePanel
      campaign={campaign(status, running?.id ?? null)}
      engineEnabled={engineEnabled}
      activeVersion={running}
      currentVersion={VERSION}
      currentVersionChannel={{ channel: 'WEB', available: true, missingSources: [] }}
      canLifecycle={canLifecycle}
    />,
  );
}

/** The `<button …>` whose data-testid is `testId`, as rendered. */
function button(markup: string, testId: string): string | null {
  const match = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
  return match ? match[0] : null;
}

describe('campaign lifecycle: what asks first', () => {
  it('asks before closing a draft, and offers nothing else irreversible', () => {
    const markup = panel('DRAFT', true);
    const close = button(markup, 'campaign-close-draft');
    expect(close).toContain('aria-haspopup="dialog"');
    expect(close).toContain('name="intent"');
    expect(close).toContain('value="close"');
    expect(markup).toContain('Taslak kapatılsın mı?');
    expect(button(markup, 'campaign-end')).toBeNull();
  });

  it('asks before ending, and before pausing and resuming (Paket A)', () => {
    const active = panel('ACTIVE', true);
    const end = button(active, 'campaign-end');
    expect(end).toContain('aria-haspopup="dialog"');
    expect(end).toContain('value="end"');
    expect(active).toContain('Kampanya sonlandırılsın mı?');
    expect(active).toContain('bir daha açılamaz');
    const pause = button(active, 'campaign-pause');
    expect(pause).toContain('aria-haspopup="dialog"');
    expect(pause).toContain('value="pause"');
    expect(active).toContain('Kampanya duraklatılsın mı?');
    expect(active).toContain('Verilmiş promosyon lotları geri alınmaz');

    const paused = panel('PAUSED', true);
    expect(button(paused, 'campaign-end')).toContain('aria-haspopup="dialog"');
    const resume = button(paused, 'campaign-resume');
    expect(resume).toContain('aria-haspopup="dialog"');
    expect(resume).toContain('value="resume"');
    expect(paused).toContain('Duraklatıldı → Etkin');
    // The reason the form already required stays required.
    expect(paused).toMatch(/<textarea name="reason" minLength="3" maxLength="500" required=""[^>]*data-testid="campaign-lifecycle-reason"/);
  });

  it('a first activation asks, naming the version and its rule from the stored version', () => {
    const markup = panel('DRAFT', true);
    expect(button(markup, 'campaign-activate')).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('Sürüm 1 etkinleştirilsin mi?');
    expect(markup).toContain('Paket ödemesi tamamlandı');
    expect(markup).toContain('10 promosyon kredisi, 30 gün içinde kullanılmalı');
    expect(markup).toContain('hizmet veren başına 1 · toplam sınırsız · günlük sınırsız');
    expect(markup).toContain('Web');
    expect(markup).toContain('süresiz (başlangıç ve bitiş yok)');
    expect(markup).toContain('promosyon kredisi dağıtımı başlar');
    expect(markup).toContain('otomatik geri alınmaz');
  });

  it('a switch on a running campaign names old → new and only what changes', () => {
    const v2: CampaignVersionSummary = { ...VERSION, id: 'v2', versionNumber: 2, benefitCredits: 25, budgetCredits: 500 };
    const markup = html(
      <CampaignLifecyclePanel
        campaign={campaign('ACTIVE', VERSION.id)}
        engineEnabled
        activeVersion={VERSION}
        currentVersion={v2}
        currentVersionChannel={{ channel: 'WEB', available: true, missingSources: [] }}
        canLifecycle
      />,
    );
    expect(button(markup, 'campaign-activate')).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('Sürüm 1 → 2 geçişi yapılsın mı?');
    expect(markup).toContain('10 promosyon kredisi, 30 gün içinde kullanılmalı → <strong>25 promosyon kredisi, 30 gün içinde kullanılmalı</strong>');
    expect(markup).toContain('sınırsız → <strong>500 kredi</strong>');
    expect(markup).not.toContain('<dt>Kanal</dt>');
    expect(markup).toContain('onaydan hemen sonra');
  });

  it('resuming a paused campaign with a new version asks for a reason and says PAUSED → ACTIVE', () => {
    const v2: CampaignVersionSummary = { ...VERSION, id: 'v2', versionNumber: 2, maxRedemptionsPerProvider: 3 };
    const markup = html(
      <CampaignLifecyclePanel
        campaign={campaign('PAUSED', VERSION.id)}
        engineEnabled
        activeVersion={VERSION}
        currentVersion={v2}
        currentVersionChannel={{ channel: 'WEB', available: true, missingSources: [] }}
        canLifecycle
      />,
    );
    expect(button(markup, 'campaign-activate')).toContain('aria-haspopup="dialog"');
    expect(markup).toMatch(/<textarea name="reason" minLength="3" maxLength="500" required=""[^>]*data-testid="campaign-activate-reason"/);
    expect(markup).toContain('Kampanya sürüm 2 ile devam ettirilsin mi?');
    expect(markup).toContain('Duraklatıldı → Etkin');
    expect(markup).toContain('hizmet veren başına 1 · toplam sınırsız · günlük sınırsız → <strong>hizmet veren başına 3 · toplam sınırsız · günlük sınırsız</strong>');
    expect(markup).toContain('promosyon kredisi dağıtımı yeniden başlar');
  });

  it('draws no move at all without CAMPAIGNS_LIFECYCLE, in any state', () => {
    for (const status of ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const) {
      const markup = panel(status, false);
      for (const testId of ['campaign-activate', 'campaign-pause', 'campaign-resume', 'campaign-end', 'campaign-close-draft']) {
        expect(button(markup, testId), `${status} → ${testId}`).toBeNull();
      }
    }
  });

  it('offers nothing on an ended campaign', () => {
    expect(panel('ENDED', true)).not.toContain('<button');
  });
});

describe('redemption revoke dialog', () => {
  it('names the credit, the provider and the threshold, and asks first', () => {
    const form = html(
      <RevokeRedemptionForm
        campaignId="c1"
        redemptionId="r1"
        providerName="Usta Tesisat"
        grantedCredits={10}
        remainingCredits={6}
        revokeThreshold={2}
      />,
    );
    expect(button(form, 'campaign-revoke')).toContain('aria-haspopup="dialog"');
    expect(form).toContain('name="targetId" value="r1"');
    expect(form).not.toMatch(/name="id"/);

    const withThreshold = html(
      <RevokeConsequence providerName="Usta Tesisat" grantedCredits={10} remainingCredits={6} revokeThreshold={2} />,
    );
    expect(withThreshold).toContain('<strong>6 kredi</strong>');
    expect(withThreshold).toContain('Usta Tesisat');
    expect(withThreshold).toContain('borç oluşmaz');
    expect(withThreshold).toContain('2 eşiğini aşarsa kampanya kendini duraklatır');

    const noThreshold = html(
      <RevokeConsequence providerName="Usta Tesisat" grantedCredits={10} remainingCredits={null} revokeThreshold={null} />,
    );
    expect(noThreshold).toContain('günlük geri alma eşiği yok');
    expect(noThreshold).not.toContain('duraklatır');
  });
});

describe('eligibility decision', () => {
  it('is one form with a confirmation, posting eventId — never a field named "id"', () => {
    const form = html(<EligibilityDecisionForm eventId="e1" providerName="Usta Tesisat" action={() => undefined} />);
    expect(form).toContain('name="eventId" value="e1"');
    expect(form).not.toMatch(/name="id"/);
    expect(button(form, 'eligibility-submit')).toContain('aria-haspopup="dialog"');
    expect(form).toContain('Karar kesinleşsin mi?');
  });

  it('says what each decision does, and that it is final', () => {
    const eligible = html(<DecisionConsequence decision="ELIGIBLE" providerName="Usta Tesisat" />);
    expect(eligible).toContain('değerlendirme kuyruğuna alınır');
    expect(eligible).toContain('kredi vermez');
    const ineligible = html(<DecisionConsequence decision="INELIGIBLE" providerName="Usta Tesisat" />);
    expect(ineligible).toContain('giriş promosyonu verilmez');
    for (const markup of [eligible, ineligible]) {
      expect(markup).toContain('<strong>kesindir</strong>');
      expect(markup).toContain('değiştirilemez');
    }
  });
});

describe('operations settings controls', () => {
  it('opening a job asks first (a switch that opens a dialog); closing one is one tap', () => {
    const off = html(<SchedulerToggle job="request-expiry" jobName="Talep süresi dolumu" enabled={false} consequence="…" />);
    const offButton = button(off, 'scheduler-toggle-request-expiry')!;
    expect(offButton).toContain('role="switch"');
    expect(offButton).toContain('aria-checked="false"');
    expect(offButton).toContain('aria-label="Talep süresi dolumu"');
    // A switch names itself; aria-haspopup is not a switch property.
    expect(offButton).not.toContain('aria-haspopup');
    expect(off).toContain('<dialog');
    expect(off).toContain('name="enabled" value="true"');

    const on = html(<SchedulerToggle job="request-expiry" jobName="Talep süresi dolumu" enabled consequence="…" />);
    expect(button(on, 'scheduler-toggle-request-expiry')).toContain('aria-checked="true"');
    expect(on).not.toContain('<dialog');
    expect(on).toContain('name="enabled" value="false"');
  });

  it('the engine asks in both directions, and a pre-hydration click cannot carry confirm=yes', () => {
    for (const enabled of [false, true]) {
      const markup = html(<CampaignEngineToggle enabled={enabled} />);
      expect(button(markup, 'campaign-engine-submit')).toContain(`aria-checked="${enabled}"`);
      expect(markup).toContain('<dialog');
      // The server-rendered form has no confirm field: it is added on hydration.
      expect(markup).not.toContain('name="confirm"');
    }
    expect(html(<EngineConsequence enabled={false} />)).toContain('geriye dönük hak ediş üretilmez');
    expect(html(<EngineConsequence enabled />)).toContain('geri alınması aynen sürer');
  });

  it('a row without a control is only its state, text and disclosure', () => {
    const markup = html(
      <SettingRow
        testId="provider-reviews"
        name="Hizmet veren değerlendirmeleri"
        badge={<span data-testid="provider-reviews-state">Kapalı</span>}
        description="…"
        whatHappens={{ question: 'Açarsam ne olur?', answer: <p>en az üç değerlendirme</p> }}
      />,
    );
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<form');
    expect(markup).toContain('<details class="what-happens">');
    expect(markup).toContain('en az üç değerlendirme');
  });

  it('an empty change list keeps its empty test id and draws no table', () => {
    const empty = html(
      <AuditTable
        title="Kampanya motoru"
        caption="…"
        changes={[]}
        testId="campaign-engine-audit"
        emptyText="Henüz bir değişiklik kaydı yok."
        emptyTestId="campaign-engine-audit-empty"
        formatValue={switchStateLabel}
        formatPrevious={(value) => (value === null ? 'varsayılan (kapalı)' : switchStateLabel(value))}
      />,
    );
    expect(empty).toContain('data-testid="campaign-engine-audit-empty"');
    expect(empty).not.toContain('data-testid="campaign-engine-audit"');

    const one = html(
      <AuditTable
        title="Zamanlanmış işler"
        caption="…"
        changes={[
          {
            id: 'x',
            setting: 'requestExpirySchedulerEnabled',
            previousValue: null,
            newValue: 'true',
            createdAt: '2026-09-30T10:00:00.000Z',
            changedBy: { id: 'a1', name: 'Yönetici' },
          },
        ]}
        testId="scheduler-audit"
        emptyText="…"
        settingLabel={() => 'Talep süresi dolum işi'}
        formatValue={switchStateLabel}
        formatPrevious={(value) => (value === null ? 'varsayılan (kapalı)' : switchStateLabel(value))}
      />,
    );
    expect(one).toContain('data-testid="scheduler-audit"');
    expect(one).toContain('Talep süresi dolum işi');
    expect(one).toContain('Açık');
    expect(one).toContain('Yönetici');
  });
});

describe('campaign list pieces', () => {
  it('the three questions are static text that promises no behaviour the engine lacks', () => {
    const markup = html(<CampaignQuestions />);
    expect(CAMPAIGN_QUESTIONS).toHaveLength(3);
    expect(markup).not.toMatch(/kredi verildi|kendiliğinden durur|30 gündür/);
  });

  it('the engine callout links to the settings only for a session that may open them', () => {
    const withLink = html(<CampaignEngineNotice engineEnabled={false} canOpenOperationsSettings />);
    expect(withLink).toContain('data-engine="off"');
    expect(withLink).toContain('etkinleştirme yapılamaz');
    expect(withLink).toContain('data-testid="campaign-engine-settings-link"');
    const without = html(<CampaignEngineNotice engineEnabled canOpenOperationsSettings={false} />);
    expect(without).toContain('data-engine="on"');
    expect(without).not.toContain('href="/operations-settings');
  });
});

describe('ConfirmDialog and a field named "id" (Faz 3D)', () => {
  it('detects a form whose id property a field has taken over', () => {
    expect(shadowedFormId({ id: '' } as unknown as HTMLFormElement)).toBe(false);
    expect(shadowedFormId({ id: 'settings' } as unknown as HTMLFormElement)).toBe(false);
    expect(shadowedFormId({ id: { name: 'id' } } as unknown as HTMLFormElement)).toBe(true);
  });

  it('keeps its ordinary trigger unchanged when it is not a switch', () => {
    const markup = html(
      <ConfirmDialog proof="campaign.end" triggerLabel="Sonlandır" title="?" consequence="." confirmLabel="Evet" name="intent" value="end" testId="t" />,
    );
    const trigger = button(markup, 't')!;
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).not.toContain('role="switch"');
    expect(markup).toContain('>Sonlandır</button>');
  });

  /**
   * Every form on the six 3E screens, read as source: none of them carries a
   * field named "id". The component guard makes the combination safe; this
   * keeps the screens from depending on it silently.
   */
  it('no 3E form carries a field named "id"', () => {
    const root = resolve(__dirname, '..', 'app');
    const dirs = ['campaigns', 'promotion-eligibility', 'operations-settings'];
    const files = dirs.flatMap((dir) => walk(join(root, dir))).filter((file) => file.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(/name=["{']+id["}']/);
    }
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
