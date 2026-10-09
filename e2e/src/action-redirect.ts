import { expect, type BrowserContext, type Page, type Response } from '@playwright/test';

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
 * What is still in flight depends on where the redirect goes and on what is
 * still mounted once the action's answer is applied (Next 15 app router, read
 * from its server-action reducer and redirect boundary, and measured):
 *
 * - **Another path** (`/categories/new` → `/categories/<slug>`): the action's
 *   response carries the target's tree, the router commits it and pushes the
 *   URL. The page that submitted is unmounted with the old tree, so nothing
 *   else happens: the URL reaching the target is the landing.
 * - **The same path** (a save that redirects to the page it is on, with or
 *   without `?ok=saved`): the action's tree commits first. The action promise
 *   rejects with the redirect, and what happens next depends on whether the
 *   component that ran the action is still mounted in that tree:
 *   - it is (a save whose form stays on the page): the rejection is thrown
 *     into its redirect boundary, whose effect calls `router.push(target)`.
 *     The action called `revalidatePath`, so that navigation fetches the
 *     target's RSC payload, and it is over when the router commits after the
 *     payload has been answered. Until then a `goto` can kill the fetch;
 *   - it is not (a cancel whose form disappears with the status it changed):
 *     nothing throws, no navigation follows, and the action's commit was the
 *     landing.
 *   The URL is right before either is decided, a database write lands before
 *   the action even answers, and `waitForLoadState('networkidle')` returns at
 *   once because the state was reached long before — none of them can tell
 *   the two apart. What does is the commit's passive effects: the boundary's
 *   `router.push` runs inside them, so once React reports them flushed the
 *   navigation has either started or will not happen. React reports it to a
 *   DevTools hook, which is why the recorder (below) provides one.
 *   If the navigation's fetch fails instead, the fallback's document load is
 *   the landing.
 * - **No JavaScript yet** (a submit before hydration that React does not
 *   replay): the browser posts the form itself and Next answers the document
 *   POST with a 303 to the redirect. That document's load is the landing, on
 *   whichever path; nothing of the old page is left to navigate again.
 *
 * Two facts are taken from the action's own response rather than from the
 * moment `act` starts, because `act` may itself load a document first —
 * `clickBeforeHydration` opens the page it clicks on:
 *
 * - **where the action was submitted from**: a server action posts to the URL
 *   of the page that runs it, so the response's URL is that page, whatever the
 *   tab showed before `act`;
 * - **the fallback**: only a document that loads *after* the action answered
 *   is the redirect's landing. One loaded on the way to the click is not.
 *
 * A prefetch and a request carrying an action id are never the navigation
 * fetch, whatever URL they ask for, and a history write made while that fetch
 * is still open is not its commit.
 *
 * Needs the page's context to carry the recorder (`recordRouterTraffic`;
 * `Actor.open` installs it on every context). Fails, with the step it was
 * waiting for in the message, when no action answers with a redirect or the
 * navigation after it never lands within `timeout` — never silently.
 */
export async function settleActionRedirect(
  page: Page,
  act: () => Promise<unknown>,
  { timeout = 20_000 }: { timeout?: number } = {},
): Promise<void> {
  let action: { from: URL; target: URL; byDocument: boolean } | undefined;
  let documentLoaded = false;
  const onResponse = (response: Response) => {
    if (action) return;
    const request = response.request();
    const headers = response.headers();
    if (headers['x-action-redirect'] && request.headers()['next-action']) {
      action = {
        from: new URL(response.url()),
        target: new URL(headers['x-action-redirect'].split(';')[0]!, response.url()),
        byDocument: false,
      };
    } else if (
      request.method() === 'POST' &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      response.status() === 303 &&
      headers['location']
    ) {
      action = {
        from: new URL(response.url()),
        target: new URL(headers['location'], response.url()),
        byDocument: true,
      };
    }
  };
  const onDomContentLoaded = () => {
    if (action) documentLoaded = true;
  };

  expect(
    await page.evaluate(resetRouterTraffic),
    'the page records router traffic (open it through Actor.open, or call recordRouterTraffic on its context)',
  ).toBe(true);
  page.on('response', onResponse);
  page.on('domcontentloaded', onDomContentLoaded);
  try {
    await act();
    await expect
      .poll(() => action?.target.href, {
        message: 'a server action answering with x-action-redirect (or a form POST with a 303)',
        timeout,
      })
      .toBeDefined();
    const { from, target, byDocument } = action!;
    if (byDocument) {
      await expect
        .poll(() => documentLoaded && page.url() === target.href, {
          message: `the document ${target.href} the form POST was sent to loads`,
          timeout,
        })
        .toBe(true);
      return;
    }
    if (target.pathname !== from.pathname) {
      await expect(page).toHaveURL(target.href, { timeout });
      return;
    }
    await expect
      .poll(
        async () =>
          documentLoaded
            ? 'landed'
            : await page
                .evaluate(sameScreenRedirectStep)
                // A document replacing this one mid-poll: the next round says.
                .catch(() => 'a document is replacing the page'),
        {
          message: `the redirect to ${target.pathname}${target.search} lands (the value is the step it is waiting for)`,
          timeout,
        },
      )
      .toBe('landed');
  } finally {
    page.off('response', onResponse);
    page.off('domcontentloaded', onDomContentLoaded);
  }
}

/**
 * Installs the recorder `settleActionRedirect` reads on every document the
 * context opens, from before the first script runs. `Actor.open` calls it for
 * every actor.
 *
 * It only observes: each wrapper calls through to what it wraps and returns
 * its result unchanged. The DevTools hook it provides is the stub React looks
 * for at start-up (`supportsFiber`, `inject`, the two commit callbacks) and is
 * only installed where no real one exists.
 */
export async function recordRouterTraffic(context: BrowserContext): Promise<void> {
  await context.addInitScript(installRouterRecorder);
}

type RouterTraffic = {
  seq: number;
  /** Server action requests; `redirect` is the x-action-redirect they were answered with. */
  actions: { at: number; answeredAt?: number; redirect?: string | null }[];
  /** RSC navigation fetches (not a prefetch, not an action); `answeredAt` unset while open or if failed. */
  fetches: { at: number; answeredAt?: number }[];
  /** `router.push` / `router.replace` calls — what a redirect boundary navigates with. */
  navigations: number[];
  /** History writes: the router writes one in every commit it makes. */
  commits: number[];
  /** React commits, and React reporting a commit's passive effects flushed. */
  reactCommits: number[];
  passiveFlushes: number[];
};

type Recorded = {
  __routerTraffic?: RouterTraffic;
  __routerRecorder?: boolean;
};

/** Runs in the page: forgets earlier traffic, so it cannot answer for this action. */
function resetRouterTraffic(): boolean {
  const w = window as unknown as Recorded;
  if (!w.__routerRecorder) return false;
  w.__routerTraffic = {
    seq: 0,
    actions: [],
    fetches: [],
    navigations: [],
    commits: [],
    reactCommits: [],
    passiveFlushes: [],
  };
  return true;
}

/**
 * Runs in the page, as an init script: records, in order, server actions and
 * what they were answered with, RSC navigation fetches and when they were
 * answered, router navigations, history writes, and React's commits and
 * passive-effect flushes.
 */
function installRouterRecorder() {
  const w = window as unknown as Recorded & {
    next?: { router?: Record<string, unknown> };
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown>;
  };
  if (w.__routerRecorder) return;
  w.__routerRecorder = true;
  w.__routerTraffic = {
    seq: 0,
    actions: [],
    fetches: [],
    navigations: [],
    commits: [],
    reactCommits: [],
    passiveFlushes: [],
  };
  const marks = () => w.__routerTraffic!;
  const mark = (list: number[]) => {
    const m = marks();
    list.push(++m.seq);
  };

  const fetchFirst = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const m = marks();
    const pending = fetchFirst.call(this, input, init);
    if (headers.get('next-action')) {
      const entry: RouterTraffic['actions'][number] = { at: ++m.seq };
      m.actions.push(entry);
      pending.then(
        (response) => {
          entry.redirect = response.headers.get('x-action-redirect');
          entry.answeredAt = ++m.seq;
        },
        () => undefined,
      );
    } else if (headers.get('rsc') === '1' && !headers.get('next-router-prefetch')) {
      const entry: RouterTraffic['fetches'][number] = { at: ++m.seq };
      m.fetches.push(entry);
      pending.then(
        () => {
          entry.answeredAt = ++m.seq;
        },
        () => undefined,
      );
    }
    return pending;
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const write = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      mark(marks().commits);
      return write.apply(this, args);
    };
  }

  // The app router publishes its instance as `window.next.router`, the same
  // object `useRouter()` hands the redirect boundary.
  const wrapRouter = (router: Record<string, unknown> | undefined) => {
    if (!router || router.__recorded) return;
    for (const method of ['push', 'replace']) {
      const navigate = router[method];
      if (typeof navigate !== 'function') continue;
      router[method] = function (this: unknown, ...args: unknown[]) {
        mark(marks().navigations);
        return navigate.apply(this, args);
      };
    }
    router.__recorded = true;
  };
  const trapRouter = (next: { router?: Record<string, unknown> } | undefined) => {
    if (!next || typeof next !== 'object') return;
    let router = next.router;
    wrapRouter(router);
    Object.defineProperty(next, 'router', {
      configurable: true,
      enumerable: true,
      get: () => router,
      set: (value) => {
        router = value;
        wrapRouter(value);
      },
    });
  };
  let next = w.next;
  trapRouter(next);
  Object.defineProperty(w, 'next', {
    configurable: true,
    get: () => next,
    set: (value) => {
      next = value;
      trapRouter(value);
    },
  });

  if (!w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onCommitFiberRoot: () => mark(marks().reactCommits),
      onPostCommitFiberRoot: () => mark(marks().passiveFlushes),
    };
  }
}

/**
 * Runs in the page: where a same-path action redirect stands, as the step it
 * is waiting for, or `'landed'`.
 */
function sameScreenRedirectStep(): string {
  const m = (window as unknown as Recorded).__routerTraffic;
  if (!m) return 'the recorder (the page was replaced without it)';
  const answered = m.actions.filter((entry) => entry.redirect && entry.answeredAt !== undefined).at(-1);
  if (!answered) return "the action's answer";
  const after = (list: number[], seq: number) => list.find((at) => at > seq);
  // The commit that applies the action's answer, and the end of that commit.
  const actionCommit = after(m.commits, answered.answeredAt!);
  if (actionCommit === undefined) return "the action's commit";
  const commitEnd = after(m.reactCommits, actionCommit);
  // Its passive effects: flushed, or flushed for certain by a later commit.
  const effectsDone =
    after(m.passiveFlushes, actionCommit) !== undefined ||
    (commitEnd !== undefined && after(m.reactCommits, commitEnd) !== undefined);
  if (!effectsDone) return "the action commit's effects (where a redirect boundary would navigate)";
  for (const at of m.navigations.filter((seq) => seq > answered.answeredAt!)) {
    if (after(m.commits, at) === undefined) return "the redirect boundary's navigation to commit";
  }
  for (const fetched of m.fetches.filter((entry) => entry.at > answered.answeredAt!)) {
    if (fetched.answeredAt === undefined) return 'the navigation fetch to be answered';
    if (after(m.commits, fetched.answeredAt) === undefined) return 'the commit after the navigation fetch';
  }
  return 'landed';
}
