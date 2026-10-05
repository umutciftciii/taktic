import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { campaignVersionProofKey, versionChanges, versionFacts } from '../app/campaigns/lifecycle-proof';
import { CreditPackageCreateSubmit, CreditPackageEditSubmit } from '../app/credit-packages/credit-package-gates';
import { creditPackageTermsChanges, type CreditPackageTerms } from '../app/credit-packages/package-changes';
import { AutoPublishToggle } from '../app/operations-settings/auto-publish-toggle';
import { ProviderReviewsToggle } from '../app/operations-settings/provider-reviews-toggle';
import { SchedulerToggle } from '../app/operations-settings/scheduler-toggle';
import { readShowcaseTerms, showcasePackageTermsChanges } from '../app/showcase/packages/package-changes';
import { ShowcasePackageCreateSubmit, ShowcasePackageEditSubmit } from '../app/showcase/packages/showcase-package-gates';
import { SCHEDULER_JOB_COPY, type CampaignVersionSummary } from '../lib/api';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Paket A: the pieces that decide which
 * save asks, and what the dialog says. The server-side halves (the actions
 * demanding the same proofs from the stored record) are in
 * `confirmation-proof.spec.ts`.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

function button(markup: string, testId: string): string | null {
  return markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? null;
}

const ONE_TIME: CreditPackageTerms = {
  type: 'ONE_TIME_CREDITS',
  priceAmount: 14_990,
  currency: 'TRY',
  creditAmount: 50,
  quotaCredits: null,
  dailyOfferLimit: null,
  scopeCategoryIds: [],
};

describe('credit package: what is commercial', () => {
  it('nothing, when only the figures of another type move', () => {
    expect(creditPackageTermsChanges(ONE_TIME, { ...ONE_TIME, quotaCredits: 99, dailyOfferLimit: 3, scopeCategoryIds: ['x'] })).toEqual([]);
  });

  it('the price, the currency and the credits of a one-time package, old → new', () => {
    expect(creditPackageTermsChanges(ONE_TIME, { ...ONE_TIME, priceAmount: 19_990, creditAmount: 60 })).toEqual([
      { key: 'price', label: 'Fiyat', from: '₺149,90', to: '₺199,90' },
      { key: 'credits', label: 'Kredi', from: '50 kredi', to: '60 kredi' },
    ]);
    expect(creditPackageTermsChanges(ONE_TIME, { ...ONE_TIME, currency: 'USD' }).map((change) => change.key)).toEqual(['price']);
  });

  it('a quota, a daily cap (0 = none) and a scope set, independent of order', () => {
    const quota: CreditPackageTerms = { ...ONE_TIME, type: 'MONTHLY_QUOTA', creditAmount: 0, quotaCredits: 20 };
    expect(creditPackageTermsChanges(quota, { ...quota, quotaCredits: 30 })[0]).toMatchObject({ from: '20 kredi', to: '30 kredi' });
    const unlimited: CreditPackageTerms = { ...ONE_TIME, type: 'CATEGORY_UNLIMITED', creditAmount: 0, scopeCategoryIds: ['a', 'b'] };
    expect(creditPackageTermsChanges(unlimited, { ...unlimited, dailyOfferLimit: 0, scopeCategoryIds: ['b', 'a'] })).toEqual([]);
    expect(
      creditPackageTermsChanges(unlimited, { ...unlimited, dailyOfferLimit: 5, scopeCategoryIds: ['a'] }, { a: 'Klima', b: 'Boya' }),
    ).toEqual([
      { key: 'cap', label: 'Günlük teklif limiti', from: 'günlük sınır yok', to: 'günlük 5 teklif' },
      { key: 'scope', label: 'Kapsam', from: 'Klima, Boya', to: 'Klima' },
    ]);
  });

  it('the two save buttons are the form\'s submit buttons, each with its dialog', () => {
    const create = html(<CreditPackageCreateSubmit />);
    expect(button(create, 'credit-package-create-submit')).toMatch(/^<button type="submit"/);
    expect(create).toContain('Paketi oluştur');
    expect(create).toContain('data-testid="credit-package-create-submit-dialog"');
    const edit = html(<CreditPackageEditSubmit stored={{ ...ONE_TIME, name: 'Başlangıç', isActive: true }} statusEditable categoryNames={{}} />);
    expect(button(edit, 'credit-package-save')).toMatch(/^<button type="submit"/);
    expect(edit).toContain('Değişiklikleri kaydet');
  });
});

describe('vitrin package: what is commercial', () => {
  const stored = { priceAmount: 49_990, currency: 'TRY', durationDays: 30, activationWindowDays: 90, allowedCardKind: null, maxAreas: null };

  it('the price, the run, the right\'s validity, the card kind and the area cap', () => {
    expect(showcasePackageTermsChanges(stored, stored)).toEqual([]);
    expect(
      showcasePackageTermsChanges(stored, {
        ...stored,
        priceAmount: 60_000,
        durationDays: 45,
        activationWindowDays: 60,
        allowedCardKind: 'SERVICE',
        maxAreas: 3,
      }),
    ).toEqual([
      { key: 'price', label: 'Yayın bedeli', from: '₺499,90', to: '₺600,00' },
      { key: 'duration', label: 'Yayın süresi', from: '30 gün', to: '45 gün' },
      { key: 'window', label: 'Kullanılmamış hakkın geçerliliği', from: '90 gün', to: '60 gün' },
      { key: 'kind', label: 'Kart tipi', from: 'Her ikisi', to: 'Hizmet vitrini' },
      { key: 'areas', label: 'Bölge', from: 'tüm bölgeler', to: 'en fazla 3 bölge' },
    ]);
  });

  it('reads the form the way the action does', () => {
    const data = new FormData();
    for (const [name, value] of Object.entries({
      priceAmount: '1.250,75',
      durationDays: '30',
      activationWindowDays: '90',
      allowedCardKind: '',
      maxAreas: '',
    })) {
      data.set(name, value);
    }
    expect(readShowcaseTerms(data, 'TRY')).toEqual({ ...stored, priceAmount: 125_075 });
  });

  it('the create and edit buttons are submit buttons with their dialogs', () => {
    expect(button(html(<ShowcasePackageCreateSubmit />), 'showcase-package-create-submit')).toMatch(/^<button type="submit"/);
    const edit = html(<ShowcasePackageEditSubmit stored={{ ...stored, name: 'Vitrin 30', isActive: true }} />);
    expect(button(edit, 'showcase-package-save')).toMatch(/^<button type="submit"/);
    expect(edit).toContain('>Kaydet<');
  });
});

describe('campaign: the version key and the facts the dialog shows', () => {
  const version: CampaignVersionSummary = {
    id: 'v1',
    versionNumber: 1,
    trigger: 'PROVIDER_ELIGIBILITY_REACHED',
    eligibilityFacts: ['PROVIDER_APPROVED', 'EMAIL_VERIFIED'],
    factSetKey: null,
    benefitType: 'PROMO_CREDITS',
    benefitCredits: 5,
    benefitExpiresInDays: 14,
    maxRedemptionsPerProvider: 1,
    maxRedemptionsGlobal: 100,
    maxRedemptionsPerDay: 10,
    budgetCredits: 500,
    maxRevokesPerDay: null,
    windowStartAt: '2026-10-01T09:00:00.000Z',
    windowEndAt: null,
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: 10,
    channel: 'ALL',
    spendPriority: 'PROMO_FIRST',
    adminDeductPolicy: 'PAID_ONLY',
    createdAt: '2026-10-01T09:00:00.000Z',
    createdBy: { id: 'a', name: 'A' },
  };

  it('one key per status, none on an ended campaign', () => {
    expect(campaignVersionProofKey('DRAFT')).toBe('campaign.version-activate');
    expect(campaignVersionProofKey('ACTIVE')).toBe('campaign.version-switch');
    expect(campaignVersionProofKey('PAUSED')).toBe('campaign.version-resume');
    expect(campaignVersionProofKey('ENDED')).toBeNull();
  });

  it('every line of the rule, from the stored version', () => {
    const facts = Object.fromEntries(versionFacts(version).map((fact) => [fact.key, fact.value]));
    expect(facts.facts).toContain('E-posta');
    expect(facts.credit).toBe('5 promosyon kredisi, 14 gün içinde kullanılmalı');
    expect(facts.limit).toBe('hizmet veren başına 1 · toplam 100 · günlük 10');
    expect(facts.budget).toBe('500 kredi');
    expect(facts.channel).toBe('Tümü');
    expect(facts.window).toMatch(/→ süresiz$/);
  });

  it('only the lines that change', () => {
    expect(versionChanges(version, version)).toEqual([]);
    expect(versionChanges(version, { ...version, budgetCredits: null, channel: 'WEB' }).map((change) => change.key)).toEqual([
      'budget',
      'channel',
    ]);
  });
});

describe('operations switches', () => {
  it('auto-publish asks going on, not going off', () => {
    // A switch-drawn ConfirmDialog carries role="switch", not aria-haspopup; the dialog is its sibling.
    const on = html(<AutoPublishToggle enabled={false} />);
    expect(button(on, 'auto-publish-toggle')).toContain('role="switch"');
    expect(on).toContain('data-testid="auto-publish-toggle-dialog"');
    expect(on).toContain('moderasyon beklemeden');
    expect(html(<AutoPublishToggle enabled />)).not.toContain('<dialog');
  });

  it('reviews ask both ways, each with its own sentence', () => {
    const on = html(<ProviderReviewsToggle enabled={false} />);
    expect(on).toContain('yeniden görünür hâle gelebilir');
    expect(on).toContain('davet');
    const off = html(<ProviderReviewsToggle enabled />);
    expect(off).toContain('gizlenir');
    expect(off).toContain('silinmez');
  });

  it('only the two money jobs ask before they stop', () => {
    const guarded = Object.entries(SCHEDULER_JOB_COPY)
      .filter(([, copy]) => copy.disableConfirmation)
      .map(([key]) => key);
    expect(guarded.sort()).toEqual(['entitlement-renewal', 'unviewed-offer-refund']);
    const renewalOff = html(
      <SchedulerToggle job="entitlement-renewal" jobName="Paket yenileme" enabled consequence={null} disableConsequence={<p>durur</p>} />,
    );
    expect(button(renewalOff, 'scheduler-toggle-entitlement-renewal')).toContain('aria-checked="true"');
    expect(renewalOff).toContain('“Paket yenileme” kapatılsın mı?');
    const expiryOff = html(<SchedulerToggle job="request-expiry" jobName="Talep süresi dolumu" enabled consequence={null} />);
    expect(expiryOff).not.toContain('<dialog');
  });
});
