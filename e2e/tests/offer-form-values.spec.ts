import { expect, test, type Browser } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  creditBalance,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { approveRequest, createRequest, istanbulDay, openRequestAsProvider } from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * UAT B-04: a refused offer submit used to come back to an empty form — price,
 * dates, message and notes gone — so fixing one date meant typing the whole
 * offer again. The values now come back; the hidden price the page displayed
 * does not, and nothing is kept once the offer exists.
 */

const CATEGORY_COST = 2;
const STARTING_CREDITS = 10;

async function publishedRequest(browser: Browser) {
  const location = uniqueLocation();
  const category = await createCategory(CATEGORY_COST);
  const customerAccount = await createCustomer();
  const adminAccount = await createAdmin();
  const providerAccount = await createProvider({
    categoryId: category.id,
    location,
    credits: STARTING_CREDITS,
  });

  const customer = await Actor.open(browser, 'customer', primaryRuntime);
  const admin = await Actor.open(browser, 'admin', primaryRuntime);

  await customer.loginToWeb(customerAccount.email, customerAccount.password);
  const requestId = await createRequest(customer, category, requestFormValues(location, customerAccount.name));

  await admin.loginToAdmin(adminAccount.email, adminAccount.password);
  await approveRequest(admin, requestId);
  await admin.close();

  return { customer, providerAccount, requestId };
}

test('a refused offer keeps what the provider typed, and a corrected one goes through once', async ({ browser }) => {
  const fixture = await publishedRequest(browser);
  const provider = await Actor.open(browser, 'provider', primaryRuntime);

  try {
    await provider.loginToWeb(fixture.providerAccount.email, fixture.providerAccount.password);
    await openRequestAsProvider(provider, fixture.providerAccount.id, fixture.requestId);

    const form = provider.page.locator('form.pdash-form');
    const values = {
      priceAmount: '4.500,00',
      estimatedStartDate: istanbulDay(5),
      // Before the start: the schedule check refuses it and sends the form back.
      estimatedCompletionDate: istanbulDay(3),
      message: 'Yarın keşfe gelip ölçü alırız.',
      warrantyNote: 'İşçilik iki yıl garantili.',
      internalNote: 'Malzeme fiyatını teyit et.',
    };

    await form.locator('input[name="priceAmount"]').fill(values.priceAmount);
    await form.locator('input[name="estimatedStartDate"]').fill(values.estimatedStartDate);
    await form.locator('input[name="estimatedCompletionDate"]').fill(values.estimatedCompletionDate);
    await form.locator('textarea[name="message"]').fill(values.message);
    await form.locator('textarea[name="warrantyNote"]').fill(values.warrantyNote);
    await form.locator('textarea[name="internalNote"]').fill(values.internalNote);
    await form.getByRole('button', { name: /Teklifi Gönder/ }).click();

    await expect(provider.page).toHaveURL(/offerError=/);
    await expect(provider.page.getByTestId('offer-schedule-error')).toBeVisible();
    await assertNoErrorScreen(provider.page);
    // Nothing reached the URL but the code.
    expect(provider.page.url()).not.toContain('Malzeme');
    expect(provider.page.url()).not.toContain('4.500');

    for (const [name, value] of Object.entries(values)) {
      const tag = name.endsWith('Note') || name === 'message' ? 'textarea' : 'input';
      await expect(form.locator(`${tag}[name="${name}"]`), name).toHaveValue(value);
    }
    expect(await prisma().offer.count({ where: { requestId: fixture.requestId } })).toBe(0);
    expect(await creditBalance(fixture.providerAccount.id)).toBe(STARTING_CREDITS);

    // Only the wrong date needs fixing now.
    await form.locator('input[name="estimatedCompletionDate"]').fill(istanbulDay(7));
    await form.getByRole('button', { name: /Teklifi Gönder/ }).click();

    await expect(provider.page.getByText('Bu talebe daha önce teklif gönderdiniz')).toBeVisible();
    const offers = await prisma().offer.findMany({ where: { requestId: fixture.requestId } });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      priceAmount: 450000,
      message: values.message,
      warrantyNote: values.warrantyNote,
      internalNote: values.internalNote,
    });
    expect(await creditBalance(fixture.providerAccount.id)).toBe(STARTING_CREDITS - CATEGORY_COST);

    // The offer exists: the copy of the form is gone from the tab.
    await expect
      .poll(() => provider.page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.startsWith('taktick:offer-draft:'))))
      .toEqual([]);
  } finally {
    await Promise.all([fixture.customer.close(), provider.close()]);
  }
});

test('a fresh visit starts from an empty form', async ({ browser }) => {
  const fixture = await publishedRequest(browser);
  const provider = await Actor.open(browser, 'provider', primaryRuntime);

  try {
    await provider.loginToWeb(fixture.providerAccount.email, fixture.providerAccount.password);
    await openRequestAsProvider(provider, fixture.providerAccount.id, fixture.requestId);

    // A copy left from an earlier refused attempt in this tab.
    const key = `taktick:offer-draft:${fixture.providerAccount.id}:${fixture.requestId}`;
    await provider.page.evaluate(
      (storageKey) => window.sessionStorage.setItem(storageKey, JSON.stringify({ message: 'eski taslak' })),
      key,
    );

    await openRequestAsProvider(provider, fixture.providerAccount.id, fixture.requestId);

    const form = provider.page.locator('form.pdash-form');
    await expect(form.locator('textarea[name="message"]')).toHaveValue('');
    await expect.poll(() => provider.page.evaluate((storageKey) => window.sessionStorage.getItem(storageKey), key)).toBeNull();
  } finally {
    await Promise.all([fixture.customer.close(), provider.close()]);
  }
});
