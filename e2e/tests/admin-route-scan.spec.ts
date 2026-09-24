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
 * So each one is opened once, as a super admin, at 1440px and at 390px, and
 * the same three things must hold on all of them: it is not the error screen,
 * the shell is around it, and the page is no wider than the window.
 *
 * Detail screens need a record. The ones this spec can make cheaply are made
 * here; the rest use whatever the suite has already created in this database,
 * and are listed as skipped (with the reason attached to the report) when a run
 * reaches this file before anything made one — a scan that pretended to open a
 * screen it did not is worse than one that says so.
 */

type Target = { route: string; path: string | null; why?: string };

/**
 * Screens that were already wider than a 390px phone before the redesign —
 * measured on main@0d679df3 with the same data, to the pixel — because a table
 * or a toolbar in their content has no scroll container of its own. That is
 * the content's defect and Faz 2's job (the shared list/table components); the
 * shell neither caused nor worsened it. Listed here so the scan still fails on
 * any *other* screen that starts to overflow, and so the list can only shrink:
 * a screen that stops overflowing is reported, not tolerated forever.
 */
const KNOWN_PHONE_OVERFLOW = new Set([
  '/finance',
  '/finance/credit-ledger',
  '/finance/manual-adjustments',
  '/finance/providers',
  '/notifications',
  '/notifications/[id]',
  '/users',
  '/users/[id]',
  '/customers/[id]',
  '/providers/[id]/credits',
]);

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

    const results: Array<{ route: string; width: number; overflow: number }> = [];

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
          const overflow = await admin.page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          results.push({ route: target.route, width: viewport.width, overflow });
        }
      } finally {
        await admin.close();
      }
    }

    await testInfo.attach('route-scan.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    const known = (result: (typeof results)[number]) =>
      result.width === 390 && KNOWN_PHONE_OVERFLOW.has(result.route);
    const wide = results.filter((result) => result.overflow > 0 && !known(result));
    expect(wide, `pages wider than the window: ${JSON.stringify(wide)}`).toEqual([]);

    const stillWide = results.filter((result) => result.overflow > 0 && known(result));
    console.log(`[admin-route-scan] known phone overflow (Faz 2): ${stillWide.map((result) => `${result.route} +${result.overflow}px`).join(', ') || 'none'}`);
    testInfo.annotations.push({
      type: 'known-phone-overflow (Faz 2)',
      description: stillWide.map((result) => `${result.route} +${result.overflow}px`).join(', ') || 'none',
    });
  });
});
