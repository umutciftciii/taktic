import { expect, type Page, type Response } from '@playwright/test';

/**
 * Runs `act` — whatever submits a server action that answers with
 * `redirect()` — and returns once the browser has landed on that redirect.
 *
 * Why a test needs this: the next `goto` can start while Next is still
 * navigating to the redirect, and on WebKit that `goto` then fails with
 * "Navigation to X is interrupted by another navigation to <target>". WebKit
 * fails every fetch in flight the moment a document navigation starts
 * ("TypeError: Load failed"); Next answers a failed navigation fetch with
 * "Falling back to browser navigation" — `location.href = target` — and that
 * navigation cancels the `goto`. Chromium keeps the fetch alive until the new
 * document commits, so only the webkit project sees it.
 *
 * What is still in flight depends on where the redirect goes (Next 15 app
 * router, read from its server-action reducer and redirect boundary):
 *
 * - **Another path** (`/categories/new` → `/categories/<slug>`): the action's
 *   response carries the target's tree, the router commits it and pushes the
 *   URL. The page that submitted is unmounted with the old tree, so nothing
 *   else happens: the URL reaching the target is the landing.
 * - **The same path** (a save that redirects to the page it is on, with or
 *   without `?ok=saved`): the action's tree commits, the submitting page stays
 *   mounted, and the redirect the action promise rejects with reaches that
 *   page's redirect boundary — which navigates to the target again. The action
 *   called `revalidatePath`, so the router cache is empty and that navigation
 *   fetches the target's RSC payload. The URL is right before it starts, a
 *   database write lands before the action even answers, and
 *   `waitForLoadState('networkidle')` returns at once because the state was
 *   reached long before — none of them says the navigation is over. Its commit
 *   does: the router writes history once it has applied the payload, and from
 *   then on a failed fetch can no longer send it to the fallback. If the fetch
 *   fails first, the fallback's document load is the landing.
 *
 * The fetch and the commit are read inside the page, which is marked before
 * `act` runs. Playwright's network events cannot say it: Chromium reports
 * Next's RSC fetch as failed once the router stops reading its stream, and can
 * report the action's response after the request that follows it.
 */
export async function settleActionRedirect(
  page: Page,
  act: () => Promise<unknown>,
  { timeout = 20_000 }: { timeout?: number } = {},
): Promise<void> {
  const before = new URL(page.url());
  let target: URL | undefined;
  let documentLoaded = false;
  const onResponse = (response: Response) => {
    const redirect = response.headers()['x-action-redirect'];
    if (target || !redirect || !response.request().headers()['next-action']) return;
    target = new URL(redirect.split(';')[0]!, response.url());
  };
  const onDomContentLoaded = () => {
    documentLoaded = true;
  };

  await page.evaluate(markRouterTraffic);
  page.on('response', onResponse);
  page.on('domcontentloaded', onDomContentLoaded);
  try {
    await act();
    await expect
      .poll(() => target?.href, {
        message: 'a server action answering with x-action-redirect',
        timeout,
      })
      .toBeDefined();
    const landing = target!;
    if (landing.pathname !== before.pathname) {
      await expect(page).toHaveURL(landing.href, { timeout });
      return;
    }
    const key = navigationKey(landing.href);
    await expect
      .poll(
        async () =>
          documentLoaded ||
          (await page
            .evaluate((wanted) => {
              const marks = (window as unknown as { __routerTraffic?: RouterTraffic })
                .__routerTraffic;
              const fetched = marks?.fetches.find((entry) => entry.key === wanted);
              return fetched !== undefined && marks!.commits.some((at) => at > fetched.at);
            }, key)
            // A document replacing this one mid-poll: the next round says.
            .catch(() => false)),
        { message: `the navigation to ${key} that follows the action commits`, timeout },
      )
      .toBe(true);
  } finally {
    page.off('response', onResponse);
    page.off('domcontentloaded', onDomContentLoaded);
  }
}

type RouterTraffic = { seq: number; fetches: { at: number; key: string }[]; commits: number[] };

/**
 * Runs in the page: records, in order, every RSC navigation fetch (not a
 * prefetch, not an action) and every history write the router commits with.
 * Starts afresh on each call, so earlier traffic cannot answer for this action.
 */
function markRouterTraffic() {
  type Marked = { __routerTraffic?: RouterTraffic; __routerTrafficPatched?: boolean };
  const w = window as unknown as Marked;
  w.__routerTraffic = { seq: 0, fetches: [], commits: [] };
  if (w.__routerTrafficPatched) return;
  w.__routerTrafficPatched = true;
  const keyOf = (url: string) => {
    const parsed = new URL(url, location.href);
    parsed.searchParams.delete('_rsc');
    return `${parsed.pathname}${parsed.search}`;
  };
  const fetchFirst = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const marks = w.__routerTraffic!;
    if (
      headers.get('rsc') === '1' &&
      !headers.get('next-router-prefetch') &&
      !headers.get('next-action')
    ) {
      marks.fetches.push({
        at: ++marks.seq,
        key: keyOf(input instanceof Request ? input.url : String(input)),
      });
    }
    return fetchFirst.call(this, input, init);
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const write = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const marks = w.__routerTraffic!;
      marks.commits.push(++marks.seq);
      return write.apply(this, args);
    };
  }
}

/** Path and query without Next's `_rsc` cache-busting parameter. */
function navigationKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('_rsc');
  return `${parsed.pathname}${parsed.search}`;
}
