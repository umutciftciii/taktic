import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createStaffAdmin, prisma, uniqueSuffix } from '../src/fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 3E — kampanyalar, uygunluk incelemesi ve operasyon
 * ayarları: /campaigns, /campaigns/new, /campaigns/[id],
 * /promotion-eligibility, /promotion-eligibility/[eventId] and
 * /operations-settings, through the real Next screens against the real API.
 *
 * The per-flow specs already drive every write on these screens and their new
 * dialogs (admin-campaign-drafts / -lifecycle / -operations / -channel /
 * -engine-toggle, scheduler-settings, request-auto-publish,
 * provider-business-registration). What this one pins is the part the
 * redesign could quietly break:
 *
 * - Every control is behind the permission its own API route asks for, and a
 *   session without it sees the state, not the control: CAMPAIGNS_WRITE (new
 *   draft, revision), CAMPAIGNS_LIFECYCLE (activate/pause/resume/end/close),
 *   OPERATIONS_SETTINGS_WRITE, MARKETPLACE_PUBLISH_WRITE,
 *   PROVIDER_REVIEWS_SETTING_WRITE, SCHEDULERS_WRITE, CAMPAIGN_ENGINE_TOGGLE.
 * - The settings screen draws only the settings that exist, keeps all five
 *   change lists, and has no shared "save changes" bar.
 * - No page is wider than the window at 320, 390, 768, 1024, 1280 and 1440,
 *   with a long campaign name and key.
 */

const SCREENS_DIR = resolve(artifactsDir, 'faz-3e-screens');
const WIDTHS = [320, 390, 768, 1024, 1280, 1440];
const SETTING_CONTROLS = [
  'operations-settings-form',
  'auto-publish-toggle',
  'provider-reviews-toggle',
  'campaign-engine-submit',
  'scheduler-toggle-request-expiry',
] as const;

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  // The design package's width, so the captures compare one to one.
  await actor.page.setViewportSize({ width: 1440, height: 1617 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page overflow`).toBeLessThanOrEqual(1);
}

async function capture(page: Page, name: string) {
  const project = test.info().project.name;
  mkdirSync(SCREENS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: resolve(SCREENS_DIR, `${project}-${name}-${width}.png`) });
}

/** A DRAFT with one stored version, written the way the create route writes it. */
async function seedDraft(name?: string) {
  const owner = await createAdmin();
  const key = `e2e-faz3e-${uniqueSuffix()}`;
  const definition = {
    schemaVersion: 1,
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }] },
    benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30 },
    limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: null, maxRedemptionsPerDay: null, budgetCredits: null },
    window: { startAt: null, endAt: null },
    stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
    priority: 100,
  };
  const campaign = await prisma().campaign.create({
    data: { key, name: name ?? `E2E Faz 3E ${key}`, status: 'DRAFT', createdById: owner.id },
  });
  const version = await prisma().campaignVersion.create({
    data: {
      campaignId: campaign.id,
      versionNumber: 1,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      eligibilityFacts: [],
      factSetKey: null,
      definition,
      benefitType: 'PROMO_CREDITS',
      benefitCredits: 10,
      benefitExpiresInDays: 30,
      maxRedemptionsPerProvider: 1,
      maxRedemptionsGlobal: null,
      maxRedemptionsPerDay: null,
      budgetCredits: null,
      windowStartAt: null,
      windowEndAt: null,
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: 100,
      createdById: owner.id,
    },
  });
  await prisma().campaign.update({ where: { id: campaign.id }, data: { currentVersionId: version.id } });
  await prisma().campaignAuditLog.createMany({
    data: [
      { campaignId: campaign.id, action: 'CREATED', actorId: owner.id },
      { campaignId: campaign.id, action: 'VERSION_CREATED', campaignVersionId: version.id, actorId: owner.id, summary: { versionNumber: 1 } },
    ],
  });
  return { ...campaign, key };
}

test.describe('ADMIN-DESIGN-001 Faz 3E — campaigns, eligibility and operations settings', () => {
  test('campaign controls follow CAMPAIGNS_WRITE and CAMPAIGNS_LIFECYCLE', async ({ browser }) => {
    const draft = await seedDraft();
    const reader = await openAs(browser, ['CAMPAIGNS_READ']);
    const lifecycle = await openAs(browser, ['CAMPAIGNS_READ', 'CAMPAIGNS_LIFECYCLE']);
    const writer = await openAs(browser, ['CAMPAIGNS_READ', 'CAMPAIGNS_WRITE', 'OPERATIONS_SETTINGS_READ']);

    try {
      // ---- read only: the list and the record, no control at all ----------
      let page = reader.actor.page;
      await reader.actor.gotoAdmin('/campaigns');
      await expectOpen(page, /\/campaigns$/);
      await expect(page.getByTestId('campaign-questions')).toContainText('Bir kampanya üç sorudan oluşur');
      await expect(page.getByTestId('campaign-new-link')).toHaveCount(0);
      // No OPERATIONS_SETTINGS_READ: the callout names the screen but links nowhere.
      await expect(page.getByTestId('campaign-engine-settings-link')).toHaveCount(0);
      await expect(page.locator('main a[href^="/operations-settings"]')).toHaveCount(0);
      await expect(page.locator(`[data-testid="campaign-row"][data-campaign-key="${draft.key}"]`)).toContainText('Taslak');

      await reader.actor.gotoAdmin(`/campaigns/${draft.id}`);
      await expectOpen(page, new RegExp(`/campaigns/${draft.id}$`));
      await expect(page.getByTestId('campaign-lifecycle-panel')).toBeVisible();
      await expect(page.getByTestId('campaign-lifecycle-panel').locator('button')).toHaveCount(0);
      await expect(page.getByTestId('campaign-form')).toHaveCount(0);
      await expect(page.getByTestId('campaign-header')).toContainText(draft.key);

      await reader.actor.gotoAdmin('/campaigns/new');
      await expect(page).toHaveURL(/\/yetkisiz/);

      // ---- lifecycle without write: the moves, not the revision form -------
      page = lifecycle.actor.page;
      await lifecycle.actor.gotoAdmin(`/campaigns/${draft.id}`);
      await expectOpen(page, new RegExp(`/campaigns/${draft.id}$`));
      await expect(page.getByTestId('campaign-close-draft')).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(page.getByTestId('campaign-activate')).toBeVisible();
      await expect(page.getByTestId('campaign-form')).toHaveCount(0);

      // ---- write: new draft and revision; the callout links to the settings ----
      page = writer.actor.page;
      await writer.actor.gotoAdmin('/campaigns');
      await expectOpen(page, /\/campaigns$/);
      await expect(page.getByTestId('campaign-new-link')).toHaveText('Yeni kampanya yaz');
      await expect(page.getByTestId('campaign-engine-settings-link')).toHaveAttribute('href', '/operations-settings#kampanya-motoru');
      await writer.actor.gotoAdmin(`/campaigns/${draft.id}`);
      await expect(page.getByTestId('campaign-form')).toBeVisible();
      await expect(page.getByTestId('campaign-lifecycle-panel').locator('button')).toHaveCount(0);
      await writer.actor.gotoAdmin('/campaigns/new');
      await expectOpen(page, /\/campaigns\/new$/);
      for (const step of ['1 · Kimi kapsıyor', '2 · Ne veriyor', '3 · Ne zaman duruyor']) {
        await expect(page.getByTestId('campaign-form')).toContainText(step);
      }
      expect(await prisma().campaign.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'DRAFT' });
    } finally {
      await Promise.all([reader.actor.close(), lifecycle.actor.close(), writer.actor.close()]);
    }
  });

  test('each setting is gated by its own write permission; no shared save bar', async ({ browser }) => {
    const reader = await openAs(browser, ['OPERATIONS_SETTINGS_READ']);
    const schedulers = await openAs(browser, ['OPERATIONS_SETTINGS_READ', 'SCHEDULERS_WRITE']);
    const engine = await openAs(browser, ['OPERATIONS_SETTINGS_READ', 'CAMPAIGN_ENGINE_TOGGLE']);

    try {
      // ---- read only: every state, every change list, no control ----------
      let page = reader.actor.page;
      await reader.actor.gotoAdmin('/operations-settings');
      await expectOpen(page, /\/operations-settings$/);
      for (const testId of SETTING_CONTROLS) {
        await expect(page.getByTestId(testId), testId).toHaveCount(0);
      }
      await expect(page.getByTestId('operations-settings-readonly')).toBeVisible();
      await expect(page.getByTestId('campaign-engine-toggle-forbidden')).toBeVisible();
      for (const state of ['auto-publish-state', 'provider-reviews-state', 'campaign-engine-state', 'scheduler-state-request-expiry']) {
        await expect(page.getByTestId(state)).toHaveText(/^(Açık|Kapalı)$/);
      }
      // The five change lists, each either its table or its empty sentence.
      const lists = page.locator('#neler-oldu .settings-audit');
      await expect(lists).toHaveCount(5);
      // Only real settings: none of the design's rows that are not settings here.
      const main = page.locator('main');
      for (const absent of ['kaç gün yayında kalsın', 'kaçıncı günde', 'kaç krediye mal olsun', 'en fazla kaç teklif', 'tekrar teklif verebilsin']) {
        await expect(main).not.toContainText(absent);
      }
      await expect(page.getByRole('button', { name: /değişiklikleri kaydet/i })).toHaveCount(0);
      await capture(page, 'operasyon-ayarlari-salt-okunur');

      // ---- SCHEDULERS_WRITE: the jobs' switches and nothing else -----------
      page = schedulers.actor.page;
      await schedulers.actor.gotoAdmin('/operations-settings');
      await expectOpen(page, /\/operations-settings$/);
      await expect(page.getByTestId('scheduler-toggle-request-expiry')).toBeVisible();
      for (const testId of SETTING_CONTROLS.filter((id) => !id.startsWith('scheduler-'))) {
        await expect(page.getByTestId(testId), testId).toHaveCount(0);
      }

      // ---- CAMPAIGN_ENGINE_TOGGLE: the engine switch and nothing else ------
      page = engine.actor.page;
      await engine.actor.gotoAdmin('/operations-settings');
      await expectOpen(page, /\/operations-settings$/);
      await expect(page.getByTestId('campaign-engine-submit')).toHaveAttribute('role', 'switch');
      await expect(page.getByTestId('campaign-engine-toggle-forbidden')).toHaveCount(0);
      for (const testId of SETTING_CONTROLS.filter((id) => id !== 'campaign-engine-submit')) {
        await expect(page.getByTestId(testId), testId).toHaveCount(0);
      }
    } finally {
      await Promise.all([reader.actor.close(), schedulers.actor.close(), engine.actor.close()]);
    }
  });

  test('the eligibility queue is its own permission, with saved views', async ({ browser }) => {
    const reviewer = await openAs(browser, ['PROMOTION_ELIGIBILITY_REVIEW']);
    try {
      const page = reviewer.actor.page;
      await reviewer.actor.gotoAdmin('/promotion-eligibility');
      await expectOpen(page, /\/promotion-eligibility$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kampanya uygunluk incelemesi');
      await expect(page.getByTestId('eligibility-view-open')).toHaveAttribute('aria-current', 'page');
      await page.getByTestId('eligibility-view-decided').click();
      await expect(page).toHaveURL(/filter=decided/);
      await expect(page.getByTestId('eligibility-view-decided')).toHaveAttribute('aria-current', 'page');
      await reviewer.actor.gotoAdmin('/campaigns');
      await expect(page).toHaveURL(/\/yetkisiz/);
    } finally {
      await reviewer.actor.close();
    }
  });

  test('no screen is wider than the window, from 320 to 1440', async ({ browser }) => {
    test.setTimeout(300_000);
    const draft = await seedDraft(`E2E Faz 3E çok uzun bir kampanya adı ${'uzunkelime'.repeat(8)} ve açıklaması`);
    const hold = await prisma().promotionEligibilityHold.findFirst({ select: { triggerEventId: true } });
    const admin = await openAs(browser, 'super');
    const page = admin.actor.page;
    const paths: Array<[string, string]> = [
      ['kampanyalar', '/campaigns'],
      ['yeni-kampanya', '/campaigns/new'],
      ['kampanya-detayi', `/campaigns/${draft.id}`],
      ['uygunluk-incelemesi', '/promotion-eligibility'],
      ['operasyon-ayarlari', '/operations-settings'],
    ];
    if (hold) paths.push(['uygunluk-detayi', `/promotion-eligibility/${hold.triggerEventId}`]);

    try {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width === 1440 ? 1617 : 900 });
        for (const [name, path] of paths) {
          await admin.actor.gotoAdmin(path);
          await expectOpen(page, new RegExp(path.replace(/[?]/g, '\\?') + '$'));
          await expectNoPageOverflow(page, `${path} @${width}`);
          if (width === 1440 || width === 320) await capture(page, name);
        }
      }

      // The dialogs, at the design's width: closing a draft and opening a job.
      await page.setViewportSize({ width: 1440, height: 1617 });
      await admin.actor.gotoAdmin(`/campaigns/${draft.id}`);
      await page.getByTestId('campaign-close-draft-reason').fill('E2E: ekran görüntüsü');
      await page.getByTestId('campaign-close-draft').click();
      await expect(page.getByTestId('campaign-close-draft-dialog')).toBeVisible();
      await capture(page, 'taslak-kapat-diyalogu');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('campaign-close-draft-dialog')).toBeHidden();

      await admin.actor.gotoAdmin('/operations-settings');
      const job = page.getByTestId('scheduler-toggle-entitlement-renewal');
      if ((await job.getAttribute('aria-checked')) === 'false') {
        await job.click();
        const dialog = page.getByTestId('scheduler-toggle-entitlement-renewal-dialog');
        await expect(dialog).toContainText('para hareketi üretir');
        await capture(page, 'is-acma-diyalogu');
        await dialog.getByRole('button', { name: 'Kapat' }).click();
        await expect(dialog).toBeHidden();
      }
      // Nothing above confirmed anything.
      expect(await prisma().campaign.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'DRAFT' });
    } finally {
      await admin.actor.close();
    }
  });
});
