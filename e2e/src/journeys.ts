import { expect, type Locator, type Page } from '@playwright/test';
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
  await openRequestFormContactStep(actor, category);
  await fillRequestForm(actor, values);

  await actor.page.getByRole('button', { name: 'Talebi Gönder' }).click();

  await expect(actor.page).toHaveURL(/\/requests\/success\?id=/);
  await assertNoErrorScreen(actor.page);

  const requestId = new URL(actor.page.url()).searchParams.get('id');
  expect(requestId, 'the success page must carry the new request id').toBeTruthy();

  return requestId as string;
}

/**
 * The identity pre-check's refusals, by test id. Any one of these on screen
 * means the gate is shut and "Devam et" / "Kod gönder" will not move — so a
 * journey that meets one fails here, naming it, rather than on a click that
 * quietly did nothing.
 */
const IDENTITY_REFUSALS = [
  'identity-login-required',
  'identity-activation-required',
  'identity-conflict',
  'identity-unavailable',
  'identity-error',
] as const;

/**
 * Asserts the contact step's identity gate stands open: no check in flight,
 * and no refusal shown. Both request forms render the same notice slot, so
 * one helper reads both.
 */
export async function expectIdentityGateOpen(page: Page): Promise<void> {
  await expect(page.getByTestId('identity-checking')).toHaveCount(0);
  for (const refusal of IDENTITY_REFUSALS) {
    await expect(
      page.getByTestId(refusal),
      `the identity pre-check refused the contact details (${refusal}); this journey needs a brand-new phone and e-mail`,
    ).toHaveCount(0);
  }
}

/**
 * Leaves the given guest contact field and waits for the identity pre-check
 * that blur starts to answer, then asserts the gate opened.
 *
 * The check is a POST the browser makes on its own; waiting on that response
 * rather than on the "checking" text is what makes this ordered: the text can
 * appear and vanish between two polls, and a click that lands before the
 * answer does not advance — the form runs the check again and stays put.
 */
export async function settleIdentityGate(page: Page, lastField: Locator): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/auth\/request-identity-check$/.test(new URL(response.url()).pathname),
  );
  await lastField.blur();
  await answered;
  await expectIdentityGateOpen(page);
}

/**
 * Fills the public request form from its first step to its last, with nothing
 * submitted: contact, then the job's details, then place and time.
 *
 * The form is one POST with the same field names as ever, presented in three
 * steps. Walking them with the page's own "Devam et" button is what a customer
 * does, and it is what keeps every field visible at the moment it is filled.
 * A visitor's way off the first step is the identity pre-check: their phone
 * and e-mail have to come back as a new customer before "Devam et" moves.
 *
 * `detailStep` runs once the second step is on screen, before the description
 * is typed — for the scenarios that interact with a category's own questions.
 */
export async function fillRequestForm(
  actor: Actor,
  values: RequestFormValues,
  options: { detailStep?: () => Promise<void> } = {},
): Promise<void> {
  const form = actor.page.locator('form.form-card');
  const nextStep = actor.page.getByRole('button', { name: 'Devam et' });

  await completeContactStep(actor, values);

  await options.detailStep?.();
  await form.locator('textarea[name="description"]').fill(values.description);
  await nextStep.click();
  await expect(actor.page.locator('#request-step-place')).toBeVisible();

  // Province and district are dependent selects: the district list is empty
  // until a province is chosen, which is exactly the behaviour being relied on
  // here — selecting the district at all proves the cascade populated it.
  await form.locator('select[name="city"]').selectOption(values.city);
  await form.locator('select[name="district"]').selectOption(values.district);
}

/**
 * Fills the contact step and leaves it through "Devam et".
 *
 * A visitor's details are checked on blur and the gate has to open first; a
 * signed-in customer's step has no gate. The disclosure box — present only on
 * a runtime with contact sharing on, and `required` there — lives on this step
 * too, and native validation would refuse to leave without it. Ticking it here
 * is what every other scenario means by "the customer filled the form in".
 */
export async function completeContactStep(actor: Actor, values: RequestFormValues): Promise<void> {
  const page = actor.page;
  const form = page.locator('form.form-card');

  await expect(page.locator('#request-step-contact')).toBeVisible();
  const guest = (await page.getByTestId('use-alternate-contact').count()) === 0;

  await fillContactStep(actor, values);

  // The gate before the box: clicking the box would blur the e-mail field and
  // start the check on its own, leaving nothing for the settle step to wait on.
  if (guest) {
    await settleIdentityGate(page, form.locator('input[name="customerEmail"]'));
  }

  const disclosure = page.getByTestId('contact-disclosure-accept');
  if ((await disclosure.count()) > 0) {
    await disclosure.check();
  }

  await page.getByRole('button', { name: 'Devam et' }).click();
  await expect(page.locator('#request-step-detail')).toBeVisible();
}

/**
 * Fills the contact step's fields, whichever of its two shapes is on screen,
 * and stops there — no blur, no gate, no "Devam et".
 *
 * A visitor is asked for the three details and types them. A signed-in customer
 * is not: their account's details are shown instead, and the fields only exist
 * once "farklı bir iletişim kişisi" is ticked. Ticking it is what keeps every
 * scenario that names a contact — the disclosure, the phone code, the details a
 * winning provider is shown — talking about the values it chose, rather than
 * about whatever the fixture account happened to be seeded with.
 *
 * The account path itself is covered on its own, by request-contact-autofill.
 */
export async function fillContactStep(actor: Actor, values: RequestFormValues): Promise<void> {
  const form = actor.page.locator('form.form-card');
  const alternateToggle = actor.page.getByTestId('use-alternate-contact');

  if ((await alternateToggle.count()) > 0) {
    await alternateToggle.check();
  }

  await form.locator('input[name="customerName"]').fill(values.customerName);
  await form.locator('input[name="customerPhone"]').fill(values.customerPhone);
  await form.locator('input[name="customerEmail"]').fill(values.customerEmail);
}

/**
 * Opens the request form. The contact step is the first one now, so opening
 * the form is arriving on it — the heading check is what proves the page is
 * the category's form and not a router or an error screen.
 */
export async function openRequestFormContactStep(
  actor: Actor,
  category: SeededCategory,
): Promise<void> {
  await actor.gotoWeb(`/categories/${category.slug}`);
  await expect(actor.page.getByRole('heading', { name: category.name })).toBeVisible();
  await expect(actor.page.locator('#request-step-contact')).toBeVisible();
}

/**
 * Fills the vitrin lead form's name and e-mail. The number is typed and proved
 * separately — the proof binds to the exact number — and it is the last of the
 * three to be left, so that blur is the one that starts the identity check.
 */
export async function fillLeadContact(
  page: Page,
  contact: { name: string; email: string },
): Promise<void> {
  await page.getByLabel('Ad soyad *').fill(contact.name);
  await page.getByLabel('E-posta *').fill(contact.email);
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

/**
 * Accepts an offer from the customer's offer screen.
 *
 * The contact-sharing acknowledgement is ticked where the screen asks for it.
 * That box is `required`, so a stack with sharing on cannot be accepted through
 * without it — which is the point — and a stack with sharing off never renders
 * it. Checking for its presence rather than assuming either way is what lets
 * this one helper drive both runtimes.
 */
export async function acceptOffer(
  customer: Actor,
  requestId: string,
  offerId: string,
): Promise<void> {
  await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);

  const consent = customer.page.getByTestId('contact-disclosure-consent');
  if ((await consent.count()) > 0) {
    await consent.locator('input[type="checkbox"]').check();
  }

  await customer.page.getByRole('button', { name: 'Kabul Et' }).click();

  // In place first — see approveRequest for why navigating early would cancel
  // the action rather than complete it.
  await expect(customer.page.getByTestId('offer-status')).toHaveText('Kabul edildi');
  await assertNoErrorScreen(customer.page);

  await customer.gotoWeb(`/requests/${requestId}/offers/${offerId}`);
  await expect(customer.page.getByTestId('offer-status')).toHaveText('Kabul edildi');
}

/**
 * The provider's matching list, as request ids.
 *
 * Two things have to be true before the list can be read, and neither is
 * implied by the heading being on screen.
 *
 * The page catches a failed matching call and renders it as an inline notice
 * instead of throwing, so a list that never loaded looks exactly like a list
 * with nothing in it — and assertNoErrorScreen does not see it, because it is
 * not the error boundary. Reading zero requests has to mean "this provider
 * matches nothing", never "the answer never arrived", or the strongest claim
 * this helper supports ("the outsider sees no requests at all") would pass for
 * the wrong reason.
 *
 * And `evaluateAll` takes one non-retrying snapshot of whatever is in the DOM
 * at that instant. Gating it on the page's own server-rendered count turns that
 * into a settled read: the number the page reports and the links it rendered
 * have to agree before either is believed.
 */
export async function matchingRequestIds(
  provider: Actor,
  providerId: string,
): Promise<string[]> {
  await provider.gotoWeb(`/providers/${providerId}/requests`);
  await expect(provider.page.getByRole('heading', { name: 'Uygun Talepler' })).toBeVisible();
  await assertNoErrorScreen(provider.page);
  // toHaveText([]) rather than toHaveCount(0): both assert there is no notice,
  // but this one prints the notice's own text when there is, so a failure names
  // the reason the list could not be loaded instead of only its count.
  await expect(
    provider.page.locator('.pdash-notice-error'),
    'the matching list must have loaded, not failed into an inline notice',
  ).toHaveText([]);

  const reportedCount = provider.page.getByTestId('matching-request-count');
  await expect(reportedCount).toBeVisible();
  const expectedCount = Number((await reportedCount.innerText()).trim());
  expect(
    Number.isInteger(expectedCount),
    'the matching list must report how many requests it rendered',
  ).toBe(true);

  const links = provider.page.getByRole('link', { name: 'Detay ve Teklif' });
  await expect(links).toHaveCount(expectedCount);

  const hrefs = await links.evaluateAll((elements) =>
    elements.map((link) => (link as HTMLAnchorElement).getAttribute('href')),
  );

  const ids = hrefs
    .filter((href): href is string => Boolean(href))
    .map((href) => href.split('/').pop() ?? '');

  expect(ids, 'every rendered match must carry a request id').toHaveLength(expectedCount);

  return ids;
}
