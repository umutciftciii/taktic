import { expect, test, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  requestFormValues,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import {
  createRequest,
  expectReviewPendingSuccess,
  fillRequestForm,
  submitRequestForm,
} from '../src/journeys';
import { seedApprovedShowcaseCard, seedLiveShowcasePlacement } from '../src/showcase-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The screen after a request is sent, worded from the request itself.
 *
 * The auto-publish half — `APPROVED` reads as "yayınlandı" — is proved in
 * request-auto-publish.spec.ts. Here are the other readers of the same URL:
 *
 * - **A guest** who just sent the form has no session, so the page makes no
 *   claim it cannot back: no status, no business, no offers. A reference and
 *   the way to the account the platform opened for them.
 * - **Another customer** holding the id, and **an id that belongs to nothing**,
 *   both meet the same not-found screen — the page never tells one customer
 *   about another's request, and never errors on a stale link.
 * - **A vitrin lead** is worded as addressed to one business, with no talk of
 *   the market.
 * - **A signed-in customer's ordinary request** waiting for an operator reads
 *   as "ön inceleme", and the flag the old URL carried changes nothing.
 */

/** Sentences that must never appear on a screen for somebody who is not the owner. */
const CLAIMS = ['yayınlandı', 'yayında', 'ön inceleme', 'onay', 'teklif', 'işletmesine iletildi'];

async function expectNoClaims(page: Page) {
  const text = (await page.getByTestId('request-success').innerText()).toLowerCase();
  for (const claim of CLAIMS) {
    expect(text, `the guest receipt must not say "${claim}"`).not.toContain(claim);
  }
}

test.describe('request success screen', () => {
  test('a guest gets a neutral receipt: reference, activation hint, no status', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Makbuz' });
    const visitor = await Actor.open(browser, 'web', primaryRuntime);
    const values = requestFormValues(location, 'E2E Misafir Makbuz');

    try {
      await visitor.gotoWeb(`/categories/${category.slug}`);
      await fillRequestForm(visitor, values);
      await submitRequestForm(visitor);

      const page = visitor.page;
      const id = new URL(page.url()).searchParams.get('id') as string;
      await expect(page.getByTestId('request-success')).toHaveAttribute('data-variant', 'guest');
      await expect(page.getByText('Talep alındı', { exact: true })).toBeVisible();
      await expect(page.getByTestId('request-success-title')).toHaveText('Talebiniz alındı');
      await expect(
        page.getByText(
          'Talebiniz işleme alındı. Gelişmeleri hesabınızı etkinleştirdikten sonra takip edebilirsiniz.',
        ),
      ).toBeVisible();
      await expect(page.getByTestId('request-success-reference')).toHaveText(
        `#${id.slice(-6).toUpperCase()}`,
      );
      await expect(page.getByRole('link', { name: 'Ana sayfaya dön' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Teklifleri görüntüle' })).toHaveCount(0);
      await expectNoClaims(page);

      // The stale flag the old form used to set changes nothing for a guest.
      await visitor.gotoWeb(`/requests/success?id=${id}&published=1`);
      await expect(page.getByTestId('request-success')).toHaveAttribute('data-variant', 'guest');
      await expectNoClaims(page);

      // The account opened behind the request is the one the activation link
      // will sign in, and the link comes back to this request's offers.
      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id },
        select: { customerId: true },
      });
      const token = await prisma().customerActivationToken.findFirst({
        where: { customerId: stored.customerId as string },
      });
      expect(token).not.toBeNull();
    } finally {
      await visitor.close();
    }
  });

  test('another customer\'s id and an unknown id both land on the not-found screen', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Başkası' });
    const owner = await createCustomer('E2E Sahip');
    const other = await createCustomer('E2E Diğer');

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const stranger = await Actor.open(browser, 'customer', primaryRuntime);
    try {
      await customer.loginToWeb(owner.email, owner.password);
      const requestId = await createRequest(customer, category, requestFormValues(location, owner.name));
      await expectReviewPendingSuccess(customer);
      // The old flag cannot promote a waiting request to "yayınlandı".
      await customer.gotoWeb(`/requests/success?id=${requestId}&published=1`);
      await expect(customer.page.getByTestId('request-success')).toHaveAttribute('data-variant', 'review');
      await expect(customer.page.getByTestId('request-success-title')).toHaveText(
        'Talebiniz ön incelemeye gönderildi',
      );

      await stranger.loginToWeb(other.email, other.password);
      await stranger.gotoWeb(`/requests/success?id=${requestId}`);
      await expectNotFoundScreen(stranger.page);
      expect(await stranger.page.locator('body').innerText()).not.toContain(owner.name);

      await stranger.gotoWeb('/requests/success?id=clzzzzzzzzzzzzzzzzzzzzzzz');
      await expectNotFoundScreen(stranger.page);

      await stranger.gotoWeb('/requests/success?id=not-an-id');
      await expectNotFoundScreen(stranger.page);

      await stranger.gotoWeb('/requests/success');
      await expectNotFoundScreen(stranger.page);
    } finally {
      await Promise.all([customer.close(), stranger.close()]);
    }
  });

  test('a vitrin lead reads as addressed to one business, never as published to the market', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Hedefli' });
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const customer = await createCustomer('E2E Hedefli Müşteri');
    const { card, version } = await seedApprovedShowcaseCard({
      providerId: owner.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E Hedefli Kart ${uniqueSuffix()}`,
    });
    const { placement } = await seedLiveShowcasePlacement({
      providerId: owner.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });

    // The rows the lead endpoint writes, seeded directly: the phone-verified
    // lead journey is showcase-placement-lead.spec.ts's subject; this screen
    // only has to read what it produced.
    const db = prisma();
    const now = new Date();
    const request = await db.serviceRequest.create({
      data: {
        categoryId: category.id,
        customerId: customer.id,
        requestNumber: `TR-E2E-${uniqueSuffix()}`,
        customerName: customer.name,
        customerPhone: uniquePhone(),
        customerEmail: customer.email,
        city: location.city,
        district: location.district,
        description: 'Vitrin üzerinden gelen talep.',
        status: 'SUBMITTED',
        directShowcaseProviderId: owner.id,
        phoneVerifiedAt: now,
      },
      select: { id: true },
    });
    const lead = await db.showcaseLead.create({
      data: {
        requestId: request.id,
        placementId: placement.id,
        cardId: card.id,
        cardVersionId: version.id,
        kindSnapshot: 'SERVICE',
        listedPriceSnapshot: 150_000,
        providerId: owner.id,
        urgencyBucket: 'NORMAL',
        slaHoursSnapshot: 24,
        slaDueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: 'OPEN',
      },
      select: { id: true },
    });
    await db.serviceRequest.update({ where: { id: request.id }, data: { showcaseLeadId: lead.id } });

    const actor = await Actor.open(browser, 'customer', primaryRuntime);
    try {
      await actor.loginToWeb(customer.email, customer.password);
      await actor.gotoWeb(`/requests/success?id=${request.id}`);
      await assertNoErrorScreen(actor.page);
      await expect(actor.page.getByTestId('request-success')).toHaveAttribute('data-variant', 'targeted');
      await expect(actor.page.getByTestId('request-success-title')).toHaveText(
        `Talebiniz ${owner.businessName} işletmesine iletildi`,
      );
      const text = (await actor.page.getByTestId('request-success').innerText()).toLowerCase();
      expect(text).toContain('yalnız seçtiğiniz işletmeye');
      expect(text).toContain('24 saat');
      expect(text).not.toContain('yayınlandı');
      expect(text).not.toContain('ön inceleme');
    } finally {
      await actor.close();
    }
  });
});
