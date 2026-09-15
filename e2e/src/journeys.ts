import { expect, type Locator, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from './actors';
import type { SeededCategory, UrgencyCode } from './fixtures';

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
  /**
   * When the customer wants the work done, as the code the form's "Aciliyet"
   * select posts. Optional because the select is: left out, the field stays on
   * "Seçiniz" and the request carries no urgency, exactly as before this field
   * existed.
   */
  urgency?: UrgencyCode;
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

  await submitRequestForm(actor);

  const requestId = new URL(actor.page.url()).searchParams.get('id');
  expect(requestId, 'the success page must carry the new request id').toBeTruthy();

  return requestId as string;
}

/**
 * Sends a fully filled request form and waits for the success page.
 *
 * Split out of `createRequest` for the scenario that fills the form, is
 * refused once, corrects the field in place and sends again: the second send
 * starts from the form already on screen, not from the category page.
 *
 * The URL check stops at `?id=` on purpose: a request born live arrives with
 * `&published=1` after the id, one that waits for an operator does not, and
 * which of the two happened is the spec's claim to make (see
 * {@link expectPublishedSuccess}), not this step's.
 */
export async function submitRequestForm(actor: Actor): Promise<void> {
  await actor.page.getByRole('button', { name: 'Talebi Gönder' }).click();

  await expect(actor.page).toHaveURL(/\/requests\/success\?id=/);
  await assertNoErrorScreen(actor.page);
}

/**
 * The success page a request born live shows: the heading that promises
 * providers rather than a review, and the flag the form set to get it.
 */
export async function expectPublishedSuccess(actor: Actor): Promise<void> {
  await expect(actor.page).toHaveURL(/\/requests\/success\?id=[^&]+&published=1$/);
  await expect(actor.page.getByTestId('request-success-title')).toHaveText(
    'Talebiniz uygun hizmet verenlere iletildi',
  );
}

/** The older success page: the request waits for an operator. */
export async function expectReviewPendingSuccess(actor: Actor): Promise<void> {
  await expect(actor.page).not.toHaveURL(/published=1/);
  await expect(actor.page.getByTestId('request-success-title')).toHaveText(
    'Talebiniz ön incelemeye gönderildi',
  );
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

  if (values.urgency) {
    await form.locator('select[name="urgency"]').selectOption(values.urgency);
  }
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

/**
 * Turns the marketplace auto-publish switch on from the operations screen,
 * the way an operator does. Idempotent: a switch already on is left alone.
 *
 * The switch is a `role="switch"` submit button whose action redirects back
 * to the page, so the re-rendered button carrying `aria-checked="true"` is
 * the proof that the setting was written and read back, not merely painted.
 *
 * The suite's default is OFF and every other spec relies on it (they approve
 * requests by hand). A spec that calls this must put it back — see
 * `setAutoPublish(false)` in fixtures — in an `afterEach`, so a failure
 * halfway through cannot leave the next spec on the wrong side of the rule.
 */
export async function enableAutoPublish(admin: Actor): Promise<void> {
  await admin.gotoAdmin('/operations-settings');
  const toggle = admin.page.getByTestId('auto-publish-toggle');
  await expect(toggle).toBeVisible();

  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
    await expect(admin.page.getByTestId('auto-publish-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }
  await assertNoErrorScreen(admin.page);
}

/** The reasons the provider's report dialog offers, as the API stores them. */
export type RequestReportReason =
  | 'SPAM'
  | 'FAKE_OR_TEST'
  | 'CONTAINS_CONTACT_INFO'
  | 'WRONG_CATEGORY'
  | 'INAPPROPRIATE_CONTENT'
  | 'DUPLICATE'
  | 'OTHER';

/**
 * Reports a request from the provider's own request screen, through the
 * native dialog, and waits for the page's "received" notice.
 *
 * `report-received` is looked up by test id rather than by role: the notice
 * is a `role="status"` region, and on WebKit the route announcer Next.js
 * renders is a live region too — a role-based query matched both.
 */
export async function reportRequest(
  provider: Actor,
  providerId: string,
  requestId: string,
  reason: RequestReportReason,
  note?: string,
): Promise<void> {
  await openRequestAsProvider(provider, providerId, requestId);
  await provider.page.getByTestId('report-request-button').click();

  const dialog = provider.page.locator('dialog.report-dialog');
  await expect(dialog).toBeVisible();
  await provider.page.getByTestId('report-reason').selectOption(reason);
  if (note) {
    await provider.page.getByTestId('report-note').fill(note);
  }
  await provider.page.getByTestId('report-submit').click();

  // The action round-trips to the API and comes back with `?reported=1`;
  // the notice is the page's report of that answer, and it is present
  // exactly once — the badge that normally carries the id yields it here.
  await expect(provider.page.getByTestId('report-received')).toHaveCount(1);
  await expect(provider.page.getByTestId('report-received')).toBeVisible();
  await assertNoErrorScreen(provider.page);
}

/**
 * Decides on a request's open reports from the admin request screen.
 *
 * Either the request is fine (`DISMISSED`) or it comes down
 * (`REQUEST_REMOVED`, with the reason the customer is told). The API does
 * everything in one transaction; this only drives the operator's two forms.
 *
 * As with `approveRequest`, the in-place assertion is what orders the step:
 * a server action is an in-flight POST, and navigating away cancels it. A
 * dismissal is done when the decision block is gone (no open report is left
 * to decide on); a removal when the status badge reads rejected.
 */
export async function resolveReports(
  admin: Actor,
  requestId: string,
  resolution: 'DISMISSED' | 'REQUEST_REMOVED',
  removalReason: RequestReportReason = 'SPAM',
): Promise<void> {
  await admin.gotoAdmin(`/requests/${requestId}`);
  await expect(admin.page.getByTestId('report-decisions')).toBeVisible();

  if (resolution === 'DISMISSED') {
    await admin.page.getByTestId('report-dismiss').click();
    await expect(admin.page.getByTestId('report-decisions')).toHaveCount(0);
  } else {
    await admin.page
      .getByRole('group', { name: 'Talebi kaldır' })
      .locator('select[name="removalReason"]')
      .selectOption(removalReason);
    await admin.page.getByTestId('report-remove').click();
    await expect(admin.page.getByTestId('request-status')).toHaveText('Reddedildi');
    await expect(admin.page.getByTestId('report-decisions')).toHaveCount(0);
  }

  await expect(admin.page.getByTestId('report-error')).toHaveCount(0);
  await assertNoErrorScreen(admin.page);
}

/**
 * Puts a removed request back from the admin request screen and confirms it
 * went back to approved — in place first, then after a reload, for the same
 * reason `approveRequest` does both.
 */
export async function reopenRequest(admin: Actor, requestId: string): Promise<void> {
  await admin.gotoAdmin(`/requests/${requestId}`);
  await admin.page.getByTestId('report-reopen').click();
  await expect(admin.page.getByTestId('request-status')).toHaveText('Onaylandı');
  await expect(admin.page.getByTestId('report-reopen')).toHaveCount(0);
  await assertNoErrorScreen(admin.page);

  await admin.gotoAdmin(`/requests/${requestId}`);
  await expect(admin.page.getByTestId('request-status')).toHaveText('Onaylandı');
}

/* ---- provider reviews ---------------------------------------------------- */

/**
 * Marks the customer's matched request done from its offers page and waits
 * for the screen the action lands on.
 *
 * With reviews on, the action redirects to the review form; with them off,
 * back to the request. The caller says which it expects, and the wait is on
 * the page's own content rather than the URL — a server action is an
 * in-flight POST, and asserting the URL early would race it.
 */
export async function completeRequest(
  customer: Actor,
  requestId: string,
  expect_: 'review-form' | 'offers-page' = 'review-form',
): Promise<void> {
  await customer.gotoWeb(`/requests/${requestId}/offers`);
  await customer.page.getByRole('button', { name: 'Hizmet tamamlandı' }).click();

  if (expect_ === 'review-form') {
    await expect(customer.page.getByTestId('review-submit')).toBeVisible();
  } else {
    await expect(customer.page.getByTestId('request-status')).toHaveText('Tamamlandı');
    await expect(customer.page.getByTestId('request-review-cta')).toHaveCount(0);
  }
  await assertNoErrorScreen(customer.page);
}

/**
 * Rates the provider from the review page. The proof is the customer's own
 * review rendered back with the star they gave — the page re-reads the API
 * after the action, so what is asserted is the stored row, not the click.
 */
export async function submitReview(
  customer: Actor,
  requestId: string,
  rating: 1 | 2 | 3 | 4 | 5,
  comment?: string,
): Promise<void> {
  await customer.gotoWeb(`/requests/${requestId}/degerlendir`);
  await customer.page.getByTestId(`rating-${rating}`).check();
  if (comment) {
    await customer.page.getByTestId('review-comment').fill(comment);
  }
  await customer.page.getByTestId('review-submit').click();

  await expect(customer.page.getByTestId('review-done')).toBeVisible();
  await expect(customer.page.getByTestId('review-stars')).toHaveAttribute('data-value', String(rating));
  await assertNoErrorScreen(customer.page);
}

/** The reasons the provider's review report dialog offers, as the API stores them. */
export type ReviewReportReason =
  | 'OFFENSIVE'
  | 'CONTAINS_CONTACT_INFO'
  | 'NOT_ABOUT_THIS_JOB'
  | 'SUSPECTED_FAKE'
  | 'OTHER';

/**
 * Reports the first review on the provider's list, through the native
 * dialog, and waits for the page's "received" notice — by test id, for the
 * route-announcer reason `reportRequest` gives.
 */
export async function reportReview(
  provider: Actor,
  providerId: string,
  reason: ReviewReportReason,
  note?: string,
): Promise<void> {
  await provider.gotoWeb(`/providers/${providerId}/degerlendirmeler`);
  await provider.page.getByTestId('review-report-button').first().click();

  const dialog = provider.page.locator('dialog.report-dialog');
  await expect(dialog).toBeVisible();
  await provider.page.getByTestId('review-report-reason').selectOption(reason);
  if (note) {
    await provider.page.getByTestId('review-report-note').fill(note);
  }
  await provider.page.getByTestId('review-report-submit').click();

  await expect(provider.page.getByTestId('review-report-received')).toHaveCount(1);
  await expect(provider.page.getByTestId('review-row-report-open')).toHaveCount(1);
  await assertNoErrorScreen(provider.page);
}

/**
 * The operator's decision on one review, from its detail screen. The state
 * badge re-rendered after the action is the proof that the API applied it.
 */
export async function moderateReview(
  admin: Actor,
  reviewId: string,
  action: 'REMOVE_COMMENT' | 'REMOVE_REVIEW' | 'RESTORE',
  reason: ReviewReportReason = 'OTHER',
): Promise<void> {
  await admin.gotoAdmin(`/provider-reviews/${reviewId}`);
  await admin.page.getByTestId(`moderate-${action}`).click();
  await expect(admin.page.getByTestId('moderation-form')).toBeVisible();
  if (action !== 'RESTORE') {
    await admin.page.getByTestId('moderation-reason').selectOption(reason);
  }
  await admin.page.getByTestId('moderation-submit').click();

  const expected =
    action === 'RESTORE' ? 'Yayında' : action === 'REMOVE_COMMENT' ? 'Yorum kaldırıldı' : 'Kaldırıldı';
  await expect(admin.page.getByTestId('review-state')).toHaveText(expected);
  await expect(admin.page.getByTestId('review-ok')).toBeVisible();
  await assertNoErrorScreen(admin.page);
}

/**
 * Turns provider reviews on from the operations screen, the way an operator
 * does. Idempotent, and the same contract as `enableAutoPublish`: the
 * re-rendered switch carrying `aria-checked="true"` is the proof.
 */
export async function enableProviderReviews(admin: Actor): Promise<void> {
  await admin.gotoAdmin('/operations-settings');
  const toggle = admin.page.getByTestId('provider-reviews-toggle');
  await expect(toggle).toBeVisible();

  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
    await expect(admin.page.getByTestId('provider-reviews-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }
  await assertNoErrorScreen(admin.page);
}
