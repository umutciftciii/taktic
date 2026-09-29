import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { primaryRuntime, repoRoot } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 / Faz 1: every signed-in screen still renders inside the new
 * shell.
 *
 * The redesign changed the stylesheet every one of the 52 screens reads and
 * the frame every one of them sits in, while converting none of their content.
 * So each one is opened once, as a super admin, at 1440px and at 390px — and
 * every screen a Faz 2/3 slice converted (CONVERTED_ROUTES) at 320px as well —
 * and two separate rules are enforced:
 *
 * 1. Shell overflow is a hard failure, on every route, with no allowlist:
 *    html, body, the shell, the sidebar, the top bar, the main column and the
 *    content column all sit inside the window.
 * 2. Content overflow — the page as a whole wider than the window because of
 *    something inside a screen — fails everywhere except the (route, width)
 *    pairs in KNOWN_CONTENT_OVERFLOW below, which is empty since Faz 2.
 *
 * The route list is read from every page.tsx under apps/admin/app at run time, so a new screen
 * cannot slip past the scan: it fails until it is given a target here.
 *
 * Detail screens need a record. The ones this spec can make cheaply are made
 * here; the rest use whatever the suite has already created in this database,
 * and are listed as skipped (with the reason attached to the report) when a run
 * reaches this file before anything made one — a scan that pretended to open a
 * screen it did not is worse than one that says so.
 */

type Target = { route: string; path: string | null; why?: string };

/**
 * Content overflow that is still tolerated, per route and width — nothing else
 * is.
 *
 * Faz 1 recorded fourteen pairs here: thirteen screens at 390px and
 * /finance/providers at 1440px, each one a table without a scroll container,
 * a filter <select> as wide as its longest option or a stat card holding one
 * unbreakable word. Faz 2 fixed all three causes where they start
 * (apps/admin/app/globals.css, "Content overflow, fixed where it starts"), so
 * the list is empty and every screen is held to the same rule as the shell:
 * the page is never wider than the window.
 *
 * Should a pair ever have to come back, `observed` is the largest overflow seen
 * on CI (Linux fonts, full-suite data) and the ceiling is observed × 1.25 +
 * 40px — a guard against growth, not a licence. Raising a ceiling to make this
 * pass is not a fix.
 */
const KNOWN_CONTENT_OVERFLOW: Record<string, { width: number; observed: number }[]> = {};

function contentCeiling(route: string, width: number): number | null {
  const known = KNOWN_CONTENT_OVERFLOW[route]?.find((entry) => entry.width === width);
  return known ? Math.ceil(known.observed * 1.25) + 40 : null;
}

/** Reached without a session, or the refusal itself: outside the shell. */
const OUTSIDE_THE_SHELL = ['/login', '/admin-invite', '/yetkisiz'];

/** Every page.tsx under apps/admin/app, as a route pattern. */
function routesOnDisk(dir = resolve(repoRoot, 'apps/admin/app'), prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...routesOnDisk(resolve(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      found.push(prefix === '' ? '/' : prefix);
    }
  }
  return found;
}

type Measurement = {
  /** Shell boxes outside the window: hard failures, no allowlist. */
  shell: string[];
  /** How much wider than the window the document is. */
  overflow: number;
  /** The content elements sticking out, outside any scroll container. */
  culprits: string[];
};


/** Screens a Faz 2/3 slice has converted; each is scanned at 320px as well. */
const CONVERTED_ROUTES = [
  '/notifications',
  '/requests',
  '/requests/[id]',
  '/requests/reports',
  '/offers',
  '/offers/[id]',
  '/refund-scan',
  '/customers',
  '/customers/[id]',
  '/support',
  '/support/[id]',
  '/providers',
  '/providers/[id]',
  '/providers/[id]/credits',
  '/provider-reviews/reports',
  '/provider-reviews/[reviewId]',
  '/showcase/reviews',
  '/showcase/reviews/[versionId]',
  '/showcase/cards',
  '/showcase/leads',
  '/showcase/packages',
  '/showcase/price-terms',
  '/showcase/placements',
  '/showcase/placements/[placementId]',
];

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
  test('all 52 signed-in screens render inside the shell at 1440px and 390px (and the converted screens at 320px)', async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    const account = await createAdmin();
    const targets: Target[] = [...STATIC_ROUTES.map((route) => ({ route, path: route })), ...(await detailTargets())];
    expect(targets).toHaveLength(52);
    // A new screen fails here until it has a target — and so is scanned.
    const onDisk = routesOnDisk().filter((route) => !OUTSIDE_THE_SHELL.includes(route)).sort();
    expect(onDisk, 'signed-in routes on disk vs. routes this scan opens').toEqual(
      targets.map((target) => target.route).sort(),
    );

    const skipped = targets.filter((target) => !target.path);
    console.log(`[admin-route-scan] opening ${targets.length - skipped.length}/52; skipped: ${skipped.map((target) => target.route).join(', ') || 'none'}`);
    if (skipped.length > 0) {
      testInfo.annotations.push({
        type: 'skipped-routes',
        description: skipped.map((target) => `${target.route} (${target.why})`).join(', '),
      });
    }

    const results: Array<{ route: string; width: number } & Measurement> = [];

    // Every screen at the two widths Faz 1 set, and each screen a later slice
    // converted — the Faz 2 reference list, the six Faz 3A screens — at the
    // narrowest phone the panel supports.
    const passes: Array<{ viewport: { width: number; height: number }; only?: string[] }> = [
      { viewport: { width: 1440, height: 900 } },
      { viewport: { width: 390, height: 844 } },
      { viewport: { width: 320, height: 740 }, only: CONVERTED_ROUTES },
    ];

    for (const { viewport, only } of passes) {
      const admin = await Actor.open(browser, `scan-${viewport.width}`, primaryRuntime, { viewport });
      try {
        await admin.loginToAdmin(account.email, account.password);
        for (const target of targets) {
          if (!target.path) continue;
          if (only && !only.includes(target.route)) continue;
          await admin.gotoAdmin(target.path);
          const label = `${target.route} @${viewport.width}`;
          await expect(admin.page, label).not.toHaveURL(/\/(yetkisiz|login)(\?|$)/);
          await assertNoErrorScreen(admin.page);
          await expect(admin.page.locator('.admin-shell'), label).toBeVisible();
          await expect(admin.page.locator('.admin-topbar'), label).toBeVisible();
          await expect(admin.page.getByRole('heading', { name: 'Kayıt bulunamadı' }), label).toHaveCount(0);

          const measured = await admin.page.evaluate((): Measurement => {
            const limit = window.innerWidth;
            const shell: string[] = [];
            const boxes: Array<[string, Element | null]> = [
              ['html', document.documentElement],
              ['body', document.body],
              ['.admin-shell', document.querySelector('.admin-shell')],
              ['#admin-sidebar', document.getElementById('admin-sidebar')],
              ['.admin-topbar', document.querySelector('.admin-topbar')],
              ['.admin-main', document.querySelector('.admin-main')],
              ['.admin-content', document.querySelector('.admin-content')],
            ];
            for (const [name, element] of boxes) {
              if (!element) {
                shell.push(`${name} missing`);
                continue;
              }
              const box = element.getBoundingClientRect();
              // A closed phone drawer is parked off-screen to the left on purpose.
              // Same 1px tolerance as the rule below: at 320px the drawer is
              // 86vw (275.2px) wide and WebKit parks its right edge a fraction
              // of a pixel past 0.
              if (name === '#admin-sidebar' && box.right <= 1) continue;
              if (box.left < -1 || box.right > limit + 1) {
                shell.push(`${name} [${Math.round(box.left)}, ${Math.round(box.right)}]`);
              }
            }

            const shellElements = new Set(boxes.map(([, element]) => element));
            const culprits: string[] = [];
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
              if (shellElements.has(element)) continue;
              const box = element.getBoundingClientRect();
              if (box.width === 0 || box.right <= limit + 1) continue;
              // Anything inside its own horizontal scroll container is contained.
              let contained = false;
              for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                if (shellElements.has(parent)) break;
                if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) {
                  contained = true;
                  break;
                }
              }
              if (contained) continue;
              const cls = typeof element.className === 'string' ? element.className.trim().split(/\s+/).join('.') : '';
              culprits.push(`${element.tagName.toLowerCase()}${cls ? `.${cls}` : ''} r=${Math.round(box.right)}`);
              if (culprits.length >= 4) break;
            }

            return { shell, overflow: document.documentElement.scrollWidth - limit, culprits };
          });

          // Rule 1: the shell never sticks out. Every route, both widths, no allowlist.
          expect(measured.shell, `${label}: shell outside the window`).toEqual([]);
          results.push({ route: target.route, width: viewport.width, ...measured });
        }
      } finally {
        await admin.close();
      }
    }

    await testInfo.attach('route-scan.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });

    // Rule 2: content overflow — only on a known (route, width), and only up to
    // its ceiling.
    const wide = results.filter((result) => result.overflow > 0);
    const describe = (result: (typeof results)[number]) =>
      `${result.route}@${result.width} +${result.overflow}px [${result.culprits.join(' ; ')}]`;
    const unknown = wide.filter((result) => contentCeiling(result.route, result.width) === null);
    const grown = wide.filter((result) => {
      const ceiling = contentCeiling(result.route, result.width);
      return ceiling !== null && result.overflow > ceiling;
    });
    const tolerated = wide.filter((result) => !unknown.includes(result) && !grown.includes(result));

    const summary = tolerated.map(
      (result) => `${describe(result)} ≤ ${contentCeiling(result.route, result.width)}`,
    );
    console.log(`[admin-route-scan] tolerated content overflow: ${summary.join(' | ') || 'none'}`);
    testInfo.annotations.push({ type: 'tolerated content overflow', description: summary.join(' | ') || 'none' });

    expect.soft(unknown.map(describe), 'content overflow on a route/width not in KNOWN_CONTENT_OVERFLOW').toEqual([]);
    expect.soft(
      grown.map((result) => `${describe(result)} > ceiling ${contentCeiling(result.route, result.width)}`),
      'known content overflow grew past its ceiling',
    ).toEqual([]);
  });
});
