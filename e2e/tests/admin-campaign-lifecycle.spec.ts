import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, confirmThrough } from '../src/confirm-dialog';
import { createAdmin, prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * CMP-002 S2B2 — the campaign lifecycle screen, driven end to end.
 *
 * With the engine switch off (the E2E database's default, as in every real
 * environment today) the detail screen says in as many words that activation
 * is impossible and offers a disabled button; the API behind it refuses too.
 * The switch is then set directly on the test database's OperationsSettings
 * row — there is no screen or route that does it — and the same operator
 * activates version 1, pauses with a reason, resumes, activates a newer
 * version in place of the running one, and ends; every step is reflected in
 * the status badge, the version table and the audit trail, and no grant of
 * any kind exists at the end because no event was raised. The switch is put
 * back off in `finally`.
 */

const OPERATIONS_SETTINGS_ID = 'singleton';

async function setEngine(enabled: boolean) {
  await prisma().operationsSettings.upsert({
    where: { id: OPERATIONS_SETTINGS_ID },
    create: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: 48, campaignEngineEnabled: enabled },
    update: { campaignEngineEnabled: enabled },
  });
}

const K2 = {
  schemaVersion: 2,
  trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
  conditions: { all: [{ type: 'FIRST_SUCCESSFUL_PAID_PURCHASE' }, { type: 'NO_PRIOR_REVOCATION' }] },
  benefit: { type: 'PROMO_CREDITS', credits: 10, expiresInDays: 30, creditPolicy: { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' } },
  limits: { maxRedemptionsPerProvider: 1, maxRedemptionsGlobal: 1000, maxRedemptionsPerDay: null, budgetCredits: 10000 },
  window: { startAt: null, endAt: null },
  stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
  priority: 100,
};

/** A DRAFT campaign with one stored version, written the way the create route writes it. */
async function seedDraft(adminUserId: string, key: string) {
  const campaign = await prisma().campaign.create({ data: { key, name: `E2E yaşam döngüsü ${key}`, status: 'DRAFT', createdById: adminUserId } });
  const version = await prisma().campaignVersion.create({
    data: {
      campaignId: campaign.id,
      versionNumber: 1,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      eligibilityFacts: [],
      factSetKey: null,
      definition: K2,
      benefitType: 'PROMO_CREDITS',
      spendPriority: 'PROMO_FIRST',
      adminDeductPolicy: 'PAID_ONLY',
      benefitCredits: 10,
      benefitExpiresInDays: 30,
      maxRedemptionsPerProvider: 1,
      maxRedemptionsGlobal: 1000,
      maxRedemptionsPerDay: null,
      budgetCredits: 10000,
      windowStartAt: null,
      windowEndAt: null,
      stackPolicy: 'EXCLUSIVE_CREDIT_BONUS',
      priority: 100,
      createdById: adminUserId,
    },
  });
  await prisma().campaign.update({ where: { id: campaign.id }, data: { currentVersionId: version.id } });
  await prisma().campaignAuditLog.createMany({
    data: [
      { campaignId: campaign.id, action: 'CREATED', actorId: adminUserId },
      { campaignId: campaign.id, action: 'VERSION_CREATED', campaignVersionId: version.id, actorId: adminUserId, summary: { versionNumber: 1 } },
    ],
  });
  return { campaign, version };
}

test.describe('admin campaign lifecycle', () => {
  test('refuses activation while the engine is off, then runs DRAFT → ACTIVE → PAUSED → ACTIVE → ENDED once it is on', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const key = `e2e-yasam-dongusu-${Date.now().toString(36)}`;
    const { campaign, version } = await seedDraft(adminAccount.id, key);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await setEngine(false);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);

      // ---- engine off: the screen says so, the button is disabled, the API refuses ----
      await admin.gotoAdmin(`/campaigns/${campaign.id}`);
      await assertNoErrorScreen(page);
      const engineState = page.getByTestId('campaign-engine-state');
      await expect(engineState).toHaveAttribute('data-engine', 'off');
      await expect(engineState).toContainText('etkinleştirme yapılamaz');
      const panel = page.getByTestId('campaign-lifecycle-panel');
      await expect(panel).toHaveAttribute('data-status', 'DRAFT');
      await expect(page.getByTestId('campaign-lifecycle-engine-off')).toContainText('Kampanya motoru kapalı — etkinleştirme yapılamaz');
      await expect(page.getByTestId('campaign-activate')).toBeDisabled();
      await expect(page.getByTestId('campaign-pause')).toHaveCount(0);
      // A draft is closed, not "ended": no Sonlandır button, its own form instead.
      await expect(page.getByTestId('campaign-end')).toHaveCount(0);
      await expect(page.getByTestId('campaign-close-draft')).toBeEnabled();
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'DRAFT');

      // Forcing the form past the disabled button carries no confirmation
      // proof, so the action refuses it before the API is asked (Paket A);
      // the API's own CAMPAIGN_ENGINE_DISABLED is pinned in the API suite.
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-testid="campaign-activate"]');
        button?.closest('form')?.requestSubmit();
      });
      await expect(page.getByTestId('campaign-lifecycle-error')).toContainText('onay penceresinden onay alınamadı');
      expect((await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('DRAFT');
      expect(await prisma().campaignAuditLog.count({ where: { campaignId: campaign.id } })).toBe(2);

      // ---- engine on (set on the test database; no screen does this) ----
      await setEngine(true);
      await admin.gotoAdmin(`/campaigns/${campaign.id}`);
      await assertNoErrorScreen(page);
      await expect(engineState).toHaveAttribute('data-engine', 'on');
      await expect(page.getByTestId('campaign-lifecycle-engine-off')).toHaveCount(0);
      await expect(page.getByTestId('campaign-activate')).toBeEnabled();
      // A click before hydration reaches the action with no proof: refused,
      // nothing written (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
      await clickBeforeHydration(page, page.url(), page.getByTestId('campaign-activate'));
      await expect(page.getByTestId('campaign-lifecycle-error')).toContainText('onay penceresinden onay alınamadı');
      expect((await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('DRAFT');
      // The dialog names the version and its rule, and what activation starts.
      await confirmThrough(page.getByTestId('campaign-activate'), 'Evet, etkinleştir', async (activateDialog) => {
        await expect(activateDialog).toContainText('promosyon kredisi dağıtımı başlar');
        await expect(activateDialog).toContainText('otomatik geri alınmaz');
      });
      await expect(page).toHaveURL(/ok=activate/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ACTIVE');
      await expect(page.getByTestId('campaign-ok')).toContainText('etkinleştirildi');
      await expect(page.getByTestId('campaign-active-definition')).toBeVisible();
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="1"]')).toHaveAttribute('data-active', 'true');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="1"]')).toContainText('(çalışan)');
      await expect(page.getByTestId('campaign-audit')).toContainText('Sürüm etkinleştirildi');
      await expect(page.getByTestId('campaign-audit')).toContainText('Kampanya etkinleştirildi');
      expect(await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'ACTIVE', activeVersionId: version.id });
      // The running campaign has no activate button (nothing newer is stored) but can be paused and ended.
      await expect(page.getByTestId('campaign-activate')).toHaveCount(0);
      await expect(page.getByTestId('campaign-pause')).toBeVisible();
      await expect(page.getByTestId('campaign-end')).toBeVisible();
      await expect(page.getByTestId('campaign-close-draft')).toHaveCount(0);

      // ---- pause, with a reason ----
      await page.getByTestId('campaign-lifecycle-reason').fill('E2E: bütçe kontrolü');
      await confirmThrough(page.getByTestId('campaign-pause'), 'Evet, duraklat');
      await expect(page).toHaveURL(/ok=pause/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'PAUSED');
      await expect(page.getByTestId('campaign-audit')).toContainText('Kampanya duraklatıldı');
      await expect(page.getByTestId('campaign-audit')).toContainText('gerekçe: E2E: bütçe kontrolü');

      // ---- resume ----
      await page.getByTestId('campaign-lifecycle-reason').fill('E2E: kontrol bitti');
      await confirmThrough(page.getByTestId('campaign-resume'), 'Evet, devam ettir');
      await expect(page).toHaveURL(/ok=resume/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ACTIVE');
      await expect(page.getByTestId('campaign-audit')).toContainText('Kampanya devam ettirildi');

      // ---- a revision on the running campaign is stored, not run; activating it swaps ----
      const reviseForm = page.getByTestId('campaign-form');
      await reviseForm.getByTestId('campaign-credits').fill('15');
      await reviseForm.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/ok=revised&v=2/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ACTIVE');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="1"]')).toHaveAttribute('data-active', 'true');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="2"]')).toHaveAttribute('data-active', 'false');
      expect((await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).activeVersionId).toBe(version.id);
      await expect(page.getByTestId('campaign-activate')).toContainText('Sürüm 2');
      // The switch names old → new and only what changed.
      await confirmThrough(page.getByTestId('campaign-activate'), 'Evet, sürüme geç', async (switchDialog) => {
        await expect(switchDialog).toContainText('Sürüm 1 → 2');
        await expect(switchDialog.getByTestId('campaign-version-changes')).toContainText('10 promosyon kredisi');
        await expect(switchDialog.getByTestId('campaign-version-changes')).toContainText('15 promosyon kredisi');
      });
      await expect(page).toHaveURL(/ok=activate/);
      await assertNoErrorScreen(page);
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="2"]')).toHaveAttribute('data-active', 'true');
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="1"]')).toHaveAttribute('data-active', 'false');
      await expect(page.getByTestId('campaign-audit')).toContainText('(önceki: sürüm 1)');
      const v1 = await prisma().campaignVersion.findUniqueOrThrow({ where: { id: version.id } });
      expect(v1.benefitCredits).toBe(10);

      // ---- end: terminal ----
      await page.getByTestId('campaign-lifecycle-reason').fill('E2E: sonlandır');
      // Ending asks first (ADMIN-DESIGN-001 Faz 3E); "Vazgeç" writes nothing.
      await page.getByTestId('campaign-end').click();
      const endDialog = page.getByTestId('campaign-end-dialog');
      await expect(endDialog).toBeVisible();
      await expect(endDialog).toContainText('bir daha açılamaz');
      await endDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(endDialog).toBeHidden();
      expect((await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('ACTIVE');
      await page.getByTestId('campaign-end').click();
      await endDialog.getByRole('button', { name: 'Evet, sonlandır' }).click();
      await expect(page).toHaveURL(/ok=end/);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('campaign-status')).toHaveAttribute('data-status', 'ENDED');
      await expect(panel).toHaveAttribute('data-status', 'ENDED');
      await expect(page.getByTestId('campaign-activate')).toHaveCount(0);
      await expect(page.getByTestId('campaign-pause')).toHaveCount(0);
      await expect(page.getByTestId('campaign-resume')).toHaveCount(0);
      await expect(page.getByTestId('campaign-end')).toHaveCount(0);
      await expect(page.getByTestId('campaign-form')).toHaveCount(0);
      await expect(page.getByTestId('campaign-audit')).toContainText('Kampanya sonlandırıldı');

      // ---- the list reflects it; nothing was ever granted ----
      await admin.gotoAdmin('/campaigns');
      await assertNoErrorScreen(page);
      const row = page.locator(`[data-testid="campaign-row"][data-campaign-key="${key}"]`);
      await expect(row.getByTestId('campaign-row-status')).toHaveText('Sona erdi');
      expect(await prisma().campaignRedemption.count({ where: { campaignId: campaign.id } })).toBe(0);
      expect(await prisma().promoCreditLot.count()).toBe(0);
      expect(await prisma().providerCreditTransaction.count({ where: { type: { in: ['CAMPAIGN_GRANT', 'CAMPAIGN_EXPIRE', 'CAMPAIGN_REVOKE'] } } })).toBe(0);
      const actions = await prisma().campaignAuditLog.findMany({ where: { campaignId: campaign.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(actions.map((a) => a.action)).toEqual([
        'CREATED',
        'VERSION_CREATED',
        'VERSION_ACTIVATED',
        'ACTIVATED',
        'PAUSED',
        'RESUMED',
        'VERSION_CREATED',
        'VERSION_ACTIVATED',
        'ENDED',
      ]);
    } finally {
      await setEngine(false);
      await admin.close();
    }
  });

  test('a paused campaign resumed with a newer version asks for a reason and says PAUSED → ACTIVE (Paket A)', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const key = `e2e-yeni-surumle-${Date.now().toString(36)}`;
    const { campaign, version } = await seedDraft(adminAccount.id, key);
    // Running v1, paused, with a stored v2 that pays more — the state the
    // panel offers "Sürüm 2 ile devam ettir" in.
    const v2 = await prisma().campaignVersion.create({
      data: {
        ...(({ id: _id, createdAt: _at, ...rest }) => rest)(version),
        definition: { ...K2, benefit: { type: 'PROMO_CREDITS', credits: 20, expiresInDays: 30, creditPolicy: { spendPriority: 'PROMO_FIRST', adminDeductPolicy: 'PAID_ONLY' } } },
        versionNumber: 2,
        benefitCredits: 20,
      },
    });
    await prisma().campaign.update({
      where: { id: campaign.id },
      data: { status: 'PAUSED', activeVersionId: version.id, currentVersionId: v2.id },
    });
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;

    try {
      await setEngine(true);
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/campaigns/${campaign.id}`);
      await assertNoErrorScreen(page);
      const trigger = page.getByTestId('campaign-activate');
      await expect(trigger).toHaveText('Sürüm 2 ile devam ettir');

      // No reason: the browser refuses the form and no dialog opens.
      await trigger.click();
      await expect(page.getByTestId('campaign-activate-dialog')).toBeHidden();
      expect((await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PAUSED');

      await page.getByTestId('campaign-activate-reason').fill('E2E: yeni kuralla açılıyor');
      await confirmThrough(trigger, 'Evet, yeni sürümle devam ettir', async (dialog) => {
        await expect(dialog).toContainText('Duraklatıldı → Etkin');
        await expect(dialog).toContainText('20 promosyon kredisi');
        await expect(dialog).toContainText('promosyon kredisi dağıtımı yeniden başlar');
      });
      await expect(page).toHaveURL(/ok=activate/);
      await assertNoErrorScreen(page);
      expect(await prisma().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
        status: 'ACTIVE',
        activeVersionId: v2.id,
      });
      const resumed = await prisma().campaignAuditLog.findFirstOrThrow({ where: { campaignId: campaign.id, action: 'RESUMED' } });
      expect(resumed.summary).toMatchObject({ versionNumber: 2, reason: 'E2E: yeni kuralla açılıyor', fromStatus: 'PAUSED' });
      await expect(page.getByTestId('campaign-audit')).toContainText('gerekçe: E2E: yeni kuralla açılıyor');
    } finally {
      await setEngine(false);
      await prisma().campaign.update({ where: { id: campaign.id }, data: { status: 'ENDED' } });
      await admin.close();
    }
  });
});
