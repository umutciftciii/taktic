import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  categoryChanges,
  categoryCreateNeedsProof,
  categoryPayload,
  categoryProofKeys,
  readRouterRules,
  routerRuleChanges,
  type CategoryStored,
} from '../app/categories/category-changes';
import {
  CategoryChangeConsequence,
  CategoryCreateSubmit,
  CategoryEditSubmit,
  CategoryStatusSubmit,
  RouterRulesSubmit,
  StatusChangeConsequence,
} from '../app/categories/category-gates';
import { CompanySettingsSubmit } from '../app/company-settings/company-settings-submit';
import { companySettingsChanges } from '../app/company-settings/settings-changes';
import { RefundWindowSubmit } from '../app/operations-settings/refund-window-submit';
import { isPlacementSuspendNoteValid, PLACEMENT_SUSPEND_NOTE_MIN_LENGTH } from '../app/showcase/placements/placement-cancel';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Paket B: the pieces that decide which
 * save asks, and what the dialogs say. The server-side halves (the actions
 * demanding the same proofs from the stored record, refusing without them,
 * and the low-risk branches staying direct) are in `confirmation-proof.spec.ts`.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

function button(markup: string, testId: string): string | null {
  return markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? null;
}

function formData(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) data.append(name, entry);
  }
  return data;
}

const STORED: CategoryStored = {
  id: 'cat-1',
  name: 'Klima',
  slug: 'klima',
  kind: 'LEAF',
  status: 'ACTIVE',
  parentId: null,
  offerCreditCost: 3,
  unlimitedPackageEligible: false,
};

const FIELDS = {
  id: 'cat-1',
  name: 'Klima',
  slug: 'klima',
  kind: 'LEAF',
  status: 'ACTIVE',
  parentId: '',
  sortOrder: '0',
  offerCreditCost: '3',
};

const keysFor = (fields: Record<string, string>, stored: CategoryStored = STORED) =>
  categoryProofKeys(categoryChanges(stored, categoryPayload(formData({ ...FIELDS, ...fields }))));

describe('category save: which change asks, judged against the stored category', () => {
  it('the name, description, pictures, icon and order ask nothing', () => {
    expect(
      keysFor({ name: 'Klima bakımı', description: 'Yeni', imageUrl: '/a.png', iconKey: 'snow', sortOrder: '9' }),
    ).toEqual([]);
  });

  it('a slug, type or parent change is one structural proof', () => {
    expect(keysFor({ slug: ' klima-servisi ' })).toEqual(['category.structure-update']);
    expect(keysFor({ kind: 'ROUTER' })).toEqual(['category.structure-update']);
    expect(keysFor({ parentId: 'grp-1' })).toEqual(['category.structure-update']);
    expect(keysFor({ slug: 'x', parentId: 'grp-1' })).toEqual(['category.structure-update']);
    // The trimmed slug is the stored one: not a change.
    expect(keysFor({ slug: '  klima  ' })).toEqual([]);
  });

  it('the offer price asks; a router carries none, so it cannot change it', () => {
    expect(keysFor({ offerCreditCost: '5' })).toEqual(['category.offer-credit-update']);
    expect(categoryChanges({ ...STORED, offerCreditCost: null }, categoryPayload(formData(FIELDS))).offerCreditCost).toEqual({
      from: null,
      to: 3,
    });
    expect(categoryPayload(formData({ ...FIELDS, kind: 'ROUTER', offerCreditCost: '9' })).offerCreditCost).toBeUndefined();
  });

  it('unlimited eligibility asks only when it goes on', () => {
    expect(keysFor({ unlimitedPackageEligible: 'on' })).toEqual(['category.unlimited-enable']);
    expect(keysFor({}, { ...STORED, unlimitedPackageEligible: true })).toEqual([]);
    // A closed category carries no box: not sent, not a change.
    expect(keysFor({ status: 'INACTIVE' }, { ...STORED, status: 'INACTIVE', unlimitedPackageEligible: true })).toEqual([]);
  });

  it('a status move asks by its direction; without the status permission the status is not sent', () => {
    expect(keysFor({ status: 'INACTIVE' })).toEqual(['category.deactivate']);
    expect(keysFor({ status: 'DRAFT' })).toEqual(['category.deactivate']);
    expect(keysFor({ status: 'ACTIVE' }, { ...STORED, status: 'DRAFT' })).toEqual(['category.activate']);
    expect(keysFor({ status: 'DRAFT', statusLocked: '1' })).toEqual([]);
  });

  it('several changes, several proofs — in one dialog', () => {
    expect(keysFor({ slug: 'klima-2', offerCreditCost: '4', unlimitedPackageEligible: 'on', status: 'INACTIVE' })).toEqual([
      'category.structure-update',
      'category.offer-credit-update',
      'category.deactivate',
    ]);
    // INACTIVE carries no eligibility box, so turning it on cannot ride along.
  });

  it('a create asks unless it is an explicit DRAFT', () => {
    expect(categoryCreateNeedsProof(categoryPayload(formData({ ...FIELDS, status: 'DRAFT' })))).toBe(false);
    expect(categoryCreateNeedsProof(categoryPayload(formData({ ...FIELDS, status: 'ACTIVE' })))).toBe(true);
    expect(categoryCreateNeedsProof(categoryPayload(formData({ ...FIELDS, status: 'INACTIVE' })))).toBe(true);
    // No status at all means ACTIVE at the API.
    expect(categoryCreateNeedsProof(categoryPayload(formData({ ...FIELDS, status: '' })))).toBe(true);
  });
});

describe('category dialogs say what the API does', () => {
  it('structure: slug old → new and that outside links can break; the tree changes', () => {
    const said = html(
      <CategoryChangeConsequence
        changes={categoryChanges(STORED, categoryPayload(formData({ ...FIELDS, slug: 'klima-servisi', parentId: 'grp-1' })))}
        parentNames={{ 'grp-1': 'Ev hizmetleri' }}
        impact={null}
      />,
    );
    expect(said).toContain('<code>klima</code> → <strong><code>klima-servisi</code></strong>');
    expect(said).toContain('dış bağlantılar ve arama motoru kayıtları');
    expect(said).toContain('üst seviye → <strong>Ev hizmetleri</strong>');
    expect(said).toContain('Kategori ağacı değişir');
  });

  it('offer credit: old → new, only for offers from now on; unlimited: the subtree may join packages', () => {
    const said = html(
      <CategoryChangeConsequence
        changes={categoryChanges(STORED, categoryPayload(formData({ ...FIELDS, offerCreditCost: '5', unlimitedPackageEligible: 'on' })))}
        parentNames={{}}
        impact={null}
      />,
    );
    expect(said).toContain('3 kredi → <strong>5 kredi</strong>');
    expect(said).toContain('yalnız bundan sonra verilecek tekliflere');
    expect(said).toContain('alt kategorileri) kategori limitsiz');
  });

  it('closing a live category: no new requests, its live runs suspended with the real count, resume on reopening', () => {
    const said = html(<StatusChangeConsequence from="ACTIVE" to="INACTIVE" impact={{ onAir: 3, heldByClosure: 0 }} />);
    expect(said).toContain('Müşteri kataloğundan çıkar');
    expect(said).toContain('yeni talep açılamaz');
    expect(said).toContain('askıya alınır');
    expect(said).toContain('süreleri durur');
    expect(said).toContain('yayında 3 yerleşim var');
    expect(said).toContain('kendiliğinden devam eder');
  });

  it('a count it cannot read is said, never guessed', () => {
    const said = html(<StatusChangeConsequence from="ACTIVE" to="DRAFT" impact={null} />);
    expect(said).toContain('gösterilemiyor');
    expect(said).not.toMatch(/yayında \d+ yerleşim/);
  });

  it('opening: into the catalogue, and the CATEGORY_CLOSED runs may resume (with their count)', () => {
    const said = html(<StatusChangeConsequence from="INACTIVE" to="ACTIVE" impact={{ onAir: 0, heldByClosure: 2 }} />);
    expect(said).toContain('Müşteri kataloğunda yayına çıkar');
    expect(said).toContain('“Kategori kapalı”');
    expect(said).toContain('duran 2 yerleşim var');
  });

  it('between the closed states nothing on the vitrin moves, and it says so', () => {
    const said = html(<StatusChangeConsequence from="DRAFT" to="INACTIVE" impact={{ onAir: 0, heldByClosure: 0 }} />);
    expect(said).toContain('vitrin yerleşimleri bu değişiklikten etkilenmez');
  });

  it('the three save buttons are their form\'s submit buttons, each with a dialog', () => {
    const create = html(<CategoryCreateSubmit />);
    expect(button(create, 'category-create-submit')).toMatch(/^<button type="submit"/);
    expect(create).toContain('data-testid="category-create-submit-dialog"');
    const edit = html(<CategoryEditSubmit stored={STORED} parentNames={{}} impact={null} />);
    expect(button(edit, 'category-save')).toMatch(/^<button type="submit"/);
    expect(edit).toContain('Kategoriyi kaydet');
    const status = html(<CategoryStatusSubmit stored={STORED} impact={null} />);
    expect(button(status, 'category-status-submit')).toMatch(/^<button type="submit"/);
  });
});

describe('router map: a save that sends anyone elsewhere asks', () => {
  const stored = [
    { optionKey: 'split', targetCategorySlug: 'klima-montaj' },
    { optionKey: 'salon', targetCategorySlug: 'klima-bakim' },
  ];
  const posted = (split: string, salon: string) =>
    readRouterRules(formData({ routerOptionKey: ['split', 'salon'], routerTargetSlug: [split, salon] }));

  it('the same map asks nothing', () => {
    expect(routerRuleChanges(stored, posted('klima-montaj', ' klima-bakim '))).toEqual([]);
  });

  it('a moved, removed or new target, and a stored rule for an option the form no longer has', () => {
    expect(routerRuleChanges(stored, posted('kombi', ''))).toEqual([
      { optionKey: 'split', from: 'klima-montaj', to: 'kombi' },
      { optionKey: 'salon', from: 'klima-bakim', to: null },
    ]);
    expect(routerRuleChanges([], posted('kombi', ''))).toEqual([{ optionKey: 'split', from: null, to: 'kombi' }]);
    expect(
      routerRuleChanges(stored, readRouterRules(formData({ routerOptionKey: ['split'], routerTargetSlug: ['klima-montaj'] }))),
    ).toEqual([{ optionKey: 'salon', from: 'klima-bakim', to: null }]);
  });

  it('its button is the form\'s submit button with a dialog', () => {
    const markup = html(<RouterRulesSubmit stored={stored} optionLabels={{}} targetNames={{}} />);
    expect(button(markup, 'router-rules-save')).toMatch(/^<button type="submit"/);
  });
});

describe('company settings: only a real change asks', () => {
  const stored = { legalName: 'Örnek A.Ş.', supportEmail: 'destek@ornek.com.tr', postalAddress: null };

  it('spaces, the address case and an empty postal address are not changes (the API stores them so)', () => {
    expect(
      companySettingsChanges(stored, { legalName: ' Örnek A.Ş. ', supportEmail: 'DESTEK@ornek.com.tr', postalAddress: '  ' }),
    ).toEqual([]);
  });

  it('each changed field old → new', () => {
    expect(
      companySettingsChanges(stored, { legalName: 'Yeni A.Ş.', supportEmail: 'destek@ornek.com.tr', postalAddress: 'İstanbul' }),
    ).toEqual([
      { key: 'legalName', label: 'Yasal unvan', from: 'Örnek A.Ş.', to: 'Yeni A.Ş.' },
      { key: 'postalAddress', label: 'Posta adresi', from: null, to: 'İstanbul' },
    ]);
  });

  it('the save button and the refund-window button are their forms\' submit buttons', () => {
    expect(button(html(<CompanySettingsSubmit stored={stored} />), 'company-settings-save')).toMatch(/^<button type="submit"/);
    expect(button(html(<RefundWindowSubmit storedHours={24} />), 'refund-window-save')).toMatch(/^<button type="submit"/);
  });
});

describe('screens wire the new confirmations', () => {
  it('suspension: the reason is required (≥10 trimmed) on the form, the action and the API', () => {
    expect(PLACEMENT_SUSPEND_NOTE_MIN_LENGTH).toBe(10);
    expect(isPlacementSuspendNoteValid('  kısa  ')).toBe(false);
    expect(isPlacementSuspendNoteValid('Şikâyet incelemesi')).toBe(true);
    const page = read('app/showcase/placements/[placementId]/page.tsx');
    expect(page).toMatch(/name="note"\s+required\s+minLength=\{PLACEMENT_SUSPEND_NOTE_MIN_LENGTH\}/);
    expect(page).toContain('proof="showcase.placement-suspend"');
    expect(page).toContain('Hizmet verene e-posta gitmez.');
    // Resume stays one press, with the end date it would produce.
    expect(page).toMatch(/<form action=\{resumeShowcasePlacementAction\}>[\s\S]*?placement-resume-end[\s\S]*?type="submit"/);
  });

  it('support: RESOLVED asks with its own proof, CLOSED keeps its dialog, IN_PROGRESS/OPEN stay direct', () => {
    const page = read('app/support/[id]/page.tsx');
    expect(page).toMatch(/next === 'RESOLVED' \? \([\s\S]*?proof="support.resolve"/);
    expect(page).toContain('proof="support.status"');
    expect(page).toContain('Talep sahibi artık bu talebe mesaj yazamaz.');
    expect(page).toContain('Geri dönüş yok');
  });

  it('review report: "Uygun bulundu" asks, counts every open report and says none can be reopened', () => {
    const page = read('app/provider-reviews/[reviewId]/page.tsx');
    expect(page).toContain('proof="provider-review.report-dismiss"');
    expect(page).toContain('Değerlendirme yayında kalır');
    expect(page).toContain('Geri açılamaz');
  });

  it('question: deactivating asks and says it is not deleted; activating stays direct', () => {
    const sections = read('app/categories/[slug]/category-sections.tsx');
    expect(sections).toContain('proof="question.deactivate"');
    expect(sections).toContain('Soru silinmez, pasif olur.');
    expect(sections).toMatch(/<button className="btn btn-secondary btn-sm" type="submit">\s*Aktifleştir/);
  });

  it('invite: revoking asks, issuing stays direct', () => {
    const panel = read('app/categories/provider-invite-panel.tsx');
    expect(panel).toContain('proof="provider-invite.revoke"');
    expect(panel).toContain('kalıcı olarak geçersiz olur');
    expect(panel).toMatch(/data-testid="provider-invite-create"/);
  });
});
