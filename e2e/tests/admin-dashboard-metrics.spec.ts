import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  createStaffAdmin,
  createSupportTicket,
  isAutoPublishEnabled,
  openReportCount,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { seedRequestReport } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * Genel görünüm (`/`) — ADMIN-DESIGN-001 Faz 3H, design `dashboard`.
 *
 * The rules asserted here, each against the real screen:
 *
 * - **No zero wears a colour.** Every queue cell and every KPI note: tone
 *   `warning` if and only if its number is positive. Checked across every
 *   one on the screen, so a cell added later cannot opt out.
 * - **A number opens exactly what it counted.** The support cell's number is
 *   the size of the list it opens and the same tickets; the application cell's
 *   number is the "İnceleme bekliyor" view's count and the database's; the
 *   report cell's number is the sum of the open queue's "Bildirim" column.
 * - **K2.** A queue cell, a KPI link and a header action exist only for a
 *   session that may open the page behind them; "Sistem şu anda ne yapıyor"
 *   only with OPERATIONS_SETTINGS_READ, and then it says what is stored.
 * - **K12.** No design element without a source is on the page.
 *
 * The badge rule itself is pinned in `apps/admin/test/dashboard-metrics.spec.ts`
 * and the screen's decisions in `apps/admin/test/dashboard-overview.spec.tsx`;
 * the backlog's definition in `apps/api/test/admin-dashboard-summary.spec.ts`.
 *
 * This file runs before `support-tickets.spec.ts` and before anything else that
 * opens a ticket, so the support cell genuinely starts at zero.
 */

const DESKTOP = { width: 1440, height: 900 } as const;

const SHOTS = resolve(artifactsDir, 'admin-design');
function shot(testInfo: TestInfo, name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  return resolve(SHOTS, `${testInfo.project.name}-${name}.png`);
}
const SUPPORT_CELL = '[data-testid="dashboard-queue"][data-metric="openSupportTickets"]';
const PROVIDER_CELL = '[data-testid="dashboard-queue"][data-metric="pendingProviders"]';
const REPORT_CELL = '[data-testid="dashboard-queue"][data-metric="reportedRequests"]';
const SHOWCASE_CELL = '[data-testid="dashboard-queue"][data-metric="pendingShowcaseReviews"]';

const BACKLOG = {
  openA: `Dashboard OPEN A ${Date.now()}`,
  openB: `Dashboard OPEN B ${Date.now()}`,
  inProgress: `Dashboard IN_PROGRESS ${Date.now()}`,
  resolved: `Dashboard RESOLVED ${Date.now()}`,
  closed: `Dashboard CLOSED ${Date.now()}`,
} as const;

/** "1.392" → 1392: the screen groups thousands the Turkish way. */
function count(text: string): number {
  return Number.parseInt(text.replace(/\./g, '').trim(), 10);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: the page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(0);
}

/** Every coloured-or-not number on the screen: queue cells and KPI notes. */
async function readToned(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="dashboard-queue"], [data-testid="dashboard-kpi-note"]'),
    ).map((element) => ({
      metric: element.dataset.metric ?? '',
      tone: element.dataset.tone ?? '',
      value: Number.parseInt(
        (
          element.querySelector('[data-testid="dashboard-queue-value"], strong')?.textContent ?? ''
        ).replace(/\./g, ''),
        10,
      ),
      href: element.getAttribute('href'),
    })),
  );
}

async function expectToneRule(page: Page) {
  for (const entry of await readToned(page)) {
    expect(Number.isFinite(entry.value), `"${entry.metric}" shows no number`).toBe(true);
    expect(entry.tone, `"${entry.metric}" shows ${entry.value}`).toBe(entry.value > 0 ? 'warning' : 'neutral');
  }
}

async function expectNoUnsourcedDesign(page: Page) {
  const main = page.locator('main');
  for (const absent of [
    'Son 7 gün',
    'Panelde son yapılanlar',
    'güncellendi',
    'Hızlı işlemler',
    'Geçen hafta',
  ]) {
    await expect(main.getByText(absent)).toHaveCount(0);
  }
  await expect(main.locator('svg polyline')).toHaveCount(0);
  await expect(page.getByTestId('stat-card')).toHaveCount(0);
}

test.describe('admin dashboard (Genel görünüm)', () => {
  test('a zero is silent, a backlog is not, and each queue opens exactly what it counted', async ({ browser }) => {
    test.setTimeout(120_000);
    const adminAccount = await createAdmin();
    const customerAccount = await createCustomer('E2E Destek Müşterisi');

    const admin = await Actor.open(browser, 'admin-dashboard', primaryRuntime, { viewport: DESKTOP });

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await admin.gotoAdmin('/');
      await assertNoErrorScreen(admin.page);

      // ---- the greeting: the account's own name, today's date -------------
      const firstName = (
        await prisma().user.findUniqueOrThrow({ where: { id: adminAccount.id }, select: { name: true } })
      ).name!.split(/\s+/)[0]!;
      await expect(admin.page.getByRole('heading', { level: 1 })).toHaveText(
        new RegExp(`^(Günaydın|İyi günler|İyi akşamlar|İyi geceler), ${firstName}$`),
      );
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
      await expect(admin.page.getByTestId('dashboard-date')).toHaveAttribute('datetime', today);

      // A super admin may open everything: four cells, four figures, the list.
      await expect(admin.page.getByTestId('dashboard-queue')).toHaveCount(4);
      await expect(admin.page.getByTestId('dashboard-kpi')).toHaveCount(4);
      await expect(admin.page.getByTestId('dashboard-system')).toBeVisible();
      await expect(admin.page.getByRole('link', { name: 'Talepleri incele' })).toHaveAttribute('href', '/requests');
      await expect(admin.page.locator('main').getByRole('link', { name: 'Operasyon ayarları', exact: true })).toHaveAttribute(
        'href',
        '/operations-settings',
      );
      await expectNoUnsourcedDesign(admin.page);
      await expectToneRule(admin.page);

      // ---- support: zero first ------------------------------------------
      const support = admin.page.locator(SUPPORT_CELL);
      await expect(support).toContainText('Açık destek talebi');
      await expect(support.getByTestId('dashboard-queue-value')).toHaveText('0');
      await expect(support).toHaveAttribute('data-tone', 'neutral');
      await expect(support).toHaveAttribute('href', '/support?status=OPEN,IN_PROGRESS');

      for (const [status, subject] of [
        ['OPEN', BACKLOG.openA],
        ['OPEN', BACKLOG.openB],
        ['IN_PROGRESS', BACKLOG.inProgress],
        ['RESOLVED', BACKLOG.resolved],
        ['CLOSED', BACKLOG.closed],
      ] as const) {
        await createSupportTicket({ requesterId: customerAccount.id, status, subject });
      }

      await admin.gotoAdmin('/');
      await expect(support.getByTestId('dashboard-queue-value')).toHaveText('3');
      await expect(support).toHaveAttribute('data-tone', 'warning');
      await expectToneRule(admin.page);

      await support.click();
      await expect(admin.page).toHaveURL(/\/support\?status=OPEN(,|%2C)IN_PROGRESS$/);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.locator('#support-status')).toHaveValue('OPEN,IN_PROGRESS');
      await expect(admin.page.getByTestId('support-ticket-count')).toHaveAttribute('data-total', '3');
      const rows = admin.page.getByTestId('support-ticket-row');
      for (const present of [BACKLOG.openA, BACKLOG.openB, BACKLOG.inProgress]) {
        await expect(rows.filter({ hasText: present })).toHaveCount(1);
      }
      for (const absent of [BACKLOG.resolved, BACKLOG.closed]) {
        await expect(rows.filter({ hasText: absent })).toHaveCount(0);
      }

      // ---- a waiting application, and one request reported twice ----------
      const location = uniqueLocation();
      const category = await createCategory(3);
      const applicant = await createProvider({ categoryId: category.id, location, credits: 0 });
      await prisma().providerProfile.update({ where: { id: applicant.id }, data: { status: 'PENDING_REVIEW' } });
      const reporterA = await createProvider({ categoryId: category.id, location, credits: 0 });
      const reporterB = await createProvider({ categoryId: category.id, location, credits: 0 });
      const reported = await seedCustomerRequest({
        customerId: customerAccount.id,
        categoryId: category.id,
        location,
        content: 'empty',
      });
      await seedRequestReport({ requestId: reported.id, reporterProviderId: reporterA.id });
      await seedRequestReport({ requestId: reported.id, reporterProviderId: reporterB.id });

      // ---- applications: the database, the cell and the view agree -------
      await admin.gotoAdmin('/');
      await expectToneRule(admin.page);
      const pendingInDb = await prisma().providerProfile.count({ where: { status: 'PENDING_REVIEW' } });
      expect(pendingInDb).toBeGreaterThan(0);
      const providers = admin.page.locator(PROVIDER_CELL);
      await expect(providers).toHaveAttribute('data-tone', 'warning');
      await expect(providers.getByTestId('dashboard-queue-value')).toHaveText(String(pendingInDb));
      await providers.click();
      await expect(admin.page).toHaveURL(/\/providers\?status=PENDING_REVIEW$/);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.locator('#provider-status')).toHaveValue('PENDING_REVIEW');
      await expect(admin.page.getByTestId('provider-view-pending_review')).toContainText(String(pendingInDb));
      for (const status of await admin.page
        .getByTestId('provider-row')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status))) {
        expect(status).toBe('PENDING_REVIEW');
      }

      // ---- reports: counted per request, as the queue lists them ----------
      // (API-DASHBOARD-REQUEST-REPORT-COUNT-001: two reports on one request is 1.)
      await admin.gotoAdmin('/');
      const openReports = await openReportCount();
      const reportedRequests = (
        await prisma().serviceRequestReport.groupBy({ by: ['requestId'], where: { resolvedAt: null } })
      ).length;
      // The request reported twice makes reports outnumber reported requests.
      expect(openReports).toBeGreaterThan(reportedRequests);
      expect(reportedRequests).toBeGreaterThanOrEqual(1);
      const reports = admin.page.locator(REPORT_CELL);
      await expect(reports).toContainText('Karar bekleyen şikayetli talep');
      await expect(reports.getByTestId('dashboard-queue-value')).toHaveText(String(reportedRequests));
      await expect(reports).toHaveAttribute('data-tone', 'warning');
      await reports.click();
      await expect(admin.page).toHaveURL(/\/requests\/reports\?state=open$/);
      await assertNoErrorScreen(admin.page);
      // The queue's own total is the cell's number.
      await expect(admin.page.getByTestId('report-view-open')).toContainText(String(reportedRequests));
      // Two reports on one request: one row, whose "Bildirim" column reads 2.
      const reportedRow = admin.page.locator(
        `[data-testid="report-queue-row"][data-request-id="${reported.id}"]`,
      );
      await expect(reportedRow).toHaveCount(1);
      await expect(reportedRow.getByTestId('report-count')).toHaveText('2');
      if (
        (await admin.page.getByTestId('pagination-next').evaluate((node) => node.tagName)) !== 'A'
      ) {
        // One page: one row per counted request, and the "Bildirim" column adds up to the reports.
        await expect(admin.page.getByTestId('report-queue-row')).toHaveCount(reportedRequests);
        const perRow = await admin.page.getByTestId('report-count').allInnerTexts();
        expect(perRow.reduce((sum, text) => sum + count(text), 0)).toBe(openReports);
      }

      // ---- vitrin: the cell is the review queue's length ------------------
      await admin.gotoAdmin('/');
      const pendingVersions = await prisma().showcaseCardVersion.count({ where: { reviewStatus: 'PENDING' } });
      const showcase = admin.page.locator(SHOWCASE_CELL);
      await expect(showcase).toContainText('Onay bekleyen vitrin kartı');
      await expect(showcase.getByTestId('dashboard-queue-value')).toHaveText(String(pendingVersions));
      await expect(showcase).toHaveAttribute('data-tone', pendingVersions > 0 ? 'warning' : 'neutral');
      await expect(showcase).toHaveAttribute('href', '/showcase/reviews');
      await showcase.click();
      await expect(admin.page).toHaveURL(/\/showcase\/reviews$/);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('showcase-review-row')).toHaveCount(pendingVersions);

      // ---- KPI notes open the status views they count --------------------
      await admin.gotoAdmin('/');
      const pendingRequests = admin.page.locator('[data-testid="dashboard-kpi-note"][data-metric="pendingRequests"]');
      await expect(pendingRequests).toHaveAttribute('href', '/requests?status=SUBMITTED');
      const submittedInDb = await prisma().serviceRequest.count({ where: { status: 'SUBMITTED' } });
      await expect(pendingRequests.locator('strong')).toHaveText(String(submittedInDb));
      await pendingRequests.click();
      await expect(admin.page).toHaveURL(/\/requests\?status=SUBMITTED$/);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('request-view-submitted')).toContainText(String(submittedInDb));

      // ---- the system list says what is stored ---------------------------
      await admin.gotoAdmin('/');
      const autoPublish = admin.page.locator('[data-testid="dashboard-activity"][data-key="auto-publish"]');
      await expect(autoPublish.getByTestId('dashboard-activity-state')).toHaveText(
        (await isAutoPublishEnabled()) ? 'Açık' : 'Kapalı',
      );
    } finally {
      await admin.close();
    }
  });

  test('K2: a staff account sees only the queues, links and system list its role opens', async ({ browser }) => {
    const bare = await createStaffAdmin(['DASHBOARD_READ']);
    const support = await createStaffAdmin(['DASHBOARD_READ', 'SUPPORT_READ']);
    const operations = await createStaffAdmin(['DASHBOARD_READ', 'OPERATIONS_SETTINGS_READ', 'REQUESTS_READ']);

    const actor = await Actor.open(browser, 'admin-dashboard-k2', primaryRuntime, { viewport: DESKTOP });
    try {
      // DASHBOARD_READ alone: the four figures, as plain numbers, and nothing else.
      await actor.loginToAdmin(bare.email, bare.password);
      await actor.gotoAdmin('/');
      await assertNoErrorScreen(actor.page);
      await expect(actor.page.getByTestId('dashboard-kpi')).toHaveCount(4);
      await expect(actor.page.getByTestId('dashboard-queues')).toHaveCount(0);
      await expect(actor.page.getByTestId('dashboard-system')).toHaveCount(0);
      await expect(actor.page.locator('main a')).toHaveCount(0);
      await expect(actor.page.getByText('Talepleri incele')).toHaveCount(0);
      await expectToneRule(actor.page);
      await expectNoUnsourcedDesign(actor.page);
      await actor.close();

      // SUPPORT_READ: the support cell only.
      const supportActor = await Actor.open(browser, 'admin-dashboard-k2-support', primaryRuntime, { viewport: DESKTOP });
      try {
        await supportActor.loginToAdmin(support.email, support.password);
        await supportActor.gotoAdmin('/');
        await assertNoErrorScreen(supportActor.page);
        const cells = supportActor.page.getByTestId('dashboard-queue');
        await expect(cells).toHaveCount(1);
        await expect(cells.first()).toHaveAttribute('data-metric', 'openSupportTickets');
        await expect(supportActor.page.getByTestId('dashboard-system')).toHaveCount(0);
        await cells.first().click();
        await expect(supportActor.page).toHaveURL(/\/support\?status=OPEN(,|%2C)IN_PROGRESS$/);
        await assertNoErrorScreen(supportActor.page);
      } finally {
        await supportActor.close();
      }

      // OPERATIONS_SETTINGS_READ + REQUESTS_READ: the system list and both header actions, no queue.
      const opsActor = await Actor.open(browser, 'admin-dashboard-k2-ops', primaryRuntime, { viewport: DESKTOP });
      try {
        await opsActor.loginToAdmin(operations.email, operations.password);
        await opsActor.gotoAdmin('/');
        await assertNoErrorScreen(opsActor.page);
        await expect(opsActor.page.getByTestId('dashboard-queues')).toHaveCount(0);
        await expect(opsActor.page.getByTestId('dashboard-system')).toBeVisible();
        await expect(opsActor.page.getByRole('link', { name: 'Talepleri incele' })).toBeVisible();
        await expect(
          opsActor.page.locator('[data-testid="dashboard-activity"][data-key="auto-publish"]').getByTestId(
            'dashboard-activity-state',
          ),
        ).toHaveText((await isAutoPublishEnabled()) ? 'Açık' : 'Kapalı');
        // The offers figure's note points at the refund scan, which this role cannot open.
        await expect(
          opsActor.page.locator('[data-testid="dashboard-kpi-note"][data-metric="refundableOffers"]'),
        ).not.toHaveAttribute('href', /.*/);
        await expect(
          opsActor.page.locator('[data-testid="dashboard-kpi-note"][data-metric="pendingRequests"]'),
        ).toHaveAttribute('href', '/requests?status=SUBMITTED');
        await opsActor.page.getByTestId('dashboard-system').getByRole('link', { name: 'Operasyon ayarlarını aç' }).click();
        await expect(opsActor.page).toHaveURL(/\/operations-settings$/);
        await assertNoErrorScreen(opsActor.page);
      } finally {
        await opsActor.close();
      }
    } finally {
      await actor.close().catch(() => undefined);
    }
  });

  test('fits 320, 390, 768 and 1440 without widening the page', async ({ browser }, testInfo) => {
    const adminAccount = await createAdmin();
    const admin = await Actor.open(browser, 'admin-dashboard-viewports', primaryRuntime, { viewport: DESKTOP });

    try {
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      for (const width of [320, 390, 768, 1440]) {
        await admin.page.setViewportSize({ width, height: 900 });
        await admin.gotoAdmin('/');
        await assertNoErrorScreen(admin.page);
        await expect(admin.page.getByTestId('dashboard-queue').first()).toBeVisible();
        await expectNoHorizontalOverflow(admin.page, `dashboard @${width}`);
        await admin.page.screenshot({ path: shot(testInfo, `dashboard-${width}`), fullPage: true });

        const boxes = await admin.page
          .locator('[data-testid="dashboard-queue"], [data-testid="dashboard-kpi"], [data-testid="dashboard-activity"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = node.getBoundingClientRect();
              return { left: Math.round(rect.left), right: Math.round(rect.right) };
            }),
          );
        expect(boxes.length).toBeGreaterThan(7);
        for (const box of boxes) {
          expect(box.left, `@${width}: a block starts off the left edge`).toBeGreaterThanOrEqual(-1);
          expect(box.right, `@${width}: a block ends past the right edge`).toBeLessThanOrEqual(width + 1);
        }

        // The ⓘ opens inside the window and closes on Esc.
        const trigger = admin.page.getByTestId('dashboard-queues').getByRole('button', { name: 'Bu kutular neyi sayıyor?' });
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await expectNoHorizontalOverflow(admin.page, `dashboard ⓘ @${width}`);
        await admin.page.keyboard.press('Escape');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      }

      // 1440: four queues in one row, four figures in one row.
      const tops = async (selector: string) =>
        new Set(
          await admin.page
            .locator(selector)
            .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top))),
        ).size;
      expect(await tops('[data-testid="dashboard-queue"]')).toBe(1);
      expect(await tops('[data-testid="dashboard-kpi"]')).toBe(1);
    } finally {
      await admin.close();
    }
  });

  test('a customer is never shown the admin dashboard, signed in or not', async ({ browser }) => {
    const customerAccount = await createCustomer('E2E Yetkisiz');

    const anonymous = await Actor.open(browser, 'admin-dashboard-anon', primaryRuntime);
    const customer = await Actor.open(browser, 'admin-dashboard-customer', primaryRuntime);

    try {
      await anonymous.gotoAdmin('/');
      await expect(anonymous.page).toHaveURL(/\/login/);
      await expect(anonymous.page.getByTestId('dashboard-kpi')).toHaveCount(0);

      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await customer.gotoAdmin('/');
      await expect(customer.page).toHaveURL(/\/login/);
      await expect(customer.page.getByTestId('dashboard-kpi')).toHaveCount(0);
      await expect(customer.page.getByText('Açık destek talebi')).toHaveCount(0);
    } finally {
      await anonymous.close();
      await customer.close();
    }
  });
});
