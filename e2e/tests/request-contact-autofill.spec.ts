import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createCustomer,
  prisma,
  requestFormValues,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * The contact step, in the two shapes it now has.
 *
 * A signed-in customer is shown the details their offers will be shared with
 * rather than asked to retype them, and may name somebody else instead. A
 * visitor with no session sees the form exactly as it always was.
 *
 * Everything asserted here is a browser claim: what is on screen, what the
 * checkbox does to the fields under it, that unticking really erases what was
 * typed, and that none of it pushes a 320px phone sideways. The half that holds
 * without any browser at all — that the server derives the contact from the
 * session and ignores a forged body — is
 * `apps/api/test/request-contact-autofill.spec.ts`.
 */

/** Walks the first two steps, stopping on the contact step. */
async function goToContactStep(customer: Actor, slug: string, city: string, district: string) {
  await customer.gotoWeb(`/categories/${slug}`);

  const form = customer.page.locator('form.form-card');
  const nextStep = customer.page.getByRole('button', { name: 'Devam et' });

  await form.locator('textarea[name="description"]').fill('Salon klimasının montajı gerekiyor.');
  await nextStep.click();
  await form.locator('select[name="city"]').selectOption(city);
  await form.locator('select[name="district"]').selectOption(district);
  await nextStep.click();
}

/** Ticks the disclosure when the runtime has contact sharing on, then submits. */
async function submitRequest(customer: Actor): Promise<string> {
  const disclosure = customer.page.getByTestId('contact-disclosure-accept');
  if ((await disclosure.count()) > 0) {
    await disclosure.check();
  }

  await customer.page.getByRole('button', { name: 'Talebi Gönder' }).click();
  await expect(customer.page).toHaveURL(/\/requests\/success\?id=/);
  await assertNoErrorScreen(customer.page);

  return new URL(customer.page.url()).searchParams.get('id') as string;
}

test.describe('request contact autofill', () => {
  test('a signed-in customer is shown their account contact and never types it', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await goToContactStep(customer, category.slug, location.city, location.district);

      // The three details, as text. Not a disabled input: there is no field to
      // edit, so there is nothing named customerName for anyone to post.
      await expect(customer.page.getByTestId('account-contact-name')).toHaveText(
        customerAccount.name,
      );
      await expect(customer.page.getByTestId('account-contact-phone')).toHaveText(
        customerAccount.phone,
      );
      await expect(customer.page.getByTestId('account-contact-email')).toHaveText(
        customerAccount.email,
      );
      await expect(customer.page.getByTestId('account-contact-summary')).toContainText(
        'Teklifler bu iletişim bilgileriyle paylaşılacak.',
      );
      await expect(customer.page.locator('input[name="customerName"]')).toHaveCount(0);
      await expect(customer.page.locator('input[name="customerPhone"]')).toHaveCount(0);
      await expect(customer.page.locator('input[name="customerEmail"]')).toHaveCount(0);

      // The estimate counts contact as done: the customer supplied it by having
      // an account, and telling them otherwise would be wrong.
      await expect(customer.page.getByText('İletişim bilgisi verildi')).toBeVisible();

      const requestId = await submitRequest(customer);

      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: {
          customerId: true,
          customerName: true,
          customerPhone: true,
          customerEmail: true,
        },
      });
      expect(stored).toEqual({
        customerId: customerAccount.id,
        customerName: customerAccount.name,
        customerPhone: customerAccount.phone,
        customerEmail: customerAccount.email,
      });
    } finally {
      await customer.close();
    }
  });

  test('the checkbox opens the alternate fields, and unticking clears them', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const customerAccount = await createCustomer();
    const values = requestFormValues(location, 'Vekil Kişi');
    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await goToContactStep(customer, category.slug, location.city, location.district);

      const toggle = customer.page.getByTestId('use-alternate-contact');
      const form = customer.page.locator('form.form-card');
      const name = form.locator('input[name="customerName"]');
      const phone = form.locator('input[name="customerPhone"]');
      const email = form.locator('input[name="customerEmail"]');

      await expect(toggle).not.toBeChecked();

      await toggle.check();
      await expect(customer.page.getByTestId('alternate-contact-fields')).toBeVisible();
      await name.fill(values.customerName);
      await phone.fill(values.customerPhone);
      await email.fill(values.customerEmail);

      // Unticking puts the account's own details back and takes the fields away.
      await toggle.uncheck();
      await expect(customer.page.getByTestId('alternate-contact-fields')).toHaveCount(0);
      await expect(customer.page.getByTestId('account-contact-name')).toHaveText(
        customerAccount.name,
      );

      // And what was typed is gone rather than merely hidden: ticking the box
      // again starts from three empty fields.
      await toggle.check();
      await expect(name).toHaveValue('');
      await expect(phone).toHaveValue('');
      await expect(email).toHaveValue('');

      await name.fill(values.customerName);
      await phone.fill(values.customerPhone);
      await email.fill(values.customerEmail);

      const requestId = await submitRequest(customer);

      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: {
          customerId: true,
          customerName: true,
          customerPhone: true,
          customerEmail: true,
        },
      });
      expect(stored).toEqual({
        // The alternate person is a contact for this request, not its owner.
        customerId: customerAccount.id,
        customerName: values.customerName,
        customerPhone: values.customerPhone,
        customerEmail: values.customerEmail,
      });
    } finally {
      await customer.close();
    }
  });

  test('a visitor with no session still fills the contact fields in', async ({ browser }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const values = requestFormValues(location, 'Misafir Müşteri');
    const visitor = await Actor.open(browser, 'visitor', primaryRuntime);

    try {
      await goToContactStep(visitor, category.slug, location.city, location.district);

      // Nothing to autofill from, so nothing is offered: no summary, no
      // checkbox, and the three fields exactly where they always were.
      await expect(visitor.page.getByTestId('account-contact-summary')).toHaveCount(0);
      await expect(visitor.page.getByTestId('use-alternate-contact')).toHaveCount(0);

      const form = visitor.page.locator('form.form-card');
      await form.locator('input[name="customerName"]').fill(values.customerName);
      await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
      await form.locator('input[name="customerEmail"]').fill(values.customerEmail);

      const requestId = await submitRequest(visitor);

      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { customerName: true, customerPhone: true, customerEmail: true },
      });
      expect(stored).toEqual({
        customerName: values.customerName,
        customerPhone: values.customerPhone,
        customerEmail: values.customerEmail,
      });
    } finally {
      await visitor.close();
    }
  });

  test('an account missing a contact detail is told so, and can name somebody else', async ({
    browser,
  }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const values = requestFormValues(location, 'Vekil Kişi');
    const customerAccount = await createCustomer();
    // An account with no telephone number — every one of the three columns is
    // nullable, and an older customer may never have been asked for one.
    await prisma().user.update({ where: { id: customerAccount.id }, data: { phone: null } });

    const customer = await Actor.open(browser, 'customer', primaryRuntime);

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await goToContactStep(customer, category.slug, location.city, location.district);

      await expect(customer.page.getByTestId('account-contact-incomplete')).toContainText(
        'telefon',
      );
      await expect(customer.page.getByTestId('account-contact-summary')).toHaveCount(0);
      // Submitting on the account's own details is withheld rather than left to
      // fail on the server.
      await expect(customer.page.getByRole('button', { name: 'Talebi Gönder' })).toBeDisabled();

      await customer.page.getByTestId('use-alternate-contact').check();
      const form = customer.page.locator('form.form-card');
      await form.locator('input[name="customerName"]').fill(values.customerName);
      await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
      await form.locator('input[name="customerEmail"]').fill(values.customerEmail);

      const requestId = await submitRequest(customer);

      const stored = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { customerId: true, customerName: true, customerPhone: true },
      });
      expect(stored).toEqual({
        customerId: customerAccount.id,
        customerName: values.customerName,
        customerPhone: values.customerPhone,
      });
    } finally {
      await customer.close();
    }
  });

  test('the contact step stays inside a 320px phone in both of its shapes', async ({ browser }) => {
    const category = await createCategory(2);
    const location = uniqueLocation();
    const customerAccount = await createCustomer();
    const customer = await Actor.open(browser, 'customer', primaryRuntime, {
      viewport: { width: 320, height: 720 },
    });

    try {
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await goToContactStep(customer, category.slug, location.city, location.district);

      const overflow = async () =>
        customer.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

      await expect(customer.page.getByTestId('account-contact-summary')).toBeVisible();
      expect(await overflow(), 'the account contact made the page wider than the phone').toBeLessThanOrEqual(
        0,
      );

      await customer.page.getByTestId('use-alternate-contact').check();
      await expect(customer.page.getByTestId('alternate-contact-fields')).toBeVisible();
      expect(
        await overflow(),
        'the alternate contact fields made the page wider than the phone',
      ).toBeLessThanOrEqual(0);

      // The document not being too wide is not the same as these being on
      // screen: an ancestor's overflow could hide the difference.
      for (const selector of [
        '[data-testid="use-alternate-contact"]',
        'input[name="customerName"]',
        'input[name="customerPhone"]',
        'input[name="customerEmail"]',
      ]) {
        const box = await customer.page.locator(selector).first().evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right) };
        });
        expect(box.left, `${selector} starts off the left edge`).toBeGreaterThanOrEqual(-1);
        expect(box.right, `${selector} runs past the right edge`).toBeLessThanOrEqual(321);
      }
    } finally {
      await customer.close();
    }
  });
});
