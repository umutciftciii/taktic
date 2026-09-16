import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import {
  approveRequest,
  fillRequestForm,
  openRequestAsProvider,
  openRequestFormContactStep,
  submitRequestForm,
} from '../src/journeys';
import { primaryRuntime } from '../src/runtime';

/**
 * The preferred date range on the request form.
 *
 * "Today" here is the browser's Istanbul day — the same calendar the API
 * checks against — so the assertions derive it the way the product does:
 * `Intl.DateTimeFormat` in `Europe/Istanbul`, never `new Date().getDate()`.
 *
 * What is proved end to end:
 *
 * 1. "Bugün" fills both ends with today; "Bu hafta" fills today to Sunday;
 *    re-applying after an edit restores the default; "Esnek" leaves the dates
 *    optional.
 * 2. An edited range that contradicts the urgency is refused by the API and
 *    the refusal lands inline, with the form intact.
 * 3. A stored range comes back as the same two days on the provider's screen
 *    — no day shifted by a zone on the way in or out.
 */

const ISTANBUL_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Europe/Istanbul',
});

function today(): string {
  return ISTANBUL_DAY.format(new Date());
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

function sundayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, (7 - weekday) % 7);
}

/** `15 Eyl 2026`, as every screen prints a day. */
function displayDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Istanbul',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

test.describe('request date range', () => {
  test('urgency fills the range in, re-applies on demand, and a contradicting edit is refused by the API', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Tarih' });
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await openRequestFormContactStep(customer, category);
      await fillRequestForm(customer, requestFormValues(location, customerAccount.name));
      const page = customer.page;
      const urgency = page.getByTestId('request-urgency');
      const start = page.getByTestId('request-preferred-date');
      const end = page.getByTestId('request-preferred-date-end');
      const now = today();

      // Nothing chosen: the dates are empty and not in the way.
      await expect(start).toHaveValue('');
      await expect(end).toHaveValue('');
      await expect(start).toHaveAttribute('min', now);

      await urgency.selectOption('TODAY');
      await expect(start).toHaveValue(now);
      await expect(end).toHaveValue(now);

      await urgency.selectOption('THIS_WEEK');
      await expect(start).toHaveValue(now);
      await expect(end).toHaveValue(sundayOf(now));

      // The customer narrows it, then asks for the default back.
      await end.fill(now);
      await expect(end).toHaveValue(now);
      await page.getByTestId('request-timing-reapply').click();
      await expect(end).toHaveValue(sundayOf(now));

      // Esnek: the dates stay as they are, and are optional.
      await urgency.selectOption('FLEXIBLE');
      await expect(start).toHaveValue(now);
      await expect(page.getByTestId('request-timing-reapply')).toHaveCount(0);
      await start.fill('');
      await end.fill('');
      expect(await start.evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(true);

      // A half range is stopped by the browser before it is sent.
      await start.fill(addDays(now, 2));
      expect(await end.evaluate((el: HTMLInputElement) => el.validationMessage)).toBe(
        'Tarih aralığının iki ucunu da girin.',
      );
      await end.fill(addDays(now, 1));
      expect(await end.evaluate((el: HTMLInputElement) => el.validationMessage)).toBe(
        'Bitiş tarihi başlangıçtan önce olamaz.',
      );
      await end.fill(addDays(now, 4));
      expect(await end.evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(true);

      // "Bu hafta" with an end past Sunday: legal to the browser, refused by
      // the API, told inline with everything still on screen.
      await urgency.selectOption('THIS_WEEK');
      await end.fill(addDays(sundayOf(now), 3));
      const before = await prisma().serviceRequest.count();
      await page.getByRole('button', { name: 'Talebi Gönder' }).click();
      const refusal = page.getByTestId('request-submit-error');
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText('bu haftanın pazarını geçemez');
      await expect(page).not.toHaveURL(/\/requests\/success/);
      await assertNoErrorScreen(page);
      expect(await prisma().serviceRequest.count()).toBe(before);
      await expect(end).toHaveValue(addDays(sundayOf(now), 3));

      // Corrected, it goes through, and the two days are the two days.
      await page.getByTestId('request-timing-reapply').click();
      await expect(end).toHaveValue(sundayOf(now));
      await submitRequestForm(customer);
      const requestId = new URL(page.url()).searchParams.get('id') as string;
      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { urgency: true, preferredDate: true, preferredDateEnd: true },
      });
      expect(stored.urgency).toBe('THIS_WEEK');
      expect(stored.preferredDate?.toISOString()).toBe(`${now}T00:00:00.000Z`);
      expect(stored.preferredDateEnd?.toISOString()).toBe(`${sundayOf(now)}T00:00:00.000Z`);
    } finally {
      await customer.close();
    }
  });

  test('the stored range reads back as the same days on the provider\'s screen', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Tarih Okuma' });
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const providerAccount = await createProvider({ categoryId: category.id, location, credits: 5 });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const provider = await Actor.open(browser, 'provider', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await openRequestFormContactStep(customer, category);
      await fillRequestForm(customer, requestFormValues(location, customerAccount.name));
      const now = today();
      const startDay = addDays(now, 10);
      const endDay = addDays(now, 14);
      await customer.page.getByTestId('request-urgency').selectOption('FLEXIBLE');
      await customer.page.getByTestId('request-preferred-date').fill(startDay);
      await customer.page.getByTestId('request-preferred-date-end').fill(endDay);
      await submitRequestForm(customer);
      const requestId = new URL(customer.page.url()).searchParams.get('id') as string;

      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, requestId);

      await provider.loginToWeb(providerAccount.email, providerAccount.password);
      await openRequestAsProvider(provider, providerAccount.id, requestId);
      await expect(provider.page.getByTestId('request-preferred-range')).toHaveText(
        `${displayDay(startDay)} – ${displayDay(endDay)}`,
      );
    } finally {
      await Promise.all([customer.close(), admin.close(), provider.close()]);
    }
  });
});
