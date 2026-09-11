/**
 * Which routes bring their own panel chrome.
 *
 * The root layout renders the public header and footer around every page, and
 * a panel screen draws its own sidebar and topbar instead. Those two used to
 * meet in CSS: `.app-shell:has(.cdash-shell) > .lp-header { display: none }`
 * removed the public header from view on a panel route and left the markup
 * where it was. The header carries an account menu and a "Çıkış yap" button, so
 * every panel screen shipped a second control for each — 0×0, inert, and ahead
 * of the real one in document order. Anything that reaches for the account menu
 * by its accessible name found the dead one first, which is how signing out
 * became unreachable through the normal path.
 *
 * A page cannot tell the layout above it what it is going to render, so the one
 * thing the layout can ask is which route it is serving. That is what this file
 * answers, and the answer has to be exact rather than a prefix: `/providers` and
 * `/requests` each hold both panel screens and public ones, and hiding the
 * header on `/providers/register` would be the same defect pointing the other
 * way.
 *
 * The two lists below are checked against the app directory itself by
 * `test/panel-routes.spec.ts`, which walks every `page.tsx`, works out whether
 * it renders a panel shell, and fails if this file disagrees. A route added,
 * moved or converted without updating this list is a failing unit test rather
 * than a defect somebody has to notice on a phone.
 */

/**
 * The routes whose page renders a panel shell. `:name` matches exactly one
 * path segment, the way the app directory's `[name]` does.
 */
const PANEL_ROUTES = [
  '/account/profile',
  '/account/password',
  '/destek',
  '/destek/yeni',
  '/destek/:ticketId',
  '/mesajlar',
  '/mesajlar/:threadId',
  '/mesajlar/talep/:requestId',
  '/providers/me',
  '/providers/:id',
  '/providers/:id/edit',
  '/providers/:id/credits',
  '/providers/:id/subscriptions',
  '/providers/:id/offers',
  '/providers/:id/offers/:offerId',
  '/providers/:id/requests',
  '/providers/:id/requests/:requestId',
  '/providers/:id/package-purchases',
  '/providers/:id/package-purchases/:purchaseId',
  '/providers/:id/package-purchases/:purchaseId/checkout',
  '/providers/:id/vitrin',
  // Static before dynamic, exactly as Next resolves it: `/vitrin/yeni` is the
  // new-card form and `/vitrin/:cardId` is an existing card. Both draw the
  // provider panel, so the order matters here only for readability.
  '/providers/:id/vitrin/yeni',
  // The shop and the screen after paying. Both static, both ahead of `:cardId`.
  '/providers/:id/vitrin/paketler',
  '/providers/:id/vitrin/odeme/:purchaseId',
  '/providers/:id/vitrin/:cardId',
  // Same precedence rule one line up: `talepler` is the lead inbox and comes
  // before `:cardId` would ever be consulted for it.
  '/providers/:id/vitrin/talepler',
  '/providers/:id/vitrin/talepler/:leadId',
  '/requests/my',
  '/requests/offers',
  '/requests/matches',
  '/requests/:id/offers',
  '/requests/:id/offers/:offerId',
  // The customer's answer after a vitrin lead's deadline passed. A panel screen
  // rather than a public one, and deliberately: releasing a request to the
  // whole market is irreversible, so it lives behind the ordinary customer
  // session rather than behind a link.
  '/requests/:id/vitrin-karar',
] as const;

/**
 * Public screens that a dynamic pattern above would otherwise swallow.
 *
 * Next resolves `/providers/register` to the static folder rather than to
 * `[id]`, and this list is how the same precedence is stated here. Without it a
 * visitor filling in the provider application would lose the site header, which
 * is the only navigation that screen has.
 */
const PUBLIC_ROUTES = [
  '/providers/register',
  '/providers/success',
  '/requests/success',
  /*
   * One vitrin card, as a visitor meets it.
   *
   * Genuinely public: it is the page a placement is bought to put in front of
   * people who have never signed in, and it carries the form they write to the
   * business with. It needs the site header for the same reason the provider
   * application does — that navigation is the only navigation it has.
   *
   * No dynamic pattern above swallows it today; it is listed because this file
   * is the statement of which screens are public, and a route absent from both
   * lists is a route nobody decided about.
   */
  '/vitrin/:cardId',
  /*
   * The vitrin discovery surface: the same shelf, narrowed by province.
   *
   * The home page's shelf no longer asks for a location — it shows every live
   * card, because that is what a business bought. Narrowing did not stop being
   * useful, though, so it lives here, where it is the point of the screen
   * rather than a gate in front of one.
   */
  '/vitrin',
] as const;

/**
 * Whether the page at this path draws its own panel chrome, and so must not be
 * given the public header and footer as well.
 *
 * A path that matches nothing — a 404, a link that has gone stale — is not a
 * panel route, so an unknown URL keeps the site header and the way out that
 * comes with it.
 */
export function isPanelRoute(pathname: string): boolean {
  const segments = toSegments(pathname);
  const path = `/${segments.join('/')}`;

  if ((PUBLIC_ROUTES as readonly string[]).includes(path)) {
    return false;
  }

  return PANEL_ROUTES.some((route) => matches(toSegments(route), segments));
}

/** Path segments, with the empty ones a leading or trailing slash leaves behind. */
function toSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function matches(route: string[], segments: string[]): boolean {
  if (route.length !== segments.length) return false;

  return route.every((segment, index) => {
    const actual = segments[index];
    if (actual === undefined) return false;
    return segment.startsWith(':') ? true : segment === actual;
  });
}

/** Exported for the test that keeps these lists honest against the app directory. */
export const PANEL_ROUTE_PATTERNS: readonly string[] = PANEL_ROUTES;
export const PUBLIC_ROUTE_OVERRIDES: readonly string[] = PUBLIC_ROUTES;
