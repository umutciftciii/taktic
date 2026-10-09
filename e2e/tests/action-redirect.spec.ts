import { expect, test, type Page } from '@playwright/test';
import { settleActionRedirect } from '../src/action-redirect';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, waitForHydration } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * CI-E2E-HARDENING-001 — `settleActionRedirect` against the real router.
 *
 * Each case puts the window the helper exists for under the test's control:
 * the RSC fetch the router makes after a same-path action redirect is held at
 * the network layer (`page.route`) until the test releases or aborts it. What
 * is proven is the helper's contract, on whichever engine runs the spec:
 *
 * - same path, the submitting form still on the page: its redirect boundary
 *   navigates again, and the helper does not return while that navigation's
 *   fetch is held, and does once the router commits after it — or once the
 *   fallback's document has loaded;
 * - same path, the submitting form gone with the action's commit (a request
 *   cancelled from its own screen): no boundary navigates, and the helper
 *   returns on that commit without waiting for a fetch that never comes;
 * - another path: the URL reaching the target is enough, no RSC is awaited;
 * - no redirect at all, or a navigation that never commits: it fails, saying
 *   which step it was waiting for;
 * - a prefetch, an action-shaped request and a history write of their own do
 *   not stand in for the navigation;
 * - a submit before hydration, which the browser posts itself and Next answers
 *   with a 303: the redirect's document is the landing, not the document
 *   `clickBeforeHydration` opened on the way to the click.
 *
 * The screens are a DRAFT category's (its save redirects to the very URL it is
 * on), a request's (its cancel form leaves with the status) and a customer's
 * notes (an action that answers without a redirect).
 * Nothing here is live or listed anywhere a visitor or another spec looks.
 */

async function openSuper(browser: Parameters<typeof Actor.open>[0]) {
  const account = await createAdmin();
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

type Gate = {
  /** Resolves when the router's navigation fetch to the path is being held. */
  held: Promise<void>;
  /** Lets it through, or fails it as a dropped connection would. */
  release(how: 'continue' | 'abort'): void;
  /** How many navigation fetches to the path reached the gate. */
  count(): number;
};

/**
 * Holds every RSC navigation fetch (GET, `RSC: 1`, not a prefetch) to
 * `pathname` until `release`. Documents, prefetches and actions pass.
 */
async function holdNavigationFetch(page: Page, pathname: string): Promise<Gate> {
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let decide!: (how: 'continue' | 'abort') => void;
  const decision = new Promise<'continue' | 'abort'>((resolve) => {
    decide = resolve;
  });
  let seen = 0;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      const request = route.request();
      const headers = await request.allHeaders();
      if (request.method() !== 'GET' || headers['rsc'] !== '1' || headers['next-router-prefetch']) {
        await route.fallback();
        return;
      }
      seen += 1;
      markHeld();
      if ((await decision) === 'abort') await route.abort('failed').catch(() => undefined);
      else await route.continue().catch(() => undefined);
    },
  );
  return { held, release: decide, count: () => seen };
}

/** Runs `settleActionRedirect` and tells, without waiting, whether it returned. */
function track(promise: Promise<void>) {
  const state = { settled: false, failed: undefined as unknown };
  const done = promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.failed = error;
      throw error;
    },
  );
  return { state, done };
}

async function openDraftCategory(actor: Actor) {
  const category = await createCategory(2, { status: 'DRAFT', namePrefix: 'E2E Yönlendirme' });
  const path = `/categories/${category.slug}`;
  await actor.gotoAdmin(path);
  await assertNoErrorScreen(actor.page);
  const form = actor.page.locator('form', { has: actor.page.getByRole('button', { name: 'Kategoriyi kaydet' }) });
  const save = form.getByRole('button', { name: 'Kategoriyi kaydet' });
  await waitForHydration(save);
  return { category, path, form, save };
}

const storedName = async (id: string) =>
  (await prisma().serviceCategory.findUniqueOrThrow({ where: { id }, select: { name: true } })).name;

test.describe('CI-E2E-HARDENING-001 — settleActionRedirect', () => {
  test('same path: waits out a held RSC fetch, returns after the commit that follows it', async ({ browser }) => {
    const actor = await openSuper(browser);
    const page = actor.page;
    try {
      const { category, path, form, save } = await openDraftCategory(actor);
      const gate = await holdNavigationFetch(page, path);
      await form.locator('input[name="name"]').fill(`${category.name} tutuldu`);

      const run = track(settleActionRedirect(page, () => save.click()));
      await gate.held;
      // The hold itself is the scenario: three seconds in which the action has
      // answered, the database holds the write and the address bar is right —
      // and the navigation after it is still open.
      await page.waitForTimeout(3_000);
      expect(run.state.failed).toBeUndefined();
      expect(run.state.settled).toBe(false);
      expect(await storedName(category.id)).toBe(`${category.name} tutuldu`);
      await expect(page).toHaveURL(new RegExp(`${path}$`));

      gate.release('continue');
      await run.done;
      expect(gate.count()).toBe(1);
      // The form stayed, so its redirect boundary was what navigated.
      expect(
        await page.evaluate(() => (window as unknown as { __routerTraffic: { navigations: number[] } }).__routerTraffic.navigations.length),
      ).toBe(1);

      // Landed: a goto now is the only navigation in flight.
      await actor.gotoAdmin(`${path}?tab=sorular`);
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sorular$`));
      await assertNoErrorScreen(page);
    } finally {
      await actor.close();
    }
  });

  test('same path: an aborted RSC fetch lands through the fallback document load', async ({ browser }) => {
    const actor = await openSuper(browser);
    const page = actor.page;
    try {
      const { category, path, form, save } = await openDraftCategory(actor);
      const gate = await holdNavigationFetch(page, path);
      await form.locator('input[name="name"]').fill(`${category.name} düştü`);

      const documents: string[] = [];
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
      });

      const run = track(settleActionRedirect(page, () => save.click()));
      await gate.held;
      expect(run.state.settled).toBe(false);
      gate.release('abort');
      await run.done;

      // Next answered the failed fetch with a full navigation to the target,
      // and the helper returned on that document, not before it.
      expect(documents.map((url) => new URL(url).pathname)).toContain(path);
      expect(await storedName(category.id)).toBe(`${category.name} düştü`);
      await actor.gotoAdmin(`${path}?tab=sorular`);
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sorular$`));
    } finally {
      await actor.close();
    }
  });

  test('same path, the form gone with the commit: the action commit is the landing, no fetch is awaited', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(3);
    const customer = await createCustomer('E2E Yönlendirme İptal');
    const provider = await createProvider({ categoryId: category.id, location, credits: 50 });
    const request = await seedCustomerRequest({ customerId: customer.id, categoryId: category.id, location, content: 'full' });
    await seedOffer({ requestId: request.id, providerId: provider.id });
    const actor = await openSuper(browser);
    const page = actor.page;
    const path = `/requests/${request.id}`;
    try {
      await actor.gotoAdmin(path);
      const cancel = page.getByTestId('request-cancel');
      await waitForHydration(cancel);
      // Any navigation fetch to the screen stays held: a helper that expected
      // the boundary to navigate here could not return.
      const gate = await holdNavigationFetch(page, path);

      await cancel.click();
      await settleActionRedirect(page, () =>
        page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' }).getByRole('button', { name: 'Evet, iptal et' }).click(),
      );
      expect(gate.count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __routerTraffic: { navigations: number[] } }).__routerTraffic.navigations)).toEqual([]);
      await expect(page).toHaveURL(new RegExp(`${path}\\?cancelled=1$`));
      await expect(page.getByTestId('request-status')).toHaveText('İptal Edildi');
      gate.release('continue');
      await actor.gotoAdmin(`${path}?tab=gecmis`);
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=gecmis$`));
    } finally {
      await actor.close();
    }
  });

  test('another path: the URL reaching the target is the landing, no RSC fetch is awaited', async ({ browser }) => {
    const actor = await openSuper(browser);
    const page = actor.page;
    const slug = `e2e-yonlendirme-${uniqueSuffix()}`;
    try {
      await actor.gotoAdmin('/categories/new');
      const create = page.getByRole('button', { name: 'Kategoriyi oluştur' });
      await waitForHydration(create);
      await page.locator('input[name="name"]').fill(`E2E Yönlendirme ${slug}`);
      await page.locator('input[name="slug"]').fill(slug);
      await expect(page.getByTestId('category-new-status')).toHaveValue('DRAFT');
      // Any navigation fetch to the new address stays held for the whole
      // call: a helper that waited for one could not return.
      const gate = await holdNavigationFetch(page, `/categories/${slug}`);

      await settleActionRedirect(page, () => create.click());
      await expect(page).toHaveURL(new RegExp(`/categories/${slug}$`));
      expect((await prisma().serviceCategory.findUniqueOrThrow({ where: { slug } })).status).toBe('DRAFT');
      gate.release('continue');
    } finally {
      await actor.close();
    }
  });

  test('no redirect: an action that answers in place fails the call, saying so', async ({ browser }) => {
    const customer = await createCustomer('E2E Yönlendirme Notu');
    const actor = await openSuper(browser);
    const page = actor.page;
    const note = `E2E yönlendirmesiz not ${uniqueSuffix()}`;
    try {
      await actor.gotoAdmin(`/customers/${customer.id}?tab=notlar`);
      const add = page.getByRole('button', { name: 'Notu ekle' });
      await waitForHydration(add);
      await page.locator('#customer-note').fill(note);

      await expect(settleActionRedirect(page, () => add.click(), { timeout: 3_000 })).rejects.toThrow(
        /a server action answering with x-action-redirect/,
      );
      // The action did run — it just never redirected.
      await expect(page.getByTestId('customer-note').first()).toContainText(note);
    } finally {
      await actor.close();
    }
  });

  test('same path: a navigation that never commits fails the call, saying so', async ({ browser }) => {
    const actor = await openSuper(browser);
    const page = actor.page;
    try {
      const { category, path, form, save } = await openDraftCategory(actor);
      const gate = await holdNavigationFetch(page, path);
      await form.locator('input[name="name"]').fill(`${category.name} asılı`);

      await expect(settleActionRedirect(page, () => save.click(), { timeout: 3_000 })).rejects.toThrow(
        new RegExp(`the redirect to ${path} lands[\\s\\S]*the redirect boundary's navigation to commit`),
      );
      expect(gate.count()).toBe(1);
      gate.release('continue');
    } finally {
      await actor.close();
    }
  });

  test('a prefetch, an action-shaped request and a stray history write are not the landing', async ({ browser }) => {
    const actor = await openSuper(browser);
    const page = actor.page;
    try {
      const { category, path, form, save } = await openDraftCategory(actor);
      const gate = await holdNavigationFetch(page, path);
      await form.locator('input[name="name"]').fill(`${category.name} karışık`);

      const run = track(settleActionRedirect(page, () => save.click()));
      await gate.held;
      // While the real navigation is held: a prefetch of the very target, a
      // request carrying an action id, and a history write after both. Were
      // either request counted as the navigation fetch, that write would be
      // its commit.
      const answered = await page.evaluate(async (target) => {
        const prefetch = await fetch(target, { headers: { RSC: '1', 'Next-Router-Prefetch': '1' } });
        const action = await fetch(target, {
          method: 'POST',
          headers: { RSC: '1', 'Next-Action': '0'.repeat(40) },
          body: '[]',
        }).catch(() => null);
        history.replaceState(history.state, '', location.href);
        return [prefetch.status, action?.status ?? 0];
      }, path);
      expect(answered[0]).toBe(200);
      // Let the helper's poll run past the write (its intervals are 100, 250,
      // 500 and 1000 ms) before reading its state.
      await page.waitForTimeout(2_000);
      expect(run.state.failed).toBeUndefined();
      expect(run.state.settled).toBe(false);
      expect(gate.count()).toBe(1);

      gate.release('continue');
      await run.done;
      await actor.gotoAdmin(`${path}?tab=sorular`);
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sorular$`));
    } finally {
      await actor.close();
    }
  });

  test('a submit before hydration: the 303 document is the landing, not the document act opened', async ({ browser }) => {
    const actor = await openSuper(browser);
    const page = actor.page;
    try {
      const { category, path } = await openDraftCategory(actor);
      // Starts somewhere else, so neither the tab's URL before the call nor
      // the document clickBeforeHydration opens can be read as the landing.
      await actor.gotoAdmin('/categories');

      const events: string[] = [];
      page.on('response', (response) => {
        const request = response.request();
        if (request.method() === 'POST' && request.isNavigationRequest()) events.push(`post ${response.status()}`);
      });
      page.on('domcontentloaded', () => events.push('document'));

      await settleActionRedirect(page, () =>
        clickBeforeHydration(
          page,
          `${primaryRuntime.adminUrl}${path}`,
          page.getByRole('button', { name: 'Kategoriyi kaydet' }),
        ),
      );
      events.push('settled');
      // The document the act opened first, the form's own POST and its 303,
      // then the redirect's document — and only after that, the return.
      expect(events).toEqual(['document', 'post 303', 'document', 'settled']);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      expect(await storedName(category.id)).toBe(category.name);
      await actor.gotoAdmin(`${path}?tab=sorular`);
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sorular$`));
    } finally {
      await actor.close();
    }
  });
});
