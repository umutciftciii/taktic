import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createOfferPackage,
  createProvider,
  createStaffAdmin,
  createSupportTicket,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 / Faz 1: every signed-in screen still renders inside the new
 * shell.
 *
 * The redesign changed the stylesheet every one of the 52 screens reads and
 * the frame every one of them sits in, while converting none of their content.
 * So each one is opened once, as a super admin, at 1440px and at 390px. On all
 * of them: it is not the error screen, the shell is around it, and no part of
 * the shell is wider than the window. The content's own overflow is reported
 * with the elements causing it (see below), not asserted.
 *
 * Detail screens need a record. The ones this spec can make cheaply are made
 * here; the rest use whatever the suite has already created in this database,
 * and are listed as skipped (with the reason attached to the report) when a run
 * reaches this file before anything made one — a scan that pretended to open a
 * screen it did not is worse than one that says so.
 */

type Target = { route: string; path: string | null; why?: string };


const STATIC_ROUTES = [
  '/',
  '/requests',
  '/requests/reports',
  '/offers',
  '/providers',
  '/customers',
  '/support',
  '/finance',
  '/finance/credit-ledger',
  '/finance/manual-adjustments',
  '/finance/providers',
  '/package-purchases',
  '/package-refunds',
  '/refund-scan',
  '/showcase/reviews',
  '/showcase/placements',
  '/showcase/leads',
  '/showcase/cards',
  '/showcase/price-terms',
  '/showcase/packages',
  '/provider-reviews/reports',
  '/categories',
  '/categories/new',
  '/credit-packages',
  '/credit-packages/new',
  '/operations-settings',
  '/campaigns',
  '/campaigns/new',
  '/promotion-eligibility',
  '/notifications',
  '/users',
  '/users/new',
  '/roles',
  '/company-settings',
];

async function detailTargets(): Promise<Target[]> {
  const db = prisma();
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Tarama Müşteri');
  const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 5 });
  const request = await seedCustomerRequest({
    customerId: customer.id,
    categoryId: category.id,
    location: uniqueLocation(),
    content: 'full',
  });
  const ticket = await createSupportTicket({ requesterId: customer.id, status: 'OPEN' });
  const creditPackage = await createOfferPackage({ type: 'ONE_TIME_CREDITS' });
  // Off the provider's catalogue straight away: the admin detail opens an
  // inactive package just the same, and a live one would sit in every later
  // spec's package list (lemon-checkout expects exactly its own).
  await db.offerCreditPackage.update({ where: { id: creditPackage.id }, data: { isActive: false } });
  const staff = await createStaffAdmin(['DASHBOARD_READ']);
  const assignment = await db.adminRoleAssignment.findFirst({ where: { userId: staff.id }, select: { roleId: true } });

  // Whatever this database already holds, newest first where the table has a
  // creation time.
  const [offer, purchase, refund, version, placement, review, campaign, hold, notification] = await Promise.all([
    db.offer.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.packagePurchase.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.packageRefundRequest.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.showcaseCardVersion.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.showcasePlacement.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.providerReview.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.campaign.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
    db.promotionEligibilityHold.findFirst({ select: { triggerEventId: true } }),
    db.notificationLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }),
  ]);

  const existing = (route: string, id: string | undefined | null): Target =>
    id
      ? { route, path: route.replace(/\[[^\]]+\]/, id) }
      : { route, path: null, why: 'no such record in this database yet' };

  return [
    { route: '/requests/[id]', path: `/requests/${request.id}` },
    { route: '/providers/[id]', path: `/providers/${provider.id}` },
    { route: '/providers/[id]/credits', path: `/providers/${provider.id}/credits` },
    { route: '/customers/[id]', path: `/customers/${customer.id}` },
    { route: '/support/[id]', path: `/support/${ticket.id}` },
    { route: '/categories/[slug]', path: `/categories/${category.slug}` },
    { route: '/credit-packages/[id]', path: `/credit-packages/${creditPackage.id}` },
    { route: '/users/[id]', path: `/users/${staff.id}` },
    existing('/roles/[id]', assignment?.roleId),
    existing('/offers/[id]', offer?.id),
    existing('/package-purchases/[id]', purchase?.id),
    existing('/package-refunds/[id]', refund?.id),
    existing('/showcase/reviews/[versionId]', version?.id),
    existing('/showcase/placements/[placementId]', placement?.id),
    existing('/provider-reviews/[reviewId]', review?.id),
    existing('/campaigns/[id]', campaign?.id),
    existing('/promotion-eligibility/[eventId]', hold?.triggerEventId),
    existing('/notifications/[id]', notification?.id),
  ];
}

test.describe('admin route scan (ADMIN-DESIGN-001)', () => {
  test('all 52 signed-in screens render inside the shell at 1440px and 390px', async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const account = await createAdmin();
    const targets: Target[] = [...STATIC_ROUTES.map((route) => ({ route, path: route })), ...(await detailTargets())];
    expect(targets).toHaveLength(52);

    const skipped = targets.filter((target) => !target.path);
    console.log(`[admin-route-scan] opening ${targets.length - skipped.length}/52; skipped: ${skipped.map((target) => target.route).join(', ') || 'none'}`);
    if (skipped.length > 0) {
      testInfo.annotations.push({
        type: 'skipped-routes',
        description: skipped.map((target) => `${target.route} (${target.why})`).join(', '),
      });
    }

    const results: Array<{ route: string; width: number; overflow: number; culprits: string[] }> = [];

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const admin = await Actor.open(browser, `scan-${viewport.width}`, primaryRuntime, { viewport });
      try {
        await admin.loginToAdmin(account.email, account.password);
        for (const target of targets) {
          if (!target.path) continue;
          await admin.gotoAdmin(target.path);
          const label = `${target.route} @${viewport.width}`;
          await expect(admin.page, label).not.toHaveURL(/\/(yetkisiz|login)(\?|$)/);
          await assertNoErrorScreen(admin.page);
          await expect(admin.page.locator('.admin-shell'), label).toBeVisible();
          await expect(admin.page.locator('.admin-topbar'), label).toBeVisible();
          await expect(admin.page.getByRole('heading', { name: 'Kayıt bulunamadı' }), label).toHaveCount(0);
          // The shell itself never sticks out, whatever the screen inside it does.
          const shellRight = await admin.page.evaluate(() =>
            ['.admin-topbar', '.admin-main', '#admin-sidebar'].map((selector) => {
              const element = document.querySelector(selector);
              if (!element) return 0;
              const box = element.getBoundingClientRect();
              // A closed phone drawer sits off-screen to the left by design.
              return box.right <= 0 ? 0 : Math.round(box.right - window.innerWidth);
            }),
          );
          expect(Math.max(...shellRight), `${label}: shell wider than the window`).toBeLessThanOrEqual(0);
          const { overflow, culprits } = await admin.page.evaluate(() => {
            const limit = window.innerWidth;
            const found: string[] = [];
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
              const box = element.getBoundingClientRect();
              if (box.width === 0 || box.right <= limit + 1) continue;
              const parentStyle = element.parentElement ? getComputedStyle(element.parentElement) : null;
              if (parentStyle && ['auto', 'scroll', 'hidden'].includes(parentStyle.overflowX)) continue;
              const cls = typeof element.className === 'string' ? element.className.trim().split(/\s+/).join('.') : '';
              found.push(`${element.tagName.toLowerCase()}${cls ? `.${cls}` : ''} r=${Math.round(box.right)}`);
              if (found.length >= 4) break;
            }
            return { overflow: document.documentElement.scrollWidth - limit, culprits: found };
          });
          results.push({ route: target.route, width: viewport.width, overflow, culprits });
        }
      } finally {
        await admin.close();
      }
    }

    await testInfo.attach('route-scan.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    // Content overflow: reported, not asserted, at either width. What sticks
    // out is screen content with no scroll container of its own — a table, or
    // a filter <select> as wide as its longest option — so the amount depends
    // on the data the suite holds and on the platform's fonts (CI's Linux faces
    // are wider than a Mac's). The same overflow exists on main with main's
    // stylesheet, whose content column is 4px narrower than this one at 1440px.
    // It is Faz 2's job (shared list components); the shell's own part is
    // asserted above, on every screen, at both widths.
    const wide = results.filter((result) => result.overflow > 0);
    const summary = wide.map(
      (result) => `${result.route}@${result.width} +${result.overflow}px [${result.culprits.join(' ; ')}]`,
    );
    console.log(`[admin-route-scan] content overflow (Faz 2): ${summary.join(' | ') || 'none'}`);
    testInfo.annotations.push({ type: 'content overflow (Faz 2)', description: summary.join(' | ') || 'none' });
  });
});
