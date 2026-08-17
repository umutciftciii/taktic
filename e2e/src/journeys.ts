import { expect } from '@playwright/test';
import { Actor, assertNoErrorScreen } from './actors';
import type { SeededCategory } from './fixtures';

/**
 * The steps every scenario shares, expressed once.
 *
 * Each helper drives real screens and real server actions — nothing here calls
 * the API directly. Assertions inside them are the ones that make the *step*
 * meaningful ("the request really was created", "the status really is
 * approved"); the scenario-specific claims stay in the spec files.
 *
 * Locators favour the form-field `name` contract and accessible roles. `name`
 * attributes are not incidental markup: the server actions read the form by
 * exactly these keys, so a selector built on them breaks only when the feature
 * genuinely changes. A handful of `data-testid`s cover the places where the
 * visible text alone is ambiguous (a status word that appears in several
 * panels, a bare number inside a sentence).
 */

export type RequestFormValues = {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  city: string;
  district: string;
  description: string;
};

/**
 * Fills and submits the public request form, returning the new request id.
 *
 * The id is read from the success page's URL rather than from the database:
 * that is the identifier the product just handed the customer, so anything the
 * test does with it afterwards follows the same path a person would.
 */
export async function createRequest(
  actor: Actor,
  category: SeededCategory,
  values: RequestFormValues,
): Promise<string> {
  await actor.gotoWeb(`/categories/${category.slug}`);
  await expect(actor.page.getByRole('heading', { name: category.name })).toBeVisible();

  const form = actor.page.locator('form.form-card');
  await form.locator('input[name="customerName"]').fill(values.customerName);
  await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
  await form.locator('input[name="customerEmail"]').fill(values.customerEmail);
  await form.locator('input[name="city"]').fill(values.city);
  await form.locator('input[name="district"]').fill(values.district);
  await form.locator('textarea[name="description"]').fill(values.description);

  // Present only on a runtime with contact sharing on, where it is required:
  // the form cannot be submitted until the customer confirms having read the
  // linked disclosure. Ticking it here is what every other scenario means by
  // "the customer filled the form in".
  const disclosure = actor.page.getByTestId('contact-disclosure-accept');
  if ((await disclosure.count()) > 0) {
    await disclosure.check();
  }

  await actor.page.getByRole('button', { name: 'Talebi Gönder' }).click();

  await expect(actor.page).toHaveURL(/\/requests\/success\?id=/);
  await assertNoErrorScreen(actor.page);

  const requestId = new URL(actor.page.url()).searchParams.get('id');
  expect(requestId, 'the success page must carry the new request id').toBeTruthy();

  return requestId as string;
}

/**
 * Moves a request to APPROVED from the admin screen and confirms it stuck.
 *
 * The in-place assertion comes first and is not optional: a server action is an
 * in-flight POST, and navigating away from the page that started it cancels it.
 * Waiting for the re-render the action triggers is what makes the step ordered
 * rather than raced — no timer involved. The reload afterwards then proves the
 * new status was persisted and not merely painted.
 */
export async function approveRequest(admin: Actor, requestId: string): Promise<void> {
  await admin.gotoAdmin(`/requests/${requestId}`);
  await admin.page.getByRole('button', { name: 'Onayla' }).click();
  await expect(admin.page.getByTestId('request-status')).toHaveText('Onaylandı');
  await assertNoErrorScreen(admin.page);

  await admin.gotoAdmin(`/requests/${requestId}`);
  await expect(admin.page.getByTestId('request-status')).toHaveText('Onaylandı');
}

/** Attempts approval and expects the phone-verification gate to refuse it. */
export async function expectApprovalBlockedByPhoneGate(
  admin: Actor,
  requestId: string,
): Promise<void> {
  await admin.gotoAdmin(`/requests/${requestId}`);
  await admin.page.getByRole('button', { name: 'Onayla' }).click();

  // A readable refusal on the request screen, not the generic error boundary.
  await expect(admin.page.getByTestId('status-error')).toBeVisible();
  await assertNoErrorScreen(admin.page);

  await admin.gotoAdmin(`/requests/${requestId}`);
  await expect(admin.page.getByTestId('request-status')).not.toHaveText('Onaylandı');
}

/**
 * Opens the provider's view of a request and submits an offer, after checking
 * that the page quotes the category's own credit price.
 */
export async function submitOffer(
  provider: Actor,
  options: {
    providerId: string;
    requestId: string;
    expectedCreditCost: number;
    priceAmount: string;
    message: string;
  },
): Promise<void> {
  await openRequestAsProvider(provider, options.providerId, options.requestId);
  await expect(provider.page.getByTestId('offer-credit-cost')).toHaveText(
    String(options.expectedCreditCost),
  );

  await fillOfferForm(provider, options.priceAmount, options.message);
  await provider.page.getByRole('button', { name: 'Teklifi Gönder' }).click();

  await expect(
    provider.page.getByText('Bu talebe daha önce teklif gönderdiniz'),
  ).toBeVisible();
  await assertNoErrorScreen(provider.page);
}

export async function openRequestAsProvider(
  provider: Actor,
  providerId: string,
  requestId: string,
): Promise<void> {
  await provider.gotoWeb(`/providers/${providerId}/requests/${requestId}`);
  await expect(provider.page.getByRole('heading', { name: 'Teklif Ver' })).toBeVisible();
}

export async function fillOfferForm(
  provider: Actor,
  priceAmount: string,
  message: string,
): Promise<void> {
  const form = provider.page.locator('form.pdash-form');
  await form.locator('input[name="priceAmount"]').fill(priceAmount);
  await form.locator('textarea[name="message"]').fill(message);
}

/** The id of the offer this provider has on this request, read from its link. */
export async function readProviderOfferId(
  provider: Actor,
  providerId: string,
  requestId: string,
): Promise<string> {
  await provider.gotoWeb(`/providers/${providerId}/requests/${requestId}`);
  const link = provider.page.getByRole('link', { name: 'Teklif Detayını Gör' });
  await expect(link).toBeVisible();

  const href = await link.getAttribute('href');
  const offerId = href?.split('/').pop();
  expect(offerId, 'the offer detail link must carry the offer id').toBeTruthy();

  return offerId as string;
}

/** Accepts an offer from the customer's offer screen. */
export async function acceptOffer(
  customer: Actor,
  requestId: string,
  offerId: string,
): Promise<void> {
  await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);
  await customer.page.getByRole('button', { name: 'Kabul Et' }).click();

  // In place first — see approveRequest for why navigating early would cancel
  // the action rather than complete it.
  await expect(customer.page.getByTestId('offer-status')).toHaveText('Kabul edildi');
  await assertNoErrorScreen(customer.page);

  await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);
  await expect(customer.page.getByTestId('offer-status')).toHaveText('Kabul edildi');
}

/** The provider's matching list, as request ids. */
export async function matchingRequestIds(
  provider: Actor,
  providerId: string,
): Promise<string[]> {
  await provider.gotoWeb(`/providers/${providerId}/requests`);
  await expect(provider.page.getByRole('heading', { name: 'Uygun Talepler' })).toBeVisible();
  await assertNoErrorScreen(provider.page);

  const hrefs = await provider.page
    .getByRole('link', { name: 'Detay ve Teklif' })
    .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute('href')));

  return hrefs
    .filter((href): href is string => Boolean(href))
    .map((href) => href.split('/').pop() ?? '');
}
