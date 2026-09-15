import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createAdmin, createCustomer, prisma } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The scheduled-jobs panel, end to end.
 *
 * The API suite proves the rules — fail-closed defaults, the audit trail, the
 * roles, and that a switch really reaches each job's cron handler. What is
 * proved here is the part only a browser can answer: that a super admin can
 * find the panel, read what each job does before deciding, flip one switch and
 * see both the new state and the record of who flipped it — and that the
 * screen fits on a 320px phone while doing it.
 *
 * Nothing here waits for a cron. The binding between the switch and the tick is
 * asserted where it can be asserted honestly: the stored setting, which is the
 * single thing every job re-reads when it wakes up.
 */

/** The switch is off in the shipped state, so this is what the panel opens on. */
const JOB_KEYS = [
  'entitlement-renewal',
  'unviewed-offer-refund',
  'request-expiry',
  'request-reminder',
] as const;

/** The settings column each key is stored in — the API's own mapping. */
const JOB_SETTINGS: Record<(typeof JOB_KEYS)[number], string> = {
  'entitlement-renewal': 'entitlementRenewalSchedulerEnabled',
  'unviewed-offer-refund': 'unviewedOfferRefundSchedulerEnabled',
  'request-expiry': 'requestExpirySchedulerEnabled',
  'request-reminder': 'requestReminderSchedulerEnabled',
};

/**
 * The panel's own state, put back to the shipped one.
 *
 * The suite truncates once per run rather than between cases, and these
 * switches are global: a case that left one on would change what the next case
 * — or a retry of this one — opens on. Reset here rather than only cleaned up
 * at the end, so a failure mid-case cannot cascade into the next.
 */
async function resetSchedulerSettings(): Promise<void> {
  await prisma().operationsSettingsChange.deleteMany({
    where: { setting: { in: Object.values(JOB_SETTINGS) } },
  });
  await prisma().operationsSettings.updateMany({
    where: { id: 'singleton' },
    data: {
      entitlementRenewalSchedulerEnabled: false,
      unviewedOfferRefundSchedulerEnabled: false,
      requestExpirySchedulerEnabled: false,
      requestReminderSchedulerEnabled: false,
    },
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** What the running API will read on its next tick, straight from the database. */
async function storedFlag(job: (typeof JOB_KEYS)[number]): Promise<boolean> {
  const row = await prisma().operationsSettings.findUnique({ where: { id: 'singleton' } });
  return row ? Boolean((row as unknown as Record<string, boolean>)[JOB_SETTINGS[job]]) : false;
}

test.describe('scheduled jobs', () => {
  test.beforeEach(async () => {
    await resetSchedulerSettings();
  });

  test('the super admin switches a job on and off, and the trail records it', async ({
    browser,
  }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/operations-settings');
      await expect(admin.page.getByRole('heading', { name: 'Zamanlanmış İşler' })).toBeVisible();

      // ---- the shipped state: four jobs, all off ------------------------
      for (const job of JOB_KEYS) {
        const toggle = admin.page.getByTestId(`scheduler-toggle-${job}`);
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expect(admin.page.getByTestId(`scheduler-state-${job}`)).toHaveText('Kapalı');
        expect(await storedFlag(job)).toBe(false);
      }

      // The two money jobs say what they will start, before the switch moves.
      await expect(
        admin.page.getByTestId('scheduler-unviewed-offer-refund'),
      ).toContainText('kredi hareketi üretir');
      await expect(
        admin.page.getByTestId('scheduler-entitlement-renewal'),
      ).toContainText('para hareketi üretir');
      // The two that only close requests and send mail carry no such warning.
      await expect(admin.page.getByTestId('scheduler-request-expiry')).not.toContainText(
        'para hareketi üretir',
      );

      // The schedule is shown and cannot be edited from here.
      const expiryCard = admin.page.getByTestId('scheduler-request-expiry');
      await expect(expiryCard).toContainText('cron');
      await expect(expiryCard.locator('input:not([type="hidden"])')).toHaveCount(0);

      // ---- one switch on -----------------------------------------------
      await admin.page.getByTestId('scheduler-toggle-request-expiry').click();
      await expect(admin.page.getByTestId('scheduler-toggle-request-expiry')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(admin.page.getByTestId('scheduler-state-request-expiry')).toHaveText('Açık');
      await assertNoErrorScreen(admin.page);

      // What the next tick of that job will read. The others are untouched:
      // the four switches are independent.
      expect(await storedFlag('request-expiry')).toBe(true);
      expect(await storedFlag('request-reminder')).toBe(false);
      expect(await storedFlag('unviewed-offer-refund')).toBe(false);
      expect(await storedFlag('entitlement-renewal')).toBe(false);

      // ---- and the trail says who ---------------------------------------
      const audit = admin.page.getByTestId('scheduler-audit');
      await expect(audit).toContainText('Talep süresi dolum işi');
      await expect(audit).toContainText(adminAccount.name);
      await expect(audit.locator('tbody tr')).toHaveCount(1);

      // ---- off again ----------------------------------------------------
      await admin.page.getByTestId('scheduler-toggle-request-expiry').click();
      await expect(admin.page.getByTestId('scheduler-toggle-request-expiry')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(await storedFlag('request-expiry')).toBe(false);
      await expect(audit.locator('tbody tr')).toHaveCount(2);

      // A refresh is not a decision: re-reading the screen adds no third row.
      await admin.page.reload();
      await expect(
        admin.page.getByTestId('scheduler-audit').locator('tbody tr'),
      ).toHaveCount(2);
    } finally {
      await admin.close();
    }
  });

  test('the panel fits a 320px phone', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime, {
      viewport: { width: 320, height: 640 },
    });

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/operations-settings');

      await expect(admin.page.getByTestId('scheduler-list')).toBeVisible();
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);

      // The switch is still a control a thumb can hit at this width.
      const toggle = admin.page.getByTestId('scheduler-toggle-request-reminder');
      const box = await toggle.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);

      await toggle.click();
      await expect(
        admin.page.getByTestId('scheduler-toggle-request-reminder'),
      ).toHaveAttribute('aria-checked', 'true');
      expect(await storedFlag('request-reminder')).toBe(true);
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);

      // Left as it was found: a switch this suite turned on must not survive
      // into another spec's fixtures.
      await admin.page.getByTestId('scheduler-toggle-request-reminder').click();
      await expect(
        admin.page.getByTestId('scheduler-toggle-request-reminder'),
      ).toHaveAttribute('aria-checked', 'false');
    } finally {
      await admin.close();
    }
  });

  test('a customer reaches neither the screen nor the endpoint', async ({ browser }) => {
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);

      // The admin app sends a non-operator to its own sign-in screen rather
      // than rendering the panel.
      await customer.gotoAdmin('/operations-settings');
      await expect(customer.page).toHaveURL(/\/login/);
      await expect(customer.page.getByTestId('scheduler-list')).toHaveCount(0);

      // And the API refuses the same session directly, both ways.
      const listed = await customer.page.request.get(
        `${primaryRuntime.apiUrl}/operations-settings/schedulers`,
      );
      expect(listed.status()).toBe(403);

      const toggled = await customer.page.request.put(
        `${primaryRuntime.apiUrl}/operations-settings/schedulers/request-expiry`,
        { data: { enabled: true } },
      );
      expect(toggled.status()).toBe(403);

      expect(await storedFlag('request-expiry')).toBe(false);
    } finally {
      await customer.close();
    }
  });

  test('the rest of the operations screen still works', async ({ browser }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/operations-settings');

      await admin.page
        .getByTestId('operations-settings-form')
        .locator('input[name="unviewedOfferRefundWindowHours"]')
        .fill('72');
      await admin.page.getByRole('button', { name: 'Kaydet' }).click();
      await assertNoErrorScreen(admin.page);

      await expect(admin.page.getByTestId('operations-settings-notice')).toContainText('72 saat');
      // The window's own audit panel holds its change, and the jobs' panel is
      // untouched by it: the two share a table and must not share a list.
      await expect(
        admin.page.getByTestId('operations-settings-audit').locator('tbody tr'),
      ).toHaveCount(1);
      // The two panels share one table and must not share a list: the window's
      // change belongs to the window's panel, and the jobs' panel — untouched
      // by this save — still reports that nothing has been switched.
      await expect(admin.page.getByTestId('scheduler-audit')).toHaveCount(0);
      await expect(admin.page.getByTestId('scheduler-audit-empty')).toBeVisible();

      // Saving a commercial term switches nothing on.
      for (const job of JOB_KEYS) {
        expect(await storedFlag(job)).toBe(false);
      }

      // And the dashboard behind it is unaffected.
      await admin.gotoAdmin('/');
      await assertNoErrorScreen(admin.page);
    } finally {
      await admin.close();
    }
  });
});

/**
 * The provider-review switch on the same screen: the same `role="switch"`
 * contract as the jobs above, on its own row of the settings table.
 *
 * What is asserted is what the API will read on the next review request —
 * the stored flag — and that the trail records the operator by name. What
 * the switch *does* is the review flow spec's subject.
 */
test.describe('provider reviews switch', () => {
  async function resetProviderReviews(): Promise<void> {
    await prisma().operationsSettingsChange.deleteMany({
      where: { setting: 'providerReviewsEnabled' },
    });
    await prisma().operationsSettings.updateMany({
      where: { id: 'singleton' },
      data: { providerReviewsEnabled: false },
    });
  }

  async function storedReviewFlag(): Promise<boolean> {
    const row = await prisma().operationsSettings.findUnique({
      where: { id: 'singleton' },
      select: { providerReviewsEnabled: true },
    });
    return row?.providerReviewsEnabled ?? false;
  }

  test.beforeEach(async () => {
    await resetProviderReviews();
  });

  test.afterEach(async () => {
    await resetProviderReviews();
  });

  test('is off by default; the super admin switches it on and off and the trail records it', async ({
    browser,
  }) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin', primaryRuntime);

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/operations-settings');

      // ---- the shipped state: off, with no change on record --------------
      const card = admin.page.getByTestId('provider-reviews');
      await expect(card).toBeVisible();
      await expect(card).toContainText('en az üç değerlendirme');
      await expect(admin.page.getByTestId('provider-reviews-toggle')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      await expect(admin.page.getByTestId('provider-reviews-state')).toHaveText('Kapalı');
      await expect(admin.page.getByTestId('provider-reviews-audit-empty')).toBeVisible();
      expect(await storedReviewFlag()).toBe(false);

      // ---- on ---------------------------------------------------------------
      await admin.page.getByTestId('provider-reviews-toggle').click();
      await expect(admin.page.getByTestId('provider-reviews-toggle')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(admin.page.getByTestId('provider-reviews-state')).toHaveText('Açık');
      await assertNoErrorScreen(admin.page);
      expect(await storedReviewFlag()).toBe(true);

      // The other switches on the screen are untouched.
      await expect(admin.page.getByTestId('auto-publish-toggle')).toHaveAttribute('aria-checked', 'false');
      for (const job of JOB_KEYS) {
        expect(await storedFlag(job)).toBe(false);
      }

      // ---- the trail says who -------------------------------------------------
      const audit = admin.page.getByTestId('provider-reviews-audit');
      await expect(audit.locator('tbody tr')).toHaveCount(1);
      await expect(audit).toContainText(adminAccount.name);
      await expect(audit).toContainText('varsayılan (kapalı)');

      // ---- off again --------------------------------------------------------
      await admin.page.getByTestId('provider-reviews-toggle').click();
      await expect(admin.page.getByTestId('provider-reviews-toggle')).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(await storedReviewFlag()).toBe(false);
      await expect(admin.page.getByTestId('provider-reviews-audit').locator('tbody tr')).toHaveCount(2);

      // A refresh is not a decision: re-reading the screen adds no third row.
      await admin.page.reload();
      await expect(admin.page.getByTestId('provider-reviews-audit').locator('tbody tr')).toHaveCount(2);
      expect(await horizontalOverflow(admin.page)).toBeLessThanOrEqual(0);
    } finally {
      await admin.close();
    }
  });

  test('a customer reaches neither the card nor the endpoint', async ({ browser }) => {
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoAdmin('/operations-settings');
      await expect(customer.page).toHaveURL(/\/login/);
      await expect(customer.page.getByTestId('provider-reviews-toggle')).toHaveCount(0);

      const response = await customer.page.request.put(
        `${primaryRuntime.apiUrl}/operations-settings/provider-reviews`,
        { data: { enabled: true } },
      );
      expect([401, 403]).toContain(response.status());
      expect(await storedReviewFlag()).toBe(false);
    } finally {
      await customer.close();
    }
  });
});
