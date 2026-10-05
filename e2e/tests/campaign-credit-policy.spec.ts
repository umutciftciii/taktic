import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { seedActiveCampaign, seedGrantedLot } from '../src/campaign-fixtures';
import { confirmThrough, waitForHydration } from '../src/confirm-dialog';
import { createAdmin, createCategory, createProvider, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * CAMPAIGN-CREDIT-POLICY-001 — the credit policy end to end.
 *
 * 1. The builder offers "Kredi kullanım kuralları" with the demo defaults
 *    selected; a campaign saved with PAID_FIRST + ALLOW_PROMO carries both
 *    in its JSON and its columns, the detail shows them, and a revision to
 *    other rules is a new version while version 1 keeps its own.
 * 2. The provider credit screen splits the balance (paid, deductible
 *    campaign credit, protected campaign credit, deductible total); a
 *    deduction above the deductible total is stopped on the form, and one
 *    within it takes paid credit and the ALLOW_PROMO lot only — once, with
 *    its idempotency record.
 * 3. The provider sees each lot labelled by its own policy, in spend order,
 *    and no blanket "promotion is used first" sentence.
 */

const DAY = 86_400_000;

test.describe('campaign credit policy', () => {
  test('the builder saves both axes into the immutable version, and a revision is a new version', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const key = `e2e-kural-${Date.now().toString(36)}`;
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;
    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/campaigns/new');
      await assertNoErrorScreen(page);

      const policy = page.getByTestId('campaign-credit-policy');
      await expect(policy).toContainText('Kredi kullanım kuralları');
      await expect(policy).toContainText('Harcama önceliği');
      await expect(policy).toContainText('Yönetici kredi kesintisi');
      await expect(page.getByTestId('campaign-credit-policy-note')).toHaveText(
        'Kurallar bu kampanya sürümünün parçasıdır. Değişiklik yeni sürüm gerektirir; önceden verilen krediler eski sürüm kurallarını korur.',
      );
      await expect(page.getByTestId('campaign-spend-priority-PROMO_FIRST')).toBeChecked();
      await expect(page.getByTestId('campaign-admin-deduct-policy-PAID_ONLY')).toBeChecked();

      await page.locator('input[name="name"]').fill('E2E Kredi kuralı');
      await page.locator('input[name="key"]').fill(key);
      await page.getByTestId('campaign-credits').fill('10');
      await page.getByTestId('campaign-expires-in-days').fill('30');
      await page.getByTestId('campaign-spend-priority-PAID_FIRST').check();
      await page.getByTestId('campaign-admin-deduct-policy-ALLOW_PROMO').check();
      await expect(policy).toHaveAttribute('data-spend-priority', 'PAID_FIRST');
      await expect(policy).toHaveAttribute('data-admin-deduct-policy', 'ALLOW_PROMO');

      await page.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/\/campaigns\/[a-z0-9]+\?ok=created/);
      await assertNoErrorScreen(page);
      const campaign = await prisma().campaign.findUniqueOrThrow({ where: { key }, include: { versions: true } });
      const [v1] = campaign.versions;
      expect(v1).toMatchObject({ versionNumber: 1, spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' });
      expect(v1!.definition).toMatchObject({
        schemaVersion: 2,
        benefit: { creditPolicy: { spendPriority: 'PAID_FIRST', adminDeductPolicy: 'ALLOW_PROMO' } },
      });
      await expect(page.getByTestId('campaign-definition-spend-priority')).toHaveText('Önce ücretli kredi');
      await expect(page.getByTestId('campaign-definition-admin-deduct-policy')).toHaveText('Kampanya kredisinden de kesilebilir');
      const row1 = page.locator('[data-testid="campaign-version-row"][data-version="1"]');
      await expect(row1.getByTestId('campaign-version-spend-priority')).toHaveText('Önce ücretli kredi');

      // A revision with other rules: version 2; version 1 is untouched.
      const revise = page.getByTestId('campaign-form');
      await expect(revise.getByTestId('campaign-spend-priority-PAID_FIRST')).toBeChecked();
      await revise.getByTestId('campaign-spend-priority-PROMO_FIRST').check();
      await revise.getByTestId('campaign-admin-deduct-policy-PAID_ONLY').check();
      await revise.getByTestId('campaign-save').click();
      await expect(page).toHaveURL(/ok=revised&v=2/);
      await assertNoErrorScreen(page);
      const versions = await prisma().campaignVersion.findMany({ where: { campaignId: campaign.id }, orderBy: { versionNumber: 'asc' } });
      expect(versions.map((v) => [v.versionNumber, v.spendPriority, v.adminDeductPolicy])).toEqual([
        [1, 'PAID_FIRST', 'ALLOW_PROMO'],
        [2, 'PROMO_FIRST', 'PAID_ONLY'],
      ]);
      await expect(page.locator('[data-testid="campaign-version-row"][data-version="2"] [data-testid="campaign-version-admin-deduct-policy"]')).toHaveText(
        'Yalnız ücretli krediden',
      );
      await expect(row1.getByTestId('campaign-version-admin-deduct-policy')).toHaveText('Kampanya kredisinden de kesilebilir');
    } finally {
      await admin.close();
    }
  });

  test('the admin deduction is judged against the deductible total and leaves a PAID_ONLY lot whole', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Kural' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 3 });
    const protectedCampaign = await seedActiveCampaign(adminAccount.id, `e2e-korumali-${Date.now().toString(36)}`);
    const allowCampaign = await seedActiveCampaign(adminAccount.id, `e2e-kesilir-${Date.now().toString(36)}`, {
      spendPriority: 'PROMO_FIRST',
      adminDeductPolicy: 'ALLOW_PROMO',
    });
    const protectedLot = await seedGrantedLot(protectedCampaign, provider.id, 10);
    const allowLot = await seedGrantedLot(allowCampaign, provider.id, 4);

    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const page = admin.page;
    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin(`/providers/${provider.id}/credits`);
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('credits-fact-balance')).toContainText('17');
      await expect(page.getByTestId('credits-fact-paid')).toContainText('3');
      await expect(page.getByTestId('credits-fact-promo-deductible')).toContainText('4');
      await expect(page.getByTestId('credits-fact-promo-protected')).toContainText('10');
      await expect(page.getByTestId('credits-fact-deductible')).toContainText('7');

      const form = page.getByTestId('credit-operation-form');
      const deductTab = form.getByRole('tab', { name: 'Kredi düş' });
      await waitForHydration(deductTab);
      await deductTab.click();
      await expect(form.getByTestId('credit-operation-deductible')).toHaveText('7');
      await expect(form.getByTestId('credit-operation-key')).not.toHaveValue('');
      const key = await form.getByTestId('credit-operation-key').inputValue();

      await form.getByTestId('credit-operation-amount').fill('8');
      await form.getByTestId('credit-operation-reason').fill('E2E kural: fazla kesinti');
      await expect(form.getByTestId('credit-operation-exceeds-deductible')).toBeVisible();
      await expect(form.getByTestId('credit-operation-deduct')).toBeDisabled();

      await form.getByTestId('credit-operation-amount').fill('7');
      await expect(form.getByTestId('credit-operation-exceeds-deductible')).toHaveCount(0);
      await confirmThrough(form.getByTestId('credit-operation-deduct'), 'Evet, düş');
      await expect(page.getByTestId('credit-operation-done')).toHaveText('7 kredi düşüldü. Yeni bakiye 10.');

      const deducts = await prisma().providerCreditTransaction.findMany({ where: { providerId: provider.id, type: 'ADMIN_DEDUCT' } });
      expect(deducts).toHaveLength(1);
      const shares = await prisma().promoCreditLotConsumption.findMany({ where: { creditTransactionId: deducts[0]!.id } });
      expect(shares).toEqual([expect.objectContaining({ lotId: allowLot.lot.id, consumedCredits: 4, source: 'ADMIN_DEDUCT' })]);
      expect((await prisma().promoCreditLot.findUniqueOrThrow({ where: { id: protectedLot.lot.id } })).remainingCredits).toBe(10);
      expect(await prisma().manualCreditOperation.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({
        transactionId: deducts[0]!.id,
        requestedCredits: 7,
      });
      // A success draws a new key for the next operation.
      await expect(form.getByTestId('credit-operation-key')).not.toHaveValue(key);
      await expect(page.getByTestId('credits-fact-deductible')).toContainText('0');
    } finally {
      await admin.close();
    }
  });

  test('the provider sees each lot labelled by its own policy, in spend order', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Kural Web' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 2 });
    const paidFirst = await seedActiveCampaign(adminAccount.id, `e2e-sonra-${Date.now().toString(36)}`, {
      spendPriority: 'PAID_FIRST',
      adminDeductPolicy: 'PAID_ONLY',
    });
    const promoFirst = await seedActiveCampaign(adminAccount.id, `e2e-once-${Date.now().toString(36)}`);
    // The PAID_FIRST lot expires sooner, yet is spent after the PROMO_FIRST one.
    const late = await seedGrantedLot(paidFirst, provider.id, 5, 0, { expiresAt: new Date(Date.now() + 3 * DAY) });
    const early = await seedGrantedLot(promoFirst, provider.id, 4, 0, { expiresAt: new Date(Date.now() + 20 * DAY) });

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    const page = actor.page;
    try {
      await actor.loginToWeb(provider.email, provider.password);
      await actor.gotoWeb(`/providers/${provider.id}/credits`);
      await assertNoErrorScreen(page);
      const rows = page.getByTestId('promo-credits').getByTestId('promo-lot');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toHaveAttribute('data-lot', early.lot.id);
      await expect(rows.nth(0).getByTestId('promo-lot-priority')).toHaveText('Önce kullanılır');
      await expect(rows.nth(1)).toHaveAttribute('data-lot', late.lot.id);
      await expect(rows.nth(1).getByTestId('promo-lot-priority')).toHaveText('Ücretli krediden sonra kullanılır');
      await expect(page.getByTestId('promo-credits')).not.toContainText('teklif gönderirken önce kullanılır');
    } finally {
      await actor.close();
    }
  });
});
