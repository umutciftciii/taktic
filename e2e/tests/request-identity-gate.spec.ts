import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { Actor, assertNoErrorScreen, expectNotFoundScreen } from '../src/actors';
import {
  createCategory,
  createClaimableCustomer,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
  type Location,
  type SeededCategory,
} from '../src/fixtures';
import { expectIdentityGateOpen, settleIdentityGate } from '../src/journeys';
import {
  emailCountFor,
  emailEntriesFor,
  smsEntriesFor,
  waitForLatestActivationUrl,
  waitForLatestSmsCode,
} from '../src/outbox';
import { primaryRuntime } from '../src/runtime';
import { seedApprovedShowcaseCard, seedLiveShowcasePlacement, showcaseAreaKey } from '../src/showcase-fixtures';

/**
 * The identity gate on both request forms, and the draft that carries a form
 * across sign-in and activation.
 *
 * A visitor's telephone number and e-mail are checked against the customer
 * records before anything else is asked. What the check answers decides the
 * way forward: a brand-new pair opens the gate; a pair that belongs to an
 * account sends its owner to sign in (or to activate) with the form parked as
 * a draft and restored when they come back; a pair that names two accounts, a
 * provider's number, or an answer that never arrived shuts the gate and says
 * why. Every one of those roads is driven here through the real screens — the
 * real sign-in page, the real activation link read from the test outbox, the
 * real SMS code — on the marketplace form and on the vitrin card's form,
 * because the two render the same contact section and the same notice slot
 * and have to behave as one.
 *
 * ## Draft budget and client addresses
 *
 * Parking a draft is rate limited per client IP: five per ten minutes, a
 * product rule rather than a deployment value. Every browser in this suite
 * arrives from the loopback address, so the suite runs its stacks under the
 * trusted-proxy contract (see playwright.config.ts) and each test here opens
 * its browser context with a client address of its own in X-Forwarded-For.
 * The web server forwards it verbatim and the API keys the throttle on it —
 * the production topology, with the browser standing in for the edge. The
 * last test spends a whole budget on purpose, which is why it must be last and
 * why it has an address nobody else uses.
 */

type FormKind = 'marketplace' | 'showcase';
const FORMS: readonly FormKind[] = ['marketplace', 'showcase'] as const;

const FORM_LABEL: Record<FormKind, string> = {
  marketplace: 'normal talep formu',
  showcase: 'vitrin formu',
};

const DRAFT_COOKIE = 'taktic_request_draft';
const CONFLICT_SENTENCE =
  'Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.';
const NEW_PASSWORD = 'YeniSifre123!';

/**
 * A client address nobody else in this run uses.
 *
 * Deterministic per test slot so a failure is reproducible, and distinct per
 * retry: Playwright starts a retry in a fresh worker process while the API's
 * throttle buckets outlive it, so an address reused across attempts would hand
 * the retry a budget the first attempt already spent.
 */
let addressSerial = 0;
function nextClientAddress(testInfo: TestInfo): string {
  addressSerial += 1;
  return `10.${77 + testInfo.retry}.${Math.floor(addressSerial / 200)}.${(addressSerial % 200) + 1}`;
}

/** A visitor with their own draft budget — see the note on client addresses. */
async function openVisitor(browser: Browser, testInfo: TestInfo): Promise<Actor> {
  return Actor.open(browser, 'web', primaryRuntime, {
    extraHTTPHeaders: { 'x-forwarded-for': nextClientAddress(testInfo) },
  });
}

/** What every scenario needs on the shelf before it starts. */
type Stage = {
  kind: FormKind;
  category: SeededCategory;
  location: Location;
  /** The vitrin card and its live run; absent for the marketplace form. */
  card: { id: string; placementId: string } | null;
};

/**
 * The runs this file put on the air, taken off it again after each test.
 *
 * The home page shelf is the feed's first page — twelve cards, oldest run
 * first — and the vitrin specs that follow this file alphabetically expect
 * the card they have just seeded to be on it. Thirteen live runs left behind
 * here would push every later card off that page. Ending a run is one update
 * on the placement row: status and end, the way the clock ends it, with
 * `endAt > startAt` (a CHECK) kept by one second.
 */
const placementsOnAir: string[] = [];

/**
 * The numbers this file proved, whose one-time codes are handed back to the
 * suite's shared budget after each test.
 *
 * Sending a code is limited per client address — ten an hour, counted from
 * the verification rows the API keeps — and the send happens inside a server
 * action, so every browser in this suite is the web server's own loopback
 * address to that counter, this file's per-test addresses notwithstanding.
 * Six of those ten would be spent here, and the vitrin specs that run after
 * this file need theirs. The rows are the receipts of real proofs and stay
 * exactly as they are; only their timestamp is moved out of the hour the
 * counter looks at, once the test that made them is over.
 */
const provedPhones: string[] = [];

test.afterEach(async () => {
  const db = prisma();

  if (provedPhones.length > 0) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.phoneVerification.updateMany({
      where: { normalizedPhone: { in: provedPhones.splice(0).map(toE164) } },
      data: { createdAt: twoHoursAgo },
    });
  }

  for (const id of placementsOnAir.splice(0)) {
    const run = await db.showcasePlacement.findUnique({ where: { id }, select: { startAt: true } });
    if (!run) continue;
    await db.showcasePlacement.update({
      where: { id },
      data: { status: 'EXPIRED', endAt: new Date(run.startAt.getTime() + 1000) },
    });
  }
});

async function seedStage(kind: FormKind, namePrefix: string): Promise<Stage> {
  const location = uniqueLocation();
  const category = await createCategory(3, { namePrefix });

  if (kind === 'marketplace') {
    return { kind, category, location, card: null };
  }

  const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: owner.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    // Unique per attempt so a retry never meets the previous attempt's card.
    title: `${namePrefix} ${uniqueSuffix()}`,
  });
  const { placement } = await seedLiveShowcasePlacement({
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });

  placementsOnAir.push(placement.id);
  return { kind, category, location, card: { id: card.id, placementId: placement.id } };
}

/** The form's own path — what sign-in and activation are told to come back to. */
function formPath(stage: Stage): string {
  return stage.kind === 'marketplace'
    ? `/categories/${stage.category.slug}`
    : `/vitrin/${stage.card?.id}?step=form`;
}

async function openForm(actor: Actor, stage: Stage): Promise<void> {
  await actor.gotoWeb(formPath(stage));
  await assertNoErrorScreen(actor.page);
  if (stage.kind === 'marketplace') {
    await expect(actor.page.getByRole('heading', { name: stage.category.name })).toBeVisible();
    await expect(actor.page.locator('#request-step-contact')).toBeVisible();
  } else {
    await expect(actor.page.getByTestId('showcase-lead-form')).toBeVisible();
  }
}

type Contact = { name: string; phone: string; email: string };

function freshContact(label: string): Contact {
  return {
    name: `E2E ${label}`,
    phone: uniquePhone(),
    email: `e2e-gate-${uniqueSuffix()}@example.test`,
  };
}

/** The three guest fields, in either form's spelling. */
function contactFields(page: Page, kind: FormKind) {
  if (kind === 'marketplace') {
    const form = page.locator('form.form-card');
    return {
      name: form.locator('input[name="customerName"]'),
      phone: form.locator('input[name="customerPhone"]'),
      email: form.locator('input[name="customerEmail"]'),
    };
  }
  return {
    name: page.getByLabel('Ad soyad *'),
    phone: page.getByLabel('Telefon *'),
    email: page.getByLabel('E-posta *'),
  };
}

/**
 * Types the guest contact and returns the field left last — the one whose
 * blur starts the check. Name, then e-mail, then the number on the vitrin
 * form (its proof binds to the number, so the number is the natural last
 * field there); name, number, e-mail on the marketplace form.
 */
async function typeContact(page: Page, kind: FormKind, contact: Contact): Promise<Locator> {
  const fields = contactFields(page, kind);
  await fields.name.fill(contact.name);
  if (kind === 'showcase') {
    await fields.email.fill(contact.email);
    await fields.phone.fill(contact.phone);
    return fields.phone;
  }
  await fields.phone.fill(contact.phone);
  await fields.email.fill(contact.email);
  return fields.email;
}

/** Leaves the field and waits for the pre-check the blur started to answer, whatever it says. */
async function leaveContact(page: Page, lastField: Locator): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/auth\/request-identity-check$/.test(new URL(response.url()).pathname),
  );
  await lastField.blur();
  await answered;
}

/** Types the contact, leaves it, and expects the named refusal on screen. */
async function typeContactExpecting(
  page: Page,
  kind: FormKind,
  contact: Contact,
  refusal: string,
): Promise<void> {
  const last = await typeContact(page, kind, contact);
  await leaveContact(page, last);
  await expect(page.getByTestId(refusal)).toBeVisible();
  await expect(page.getByTestId('identity-checking')).toHaveCount(0);
}

/**
 * The control that leads on from the contact section: "Devam et" on the
 * marketplace form, "Kod gönder" on the vitrin form.
 */
function advanceControl(page: Page, kind: FormKind): Locator {
  return kind === 'marketplace'
    ? page.getByRole('button', { name: 'Devam et' })
    : page.getByTestId('showcase-lead-phone-send');
}

/**
 * Asserts the gate is shut the way each form shuts it. The vitrin button is
 * disabled outright. The marketplace button stays clickable so a click can
 * re-run the check — it is marked aria-disabled, and clicking it does not
 * leave the contact step.
 */
async function expectGateShut(page: Page, kind: FormKind): Promise<void> {
  const control = advanceControl(page, kind);
  if (kind === 'showcase') {
    await expect(control).toBeDisabled();
    await expect(page.getByTestId('showcase-lead-submit')).toBeDisabled();
    return;
  }
  await expect(control).toHaveAttribute('aria-disabled', 'true');
  // A person can press this button — it is marked, not disabled — so the
  // click goes through without Playwright's own enabled check standing in.
  await control.click({ force: true });
  await expect(page.locator('#request-step-contact')).toBeVisible();
  await expect(page.locator('#request-step-detail')).toBeHidden();
}

const SHOWCASE_DESCRIPTION = 'Salon kliması bakım istiyorum, iki gündür soğutmuyor.';
const MARKETPLACE_DESCRIPTION = 'Salon klimasının montajı ve ilk bakımı gerekiyor.';

/** Everything on the vitrin form but the contact: what a draft has to carry. */
async function fillShowcaseBody(page: Page, location: Location): Promise<void> {
  await page.getByLabel('Açıklama *').fill(SHOWCASE_DESCRIPTION);
  await page.getByTestId('request-city').selectOption(location.city);
  await page.getByTestId('request-district').selectOption(location.district);
  await page.getByTestId('showcase-lead-urgency').selectOption('THIS_WEEK');
  await page.getByTestId('showcase-urgency-urgent').check();
}

/** The vitrin draft, field by field, exactly as it was typed. */
async function expectShowcaseBodyRestored(page: Page, location: Location): Promise<void> {
  await expect(page.getByLabel('Açıklama *')).toHaveValue(SHOWCASE_DESCRIPTION);
  await expect(page.getByTestId('request-city')).toHaveValue(location.city);
  await expect(page.getByTestId('request-district')).toHaveValue(location.district);
  await expect(page.getByTestId('showcase-lead-urgency')).toHaveValue('THIS_WEEK');
  await expect(page.getByTestId('showcase-urgency-urgent')).toBeChecked();
}

/** The national form the fixtures allocate ("0555…"), as the API stores it. */
function toE164(nationalPhone: string): string {
  return `+90${nationalPhone.replace(/\D/g, '').slice(-10)}`;
}

/** Proves a number inside the vitrin form; the gate has to be open already. */
async function proveShowcasePhone(page: Page, phone: string): Promise<void> {
  provedPhones.push(phone);
  const send = page.getByTestId('showcase-lead-phone-send');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId('showcase-lead-phone-code')).toBeVisible();
  const code = await waitForLatestSmsCode(phone);
  await page.getByTestId('showcase-lead-code').fill(code);
  await page.getByTestId('showcase-lead-phone-verify').click();
  await expect(page.getByTestId('showcase-lead-phone-verified')).toBeVisible();
}

/** Sends the vitrin form and expects the card's "sent" notice. */
async function submitShowcaseLead(page: Page): Promise<void> {
  await page.getByTestId('showcase-lead-submit').click();
  await assertNoErrorScreen(page);
  await expect(page.getByTestId('showcase-lead-sent')).toBeVisible();
}

/**
 * The lira the marketplace body names as its minimum budget: as typed, as the
 * field groups it while typing, and as it comes back from a draft — the draft
 * holds kuruş, and a restored amount is written out with them.
 */
const MARKETPLACE_BUDGET_TYPED = '1500';
const MARKETPLACE_BUDGET_SHOWN = '1.500';
const MARKETPLACE_BUDGET_RESTORED = '1.500,00';

/**
 * Walks the marketplace form from the contact step to its last step, filling
 * everything but the contact: what a draft has to carry. The contact step has
 * to be passable already — gate open, or a signed-in customer. Leaves the
 * form on its last step, ready to send.
 */
async function fillMarketplaceBody(page: Page, location: Location): Promise<void> {
  const form = page.locator('form.form-card');
  const next = page.getByRole('button', { name: 'Devam et' });

  await next.click();
  await expect(page.locator('#request-step-detail')).toBeVisible();
  await form.locator('textarea[name="description"]').fill(MARKETPLACE_DESCRIPTION);
  await next.click();
  await expect(page.locator('#request-step-place')).toBeVisible();
  await form.locator('select[name="city"]').selectOption(location.city);
  await form.locator('select[name="district"]').selectOption(location.district);
  await form.getByTestId('request-urgency').selectOption('THIS_WEEK');
  await form.getByTestId('request-budget-min').fill(MARKETPLACE_BUDGET_TYPED);
  await expect(form.getByTestId('request-budget-min')).toHaveValue(MARKETPLACE_BUDGET_SHOWN);
}

/**
 * The marketplace draft, field by field, exactly as it was typed — walked
 * step by step with the form's own "Devam et", so every field is asserted
 * while it is on screen. Leaves the form on its last step, ready to send.
 */
async function expectMarketplaceBodyRestored(page: Page, location: Location): Promise<void> {
  const form = page.locator('form.form-card');
  const next = page.getByRole('button', { name: 'Devam et' });

  await next.click();
  await expect(page.locator('#request-step-detail')).toBeVisible();
  await expect(form.locator('textarea[name="description"]')).toHaveValue(MARKETPLACE_DESCRIPTION);
  await next.click();
  await expect(page.locator('#request-step-place')).toBeVisible();
  await expect(form.getByTestId('request-city')).toHaveValue(location.city);
  await expect(form.getByTestId('request-district')).toHaveValue(location.district);
  await expect(form.getByTestId('request-urgency')).toHaveValue('THIS_WEEK');
  await expect(form.getByTestId('request-budget-min')).toHaveValue(MARKETPLACE_BUDGET_RESTORED);
}

/** Sends the marketplace form from its last step. Returns the new request's id from the success page. */
async function submitMarketplaceForm(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Talebi Gönder' }).click();
  await expect(page).toHaveURL(/\/requests\/success\?id=/);
  await assertNoErrorScreen(page);
  const id = new URL(page.url()).searchParams.get('id');
  expect(id, 'the success page must carry the new request id').toBeTruthy();
  return id as string;
}

/** Walks the marketplace form from the contact step to the end and sends it. */
async function finishMarketplaceForm(page: Page, location: Location): Promise<string> {
  await fillMarketplaceBody(page, location);
  return submitMarketplaceForm(page);
}

/**
 * Fills the marketplace form's body as a brand-new visitor, then comes back
 * to the contact step — the way a person who typed the whole request before
 * remembering they have an account arrives at the gate. The marketplace form
 * cannot leave its first step until the gate opens, so the body has to be
 * written behind a pair the check lets through; the pair that then gets
 * typed over it is what the draft is bound to.
 */
async function writeMarketplaceBodyThenReturnToContact(page: Page, location: Location): Promise<void> {
  const last = await typeContact(page, 'marketplace', freshContact('Önce Yazan'));
  await settleIdentityGate(page, last);
  await fillMarketplaceBody(page, location);
  await page.getByRole('tab', { name: /İletişim/ }).click();
  await expect(page.locator('#request-step-contact')).toBeVisible();
  await expect(page.locator('#request-step-place')).toBeHidden();
}

/** The request the vitrin lead on this card created. */
async function leadRequestFor(cardId: string) {
  const lead = await prisma().showcaseLead.findFirstOrThrow({
    where: { cardId },
    include: { request: true },
  });
  return lead.request;
}

/**
 * Signs in on the sign-in page the form led to — not through `loginToWeb`,
 * which navigates there itself: the point is that the page the form opened
 * carries the form as its destination.
 */
async function signInHere(page: Page, back: string, email: string, password: string): Promise<void> {
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(back);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Giriş Yap' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await assertNoErrorScreen(page);
}

/** Clicks "Giriş yap" in the notice and waits for the sign-in page it opens. */
async function leaveThroughLoginCta(page: Page, back: string): Promise<void> {
  await page.getByTestId('identity-login-cta').click();
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(back);
}

/** Signs out through the public header's account menu, from the home page. */
async function signOut(page: Page): Promise<void> {
  await page.goto(new URL('/', page.url()).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Kullanıcı menüsü').click();
  await page.locator('[role="menu"] button').filter({ hasText: /Çıkış/i }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Sets a password on the activation page and lands wherever it redirects. */
async function activateWithPassword(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Şifre belirleyin' })).toBeVisible();
  await page.locator('input[name="password"]').fill(NEW_PASSWORD);
  await page.locator('input[name="passwordConfirm"]').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Şifreyi Kaydet' }).click();
  await expect(page).not.toHaveURL(/\/activate-customer/);
  await assertNoErrorScreen(page);
}

async function draftCookie(actor: Actor) {
  const cookies = await actor.context.cookies();
  return cookies.find((cookie) => cookie.name === DRAFT_COOKIE) ?? null;
}

/** The counts a scenario has to leave unchanged. */
async function counts() {
  const db = prisma();
  return {
    requests: await db.serviceRequest.count(),
    leads: await db.showcaseLead.count(),
    openDrafts: await db.requestDraft.count({ where: { consumedAt: null } }),
    users: await db.user.count(),
  };
}

test.describe('kimlik gate’i: her iki talep formu', () => {
  for (const kind of FORMS) {
    // ── 1 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: yeni telefon ve e-posta kontrolden geçer, talep taslaksız oluşur`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Yeni');
      const visitor = await openVisitor(browser, testInfo);
      const contact = freshContact('Yeni Müşteri');

      try {
        await openForm(visitor, stage);
        const before = await counts();

        // Hold the answer back for a moment so the in-flight state is on screen
        // long enough to be seen, then let the real one through.
        await visitor.page.route('**/api/auth/request-identity-check', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 700));
          await route.continue();
        });

        if (kind === 'showcase') await fillShowcaseBody(visitor.page, stage.location);
        const last = await typeContact(visitor.page, kind, contact);
        const answered = visitor.page.waitForResponse((response) =>
          /\/api\/auth\/request-identity-check$/.test(new URL(response.url()).pathname),
        );
        await last.blur();
        await expect(visitor.page.getByTestId('identity-checking')).toBeVisible();
        // While the check is in flight nothing moves on — both forms hold
        // their button, not merely mark it.
        await expect(advanceControl(visitor.page, kind)).toBeDisabled();
        await answered;
        await expectIdentityGateOpen(visitor.page);
        await visitor.page.unroute('**/api/auth/request-identity-check');

        if (kind === 'marketplace') {
          const requestId = await finishMarketplaceForm(visitor.page, stage.location);
          const request = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
          expect(request.customerPhone).toBe(contact.phone);
        } else {
          await proveShowcasePhone(visitor.page, contact.phone);
          await submitShowcaseLead(visitor.page);
          const request = await leadRequestFor(stage.card!.id);
          expect(request.customerPhone).toBe(contact.phone);
        }

        // No draft was ever parked for a visitor who never left, and the
        // browser holds no token for one.
        const after = await counts();
        expect(after.openDrafts).toBe(before.openDrafts);
        expect(await draftCookie(visitor)).toBeNull();
      } finally {
        await visitor.close();
      }
    });

    // ── 2 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: kayıtlı müşteri giriş yapmaya gönderilir; taslak geri gelir ve talep hesabına yazılır`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Giriş');
      const customer = await createCustomer('E2E Gate Kayıtlı');
      const visitor = await openVisitor(browser, testInfo);
      const back = formPath(stage);

      try {
        await openForm(visitor, stage);
        // Both drafts carry a whole request. The vitrin form takes the request
        // before the contact; the marketplace form is written through with a
        // new pair first and the registered pair typed over it on the way
        // back — a plain leaf category, so the draft is keyed by the slug the
        // page shows (a routed flow keys it by the entry slug instead; that
        // path is not driven here).
        if (kind === 'showcase') await fillShowcaseBody(visitor.page, stage.location);
        else await writeMarketplaceBodyThenReturnToContact(visitor.page, stage.location);

        await typeContactExpecting(
          visitor.page,
          kind,
          { name: customer.name, phone: customer.phone, email: customer.email },
          'identity-login-required',
        );
        await expectGateShut(visitor.page, kind);
        // A registered person is never sent a code from here.
        expect(smsEntriesFor(customer.phone)).toHaveLength(0);

        const draftsBefore = await prisma().requestDraft.count();
        await leaveThroughLoginCta(visitor.page, back);

        // The draft exists, bound to the account the pair names, and the
        // browser carries its token.
        expect(await prisma().requestDraft.count()).toBe(draftsBefore + 1);
        const draft = await prisma().requestDraft.findFirstOrThrow({
          where: { expectedUserId: customer.id, consumedAt: null },
        });
        expect(draft.formType).toBe(kind === 'marketplace' ? 'MARKETPLACE' : 'SHOWCASE_LEAD');
        expect(draft.categorySlug).toBe(stage.category.slug);
        expect(draft.cardId).toBe(stage.card?.id ?? null);
        expect(await draftCookie(visitor)).not.toBeNull();

        await signInHere(visitor.page, back, customer.email, customer.password);
        await expect(visitor.page).toHaveURL(new RegExp(back.replace(/[?]/g, '\\?')));

        // Contact comes from the account now; the notice slot is gone with the
        // guest fields.
        const summary = visitor.page.getByTestId('account-contact-summary');
        await expect(summary).toBeVisible();
        await expect(summary.getByTestId('account-contact-phone')).toHaveText(customer.phone);
        await expect(visitor.page.getByTestId('identity-login-required')).toHaveCount(0);
        await expect(visitor.page.getByTestId('identity-wrong-account')).toHaveCount(0);

        // What was typed before leaving is back, field by field, and the
        // request that goes out is the account's.
        if (kind === 'marketplace') {
          await expectMarketplaceBodyRestored(visitor.page, stage.location);
          const requestId = await submitMarketplaceForm(visitor.page);
          const request = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
          expect(request.customerId).toBe(customer.id);
          expect(request.description).toBe(MARKETPLACE_DESCRIPTION);
          expect(request.district).toBe(stage.location.district);
        } else {
          await expectShowcaseBodyRestored(visitor.page, stage.location);
          await proveShowcasePhone(visitor.page, customer.phone);
          await submitShowcaseLead(visitor.page);
          const request = await leadRequestFor(stage.card!.id);
          expect(request.customerId).toBe(customer.id);
        }

        // The draft was used up by the request and the browser dropped its token.
        const consumed = await prisma().requestDraft.findUniqueOrThrow({ where: { id: draft.id } });
        expect(consumed.consumedAt).not.toBeNull();
        expect(consumed.userId).toBe(customer.id);
        expect(await draftCookie(visitor)).toBeNull();
      } finally {
        await visitor.close();
      }
    });

    // ── 3 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: yanlış hesapla dönen müşteri uyarılır; hesap değiştirince taslak doğru hesapla geri gelir`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Yanlış Hesap');
      const owner = await createCustomer('E2E Gate Sahip');
      const other = await createCustomer('E2E Gate Diğer');
      const visitor = await openVisitor(browser, testInfo);
      const back = formPath(stage);

      try {
        await openForm(visitor, stage);
        if (kind === 'showcase') await fillShowcaseBody(visitor.page, stage.location);
        else await writeMarketplaceBodyThenReturnToContact(visitor.page, stage.location);
        await typeContactExpecting(
          visitor.page,
          kind,
          { name: owner.name, phone: owner.phone, email: owner.email },
          'identity-login-required',
        );
        await leaveThroughLoginCta(visitor.page, back);
        const draft = await prisma().requestDraft.findFirstOrThrow({
          where: { expectedUserId: owner.id, consumedAt: null },
        });
        const cookieBefore = await draftCookie(visitor);
        expect(cookieBefore).not.toBeNull();
        const before = await counts();

        // The wrong customer signs in and lands on the form.
        await signInHere(visitor.page, back, other.email, other.password);
        const wrongAccount = visitor.page.getByTestId('identity-wrong-account');
        await expect(wrongAccount).toBeVisible();
        await expect(wrongAccount).toContainText(
          'Bu talebe devam etmek için iletişim bilgilerine bağlı hesabınızla giriş yapın.',
        );
        // The form is theirs and empty: nothing of the draft is shown to them,
        // and nothing can be sent from this session as it stands.
        if (kind === 'showcase') {
          await expect(visitor.page.getByLabel('Açıklama *')).toHaveValue('');
          await expect(visitor.page.getByTestId('request-district')).toHaveValue('');
          await expect(visitor.page.getByTestId('showcase-urgency-urgent')).not.toBeChecked();
          await expect(visitor.page.getByTestId('showcase-lead-submit')).toBeDisabled();
        } else {
          await expect(visitor.page.getByTestId('account-contact-email')).toHaveText(other.email);
          await expect(
            visitor.page.locator('form.form-card textarea[name="description"]'),
          ).toHaveValue('');
          await expect(visitor.page.locator('form.form-card select[name="district"]')).toHaveValue('');
          await expect(visitor.page.getByTestId('request-submit-error')).toHaveCount(0);
          await expect(visitor.page).not.toHaveURL(/\/requests\/success/);
        }
        // And the row is exactly as it was: still the owner's, bound to nobody.
        const untouched = await prisma().requestDraft.findUniqueOrThrow({ where: { id: draft.id } });
        expect(untouched.tokenHash).toBe(draft.tokenHash);
        expect(untouched.expectedUserId).toBe(owner.id);
        expect(untouched.userId).toBeNull();
        expect(untouched.consumedAt).toBeNull();

        /*
         * The wrong account is still a customer with a form of their own, and
         * may send a request from it. That request is theirs; it neither uses
         * up the owner's draft nor takes the browser's way back to it — the
         * token stays in the cookie jar, and the form, opened again, still
         * says whose the draft is. (The vitrin form would need the wrong
         * account's number proved first; the marketplace form is enough to
         * hold the rule.)
         */
        let wrongAccountRequests = 0;
        if (kind === 'marketplace') {
          await fillMarketplaceBody(visitor.page, stage.location);
          const theirs = await submitMarketplaceForm(visitor.page);
          const theirRequest = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: theirs } });
          expect(theirRequest.customerId).toBe(other.id);
          wrongAccountRequests = 1;

          const survived = await prisma().requestDraft.findUniqueOrThrow({ where: { id: draft.id } });
          expect(survived.consumedAt).toBeNull();
          expect(survived.userId).toBeNull();
          expect(survived.expectedUserId).toBe(owner.id);
          expect((await draftCookie(visitor))?.value).toBe(cookieBefore?.value);

          await openForm(visitor, stage);
          await expect(visitor.page.getByTestId('identity-wrong-account')).toBeVisible();
        }

        // "Hesap değiştir": signed out, back to sign-in with the form as the destination.
        await visitor.page.getByTestId('identity-change-account-cta').click();
        await signInHere(visitor.page, back, owner.email, owner.password);

        await expect(visitor.page.getByTestId('identity-wrong-account')).toHaveCount(0);
        await expect(visitor.page.getByTestId('account-contact-email')).toHaveText(owner.email);

        // The owner's draft comes back whole, and the request that goes out is theirs.
        if (kind === 'marketplace') {
          await expectMarketplaceBodyRestored(visitor.page, stage.location);
          const requestId = await submitMarketplaceForm(visitor.page);
          const request = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
          expect(request.customerId).toBe(owner.id);
          expect(request.description).toBe(MARKETPLACE_DESCRIPTION);
        } else {
          await expectShowcaseBodyRestored(visitor.page, stage.location);
          await proveShowcasePhone(visitor.page, owner.phone);
          await submitShowcaseLead(visitor.page);
          const request = await leadRequestFor(stage.card!.id);
          expect(request.customerId).toBe(owner.id);
        }

        // The owner's request, plus whatever the wrong account sent as
        // itself; the wrong account's visit consumed nothing of the owner's.
        const after = await counts();
        expect(after.requests).toBe(before.requests + 1 + wrongAccountRequests);
        const consumed = await prisma().requestDraft.findUniqueOrThrow({ where: { id: draft.id } });
        expect(consumed.consumedAt).not.toBeNull();
        expect(consumed.userId).toBe(owner.id);
        expect(await draftCookie(visitor)).toBeNull();
      } finally {
        await visitor.close();
      }
    });

    // ── 4 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: şifresiz hesap etkinleştirme bağlantısını yalnız kayıtlı e-postasına alır; şifre sonrası forma döner`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Etkinleştir');
      const claimable = await createClaimableCustomer();
      const visitor = await openVisitor(browser, testInfo);
      const back = formPath(stage);
      // The number is the account's; the address is not — and the link must
      // go to the account's own address, never to the one typed here.
      const typedEmail = `e2e-gate-typed-${uniqueSuffix()}@example.test`;

      try {
        await openForm(visitor, stage);
        if (kind === 'showcase') await fillShowcaseBody(visitor.page, stage.location);
        await typeContactExpecting(
          visitor.page,
          kind,
          { name: claimable.name, phone: claimable.phone, email: typedEmail },
          'identity-activation-required',
        );
        await expectGateShut(visitor.page, kind);

        const mailsBefore = emailCountFor(claimable.email, 'customer-activation');
        await visitor.page.getByTestId('identity-activate-cta').click();
        await expect(visitor.page.getByTestId('identity-activation-sent')).toBeVisible();
        // Nothing navigated: the draft was parked and the person stays here to
        // go and read their mail.
        await expect(visitor.page).toHaveURL(new RegExp(back.replace(/[?]/g, '\\?')));
        const draft = await prisma().requestDraft.findFirstOrThrow({
          where: { expectedUserId: claimable.id, consumedAt: null },
        });

        const activationUrl = await waitForLatestActivationUrl(claimable.email);
        expect(emailCountFor(claimable.email, 'customer-activation')).toBe(mailsBefore + 1);
        // The address typed into the form receives nothing at all — not the
        // activation link, not any other message.
        expect(emailEntriesFor(typedEmail)).toHaveLength(0);
        expect(new URL(activationUrl).searchParams.get('redirectTo')).toBe(back);

        // The link, as from an inbox: a password, then straight back to the form, signed in.
        await visitor.page.goto(activationUrl, { waitUntil: 'domcontentloaded' });
        await activateWithPassword(visitor.page);
        await expect(visitor.page).toHaveURL(new RegExp(back.replace(/[?]/g, '\\?')));

        const summary = visitor.page.getByTestId('account-contact-summary');
        await expect(summary).toBeVisible();
        await expect(summary.getByTestId('account-contact-email')).toHaveText(claimable.email);

        if (kind === 'marketplace') {
          const requestId = await finishMarketplaceForm(visitor.page, stage.location);
          const request = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
          expect(request.customerId).toBe(claimable.id);
        } else {
          await expectShowcaseBodyRestored(visitor.page, stage.location);
          await proveShowcasePhone(visitor.page, claimable.phone);
          await submitShowcaseLead(visitor.page);
          const request = await leadRequestFor(stage.card!.id);
          expect(request.customerId).toBe(claimable.id);
        }

        const consumed = await prisma().requestDraft.findUniqueOrThrow({ where: { id: draft.id } });
        expect(consumed.consumedAt).not.toBeNull();
        const account = await prisma().user.findUniqueOrThrow({ where: { id: claimable.id } });
        expect(account.passwordHash).not.toBeNull();
      } finally {
        await visitor.close();
      }
    });

    // ── 5 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: iki farklı müşterinin telefonu ve e-postası reddedilir; SMS, talep ve taslak yok`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Çakışma');
      const phoneOwner = await createCustomer('E2E Gate Telefon Sahibi');
      const emailOwner = await createCustomer('E2E Gate E-posta Sahibi');
      const visitor = await openVisitor(browser, testInfo);

      try {
        await openForm(visitor, stage);
        if (kind === 'showcase') await fillShowcaseBody(visitor.page, stage.location);
        const before = await counts();

        await typeContactExpecting(
          visitor.page,
          kind,
          { name: 'E2E Çakışan Kişi', phone: phoneOwner.phone, email: emailOwner.email },
          'identity-conflict',
        );
        await expect(visitor.page.getByTestId('identity-conflict')).toHaveText(CONFLICT_SENTENCE);
        await expectGateShut(visitor.page, kind);
        // No way to sign in or activate is offered: the pair names no one account.
        await expect(visitor.page.getByTestId('identity-login-cta')).toHaveCount(0);
        await expect(visitor.page.getByTestId('identity-activate-cta')).toHaveCount(0);

        expect(smsEntriesFor(phoneOwner.phone)).toHaveLength(0);
        expect(await counts()).toEqual(before);
        expect(await draftCookie(visitor)).toBeNull();
      } finally {
        await visitor.close();
      }
    });

    // ── 6 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: hizmet veren hesabının telefonu müşteri talebi için kullanılamaz`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Hizmet Veren');
      const provider = await createProvider({ categoryId: stage.category.id, location: stage.location, credits: 0 });
      const providerAccount = await prisma().user.findUniqueOrThrow({
        where: { id: provider.userId },
        select: { phone: true },
      });
      const visitor = await openVisitor(browser, testInfo);

      try {
        await openForm(visitor, stage);
        const before = await counts();
        await typeContactExpecting(
          visitor.page,
          kind,
          { name: 'E2E Yanlış Numara', phone: providerAccount.phone ?? '', email: `e2e-gate-${uniqueSuffix()}@example.test` },
          'identity-unavailable',
        );
        await expect(visitor.page.getByTestId('identity-unavailable')).toContainText(
          'Bu iletişim bilgileri müşteri talebi için kullanılamaz.',
        );
        await expectGateShut(visitor.page, kind);
        // The refusal says nothing about *whose* number it is — no role, no
        // account, no way in.
        await expect(visitor.page.getByTestId('identity-login-cta')).toHaveCount(0);
        await expect(visitor.page.getByText(provider.businessName)).toHaveCount(0);
        expect(await counts()).toEqual(before);
      } finally {
        await visitor.close();
      }
    });

    // ── 7 ─────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: kontrol yanıtsız kalırsa gate kapalı kalır; "Tekrar dene" açar`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Ağ Hatası');
      const visitor = await openVisitor(browser, testInfo);
      const contact = freshContact('Sabırlı Müşteri');

      try {
        await openForm(visitor, stage);
        await visitor.page.route('**/api/auth/request-identity-check', (route) =>
          route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
        );

        const last = await typeContact(visitor.page, kind, contact);
        await leaveContact(visitor.page, last);
        const error = visitor.page.getByTestId('identity-error');
        await expect(error).toBeVisible();
        await expect(error).toContainText('İletişim bilgileri doğrulanamadı, tekrar deneyin.');
        // A failed check is not a passed one.
        await expectGateShut(visitor.page, kind);

        await visitor.page.unroute('**/api/auth/request-identity-check');
        const answered = visitor.page.waitForResponse((response) =>
          /\/api\/auth\/request-identity-check$/.test(new URL(response.url()).pathname),
        );
        await error.getByRole('button', { name: 'Tekrar dene' }).click();
        await answered;
        await expectIdentityGateOpen(visitor.page);

        if (kind === 'showcase') {
          await expect(advanceControl(visitor.page, kind)).toBeEnabled();
        } else {
          await advanceControl(visitor.page, kind).click();
          await expect(visitor.page.locator('#request-step-detail')).toBeVisible();
        }
      } finally {
        await visitor.close();
      }
    });

    // ── 10 ────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: oturumlu müşterinin farklı iletişim kişisi kontrol edilmez; talep oturumdaki hesaba yazılır`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Oturumlu');
      const customer = await createCustomer('E2E Gate Oturumlu');
      // The person named as the contact already has an account of their own —
      // the very pair a guest would be sent to sign in for.
      const contactPerson = await createCustomer('E2E Gate İletişim Kişisi');
      const visitor = await openVisitor(browser, testInfo);

      try {
        await visitor.loginToWeb(customer.email, customer.password);
        await openForm(visitor, stage);
        const before = await counts();

        await visitor.page.getByTestId('use-alternate-contact').check();
        const fields = contactFields(visitor.page, kind);
        await fields.name.fill(contactPerson.name);
        await fields.phone.fill(contactPerson.phone);
        await fields.email.fill(contactPerson.email);
        await fields.email.blur();
        await fields.phone.blur();

        // No check, no notice: the session already answered who this is.
        for (const id of [
          'identity-checking',
          'identity-login-required',
          'identity-activation-required',
          'identity-conflict',
          'identity-unavailable',
          'identity-error',
          'identity-wrong-account',
        ]) {
          await expect(visitor.page.getByTestId(id)).toHaveCount(0);
        }

        if (kind === 'marketplace') {
          const requestId = await finishMarketplaceForm(visitor.page, stage.location);
          const request = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
          expect(request.customerId).toBe(customer.id);
          expect(request.customerPhone).toBe(contactPerson.phone);
        } else {
          await fillShowcaseBody(visitor.page, stage.location);
          await proveShowcasePhone(visitor.page, contactPerson.phone);
          await submitShowcaseLead(visitor.page);
          const request = await leadRequestFor(stage.card!.id);
          expect(request.customerId).toBe(customer.id);
          expect(request.customerPhone).toBe(contactPerson.phone);
        }

        // No account was created or touched for the contact person.
        const after = await counts();
        expect(after.users).toBe(before.users);
        expect(after.openDrafts).toBe(before.openDrafts);
      } finally {
        await visitor.close();
      }
    });

    // ── 11 ────────────────────────────────────────────────────────────────
    test(`${FORM_LABEL[kind]}: misafire "farklı iletişim kişisi" seçeneği sunulmaz`, async ({
      browser,
    }, testInfo) => {
      const stage = await seedStage(kind, 'E2E Gate Misafir');
      const visitor = await openVisitor(browser, testInfo);

      try {
        await openForm(visitor, stage);
        await expect(visitor.page.getByTestId('use-alternate-contact')).toHaveCount(0);
        await expect(visitor.page.getByTestId('alternate-contact-fields')).toHaveCount(0);
        await expect(visitor.page.getByTestId('account-contact-summary')).toHaveCount(0);
        // The three fields are asked for instead.
        const fields = contactFields(visitor.page, kind);
        await expect(fields.name).toBeVisible();
        await expect(fields.phone).toBeVisible();
        await expect(fields.email).toBeVisible();
      } finally {
        await visitor.close();
      }
    });
  }

  // ── 8 (vitrin) ──────────────────────────────────────────────────────────
  test('vitrin formu: taslakla dönüldüğünde yayın bitmişse kart yok; kapsam değişmişse talep açılmaz', async ({
    browser,
  }, testInfo) => {
    // Two cards, one per half: the first goes off the air while its customer
    // is signing in, the second changes what it covers.
    const closing = await seedStage('showcase', 'E2E Gate Kapanan');
    const moving = await seedStage('showcase', 'E2E Gate Kapsam');
    const customer = await createCustomer('E2E Gate Dönen');
    const visitor = await openVisitor(browser, testInfo);

    try {
      // ── The run ends between leaving and coming back ──────────────────
      await openForm(visitor, closing);
      await fillShowcaseBody(visitor.page, closing.location);
      await typeContactExpecting(
        visitor.page,
        'showcase',
        { name: customer.name, phone: customer.phone, email: customer.email },
        'identity-login-required',
      );
      await leaveThroughLoginCta(visitor.page, formPath(closing));
      const leadsBefore = await prisma().showcaseLead.count();

      // The run ends the way the clock ends it: its last day is behind us.
      // `endAt > startAt` is a CHECK, so one second after the start.
      const run = await prisma().showcasePlacement.findUniqueOrThrow({
        where: { id: closing.card!.placementId },
      });
      await prisma().showcasePlacement.update({
        where: { id: run.id },
        data: { status: 'EXPIRED', endAt: new Date(run.startAt.getTime() + 1000) },
      });

      // Sign-in lands on the form's path, and the path is now a 404 — no
      // form, no draft on screen, no lead.
      await expect(visitor.page).toHaveURL(/\/login\?/);
      await visitor.page.locator('input[name="email"]').fill(customer.email);
      await visitor.page.locator('input[name="password"]').fill(customer.password);
      await visitor.page.getByRole('button', { name: 'Giriş Yap' }).click();
      await expect(visitor.page).toHaveURL(new RegExp(`/vitrin/${closing.card!.id}`));
      await expectNotFoundScreen(visitor.page);
      await expect(visitor.page.getByTestId('showcase-lead-form')).toHaveCount(0);
      expect(await prisma().showcaseLead.count()).toBe(leadsBefore);

      // ── The run stays live but no longer covers the draft's address ───
      await signOut(visitor.page);
      await openForm(visitor, moving);
      await fillShowcaseBody(visitor.page, moving.location);
      await typeContactExpecting(
        visitor.page,
        'showcase',
        { name: customer.name, phone: customer.phone, email: customer.email },
        'identity-login-required',
      );
      // The earlier draft belongs to a card that is gone; this one takes its place.
      await visitor.page.getByTestId('identity-login-cta').click();
      const conflict = visitor.page.getByTestId('identity-draft-exists');
      await expect(conflict).toBeVisible();
      await conflict.getByRole('button', { name: 'Evet, geç' }).click();
      await expect(visitor.page).toHaveURL(/\/login\?/);

      // The shelf moves: the original district goes dark and another lights
      // up, so the card is still on the air — for somewhere else.
      const elsewhere = uniqueLocation();
      const shelf = await prisma().showcasePlacementShelf.findFirstOrThrow({
        where: { placementId: moving.card!.placementId },
      });
      await prisma().showcasePlacementShelf.update({ where: { id: shelf.id }, data: { active: false } });
      await prisma().showcasePlacementShelf.create({
        data: {
          placementId: shelf.placementId,
          providerId: shelf.providerId,
          categoryId: shelf.categoryId,
          areaKey: showcaseAreaKey(elsewhere.city, elsewhere.district),
          scope: 'DISTRICT',
          city: elsewhere.city,
          district: elsewhere.district,
          neighborhood: null,
          active: true,
          endAt: shelf.endAt,
        },
      });

      await signInHere(visitor.page, formPath(moving), customer.email, customer.password);
      await expect(visitor.page.getByTestId('showcase-lead-form')).toBeVisible();
      await expectShowcaseBodyRestored(visitor.page, moving.location);
      await proveShowcasePhone(visitor.page, customer.phone);

      const requestsBefore = await prisma().serviceRequest.count();
      await visitor.page.getByTestId('showcase-lead-submit').click();
      await assertNoErrorScreen(visitor.page);

      const refusal = visitor.page.getByTestId('showcase-lead-area-not-served');
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText(
        'Bu vitrin hizmeti seçtiğiniz konumu kapsamıyor. Genel talep oluşturmaya devam edebilirsiniz.',
      );
      await expect(visitor.page.getByTestId('showcase-general-request-cta')).toHaveAttribute(
        'href',
        `/categories/${moving.category.slug}`,
      );
      await expect(visitor.page.getByTestId('showcase-lead-sent')).toHaveCount(0);
      expect(await prisma().serviceRequest.count()).toBe(requestsBefore);
      expect(await prisma().showcaseLead.count()).toBe(leadsBefore);
      // What was restored is still on the page to correct.
      await expect(visitor.page.getByLabel('Açıklama *')).toHaveValue(SHOWCASE_DESCRIPTION);
    } finally {
      await visitor.close();
    }
  });

  // ── 9 (marketplace) ─────────────────────────────────────────────────────
  // The vitrin form's race is covered by showcase-placement-lead.spec.ts.
  test('normal talep formu: gate açıldıktan sonra oluşan çakışma gönderimde kendi cümlesiyle reddedilir', async ({
    browser,
  }, testInfo) => {
    const stage = await seedStage('marketplace', 'E2E Gate Yarış');
    const phoneOwner = await createCustomer('E2E Gate Yarış Telefon');
    const emailOwner = await createCustomer('E2E Gate Yarış E-posta');
    const visitor = await openVisitor(browser, testInfo);
    const contact = freshContact('Yarışan Müşteri');

    try {
      await openForm(visitor, stage);
      const last = await typeContact(visitor.page, 'marketplace', contact);
      await settleIdentityGate(visitor.page, last);

      const form = visitor.page.locator('form.form-card');
      const next = visitor.page.getByRole('button', { name: 'Devam et' });
      await next.click();
      await expect(visitor.page.locator('#request-step-detail')).toBeVisible();
      await form.locator('textarea[name="description"]').fill(MARKETPLACE_DESCRIPTION);
      await next.click();
      await expect(visitor.page.locator('#request-step-place')).toBeVisible();
      await form.locator('select[name="city"]').selectOption(stage.location.city);
      await form.locator('select[name="district"]').selectOption(stage.location.district);

      // Between the check and the submission the number and the address each
      // become another customer's.
      await prisma().user.update({ where: { id: phoneOwner.id }, data: { phone: contact.phone } });
      await prisma().user.update({ where: { id: emailOwner.id }, data: { email: contact.email } });
      const before = await counts();

      await visitor.page.getByRole('button', { name: 'Talebi Gönder' }).click();
      const refusal = visitor.page.getByTestId('request-submit-error');
      await expect(refusal).toBeVisible();
      await expect(refusal).toHaveText(CONFLICT_SENTENCE);
      await expect(visitor.page).not.toHaveURL(/\/requests\/success/);
      await assertNoErrorScreen(visitor.page);

      expect(await counts()).toEqual(before);
      // Everything typed is still there to correct.
      await expect(form.locator('textarea[name="description"]')).toHaveValue(MARKETPLACE_DESCRIPTION);
      await expect(form.locator('select[name="district"]')).toHaveValue(stage.location.district);
    } finally {
      await visitor.close();
    }
  });

  // ── 13 ──────────────────────────────────────────────────────────────────
  test('bir formun taslağı dururken diğerinde giriş yapmak sorar; Vazgeç eskisini korur, Evet geç yenisini bırakır', async ({
    browser,
  }, testInfo) => {
    const marketplace = await seedStage('marketplace', 'E2E Gate İki Form');
    const showcase = await seedStage('showcase', 'E2E Gate İki Form Vitrin');
    const customer = await createCustomer('E2E Gate İki Taslak');
    const visitor = await openVisitor(browser, testInfo);
    const contact = { name: customer.name, phone: customer.phone, email: customer.email };

    try {
      // ── A marketplace draft, left at the sign-in page ─────────────────
      await openForm(visitor, marketplace);
      await typeContactExpecting(visitor.page, 'marketplace', contact, 'identity-login-required');
      await leaveThroughLoginCta(visitor.page, formPath(marketplace));
      const first = await prisma().requestDraft.findFirstOrThrow({
        where: { expectedUserId: customer.id, consumedAt: null },
      });
      expect(first.formType).toBe('MARKETPLACE');
      const firstCookie = await draftCookie(visitor);
      expect(firstCookie).not.toBeNull();

      // ── The vitrin form, same browser, no sign-in in between ──────────
      await openForm(visitor, showcase);
      await fillShowcaseBody(visitor.page, showcase.location);
      await typeContactExpecting(visitor.page, 'showcase', contact, 'identity-login-required');
      await visitor.page.getByTestId('identity-login-cta').click();

      const question = visitor.page.getByTestId('identity-draft-exists');
      await expect(question).toBeVisible();
      await expect(question).toContainText('Yeni taslağa geçerseniz önceki taslak silinir. Devam edilsin mi?');
      await expect(visitor.page).toHaveURL(new RegExp(`/vitrin/${showcase.card!.id}`));

      // "Vazgeç": nothing saved, nothing sent, the earlier draft and its token intact.
      await question.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(question).toHaveCount(0);
      await expect(visitor.page).toHaveURL(new RegExp(`/vitrin/${showcase.card!.id}`));
      expect(await prisma().requestDraft.count({ where: { expectedUserId: customer.id } })).toBe(1);
      const kept = await prisma().requestDraft.findUniqueOrThrow({ where: { id: first.id } });
      expect(kept.tokenHash).toBe(first.tokenHash);
      expect(kept.formType).toBe('MARKETPLACE');
      expect((await draftCookie(visitor))?.value).toBe(firstCookie?.value);
      // And what was typed here is still on the page.
      await expectShowcaseBodyRestored(visitor.page, showcase.location);

      // The kept draft really is the marketplace form's: signed in as its
      // owner, the marketplace page opens it and binds it to the account.
      await visitor.page.goto(visitor.webUrl(`/login?redirectTo=${encodeURIComponent(formPath(marketplace))}`), {
        waitUntil: 'domcontentloaded',
      });
      await signInHere(visitor.page, formPath(marketplace), customer.email, customer.password);
      await expect(visitor.page.getByTestId('account-contact-summary')).toBeVisible();
      await expect(visitor.page.getByTestId('identity-wrong-account')).toHaveCount(0);
      const opened = await prisma().requestDraft.findUniqueOrThrow({ where: { id: first.id } });
      expect(opened.userId).toBe(customer.id);
      expect(opened.tokenHash).toBe(first.tokenHash);
      await signOut(visitor.page);

      // ── Asked again, "Evet, geç": the vitrin draft takes the browser's one slot ──
      await openForm(visitor, showcase);
      await fillShowcaseBody(visitor.page, showcase.location);
      await typeContactExpecting(visitor.page, 'showcase', contact, 'identity-login-required');
      await visitor.page.getByTestId('identity-login-cta').click();
      await expect(question).toBeVisible();
      await question.getByRole('button', { name: 'Evet, geç' }).click();
      await expect(visitor.page).toHaveURL(/\/login\?/);

      const rows = await prisma().requestDraft.findMany({ where: { expectedUserId: customer.id } });
      expect(rows).toHaveLength(1);
      const replacement = rows[0]!;
      expect(replacement.formType).toBe('SHOWCASE_LEAD');
      expect(replacement.cardId).toBe(showcase.card!.id);
      expect(replacement.tokenHash).not.toBe(first.tokenHash);
      expect(await prisma().requestDraft.findUnique({ where: { id: first.id } })).toBeNull();
      const secondCookie = await draftCookie(visitor);
      expect(secondCookie?.value).not.toBe(firstCookie?.value);

      // The replacement is the live one: it comes back on the vitrin form, and
      // the marketplace form now opens with nothing.
      await signInHere(visitor.page, formPath(showcase), customer.email, customer.password);
      await expect(visitor.page.getByTestId('showcase-lead-form')).toBeVisible();
      await expectShowcaseBodyRestored(visitor.page, showcase.location);
      await openForm(visitor, marketplace);
      await expect(visitor.page.getByTestId('account-contact-summary')).toBeVisible();
      await expect(visitor.page.getByTestId('identity-wrong-account')).toHaveCount(0);
      const stillOne = await prisma().requestDraft.findMany({ where: { expectedUserId: customer.id } });
      expect(stillOne.map((row) => row.id)).toEqual([replacement.id]);
    } finally {
      await visitor.close();
    }
  });
});

/**
 * The draft budget, spent on purpose: five saves from one client address in
 * ten minutes, and the sixth is refused with a sentence and a way to retry.
 *
 * Its own describe at the end of the file, because it consumes a whole
 * bucket: every other scenario has its own address (see openVisitor), and
 * this one gets one nobody else touches. Each round leaves the form through
 * "Giriş yap" — the save that click makes is the request being counted — and
 * comes back without signing in; the same browser, the same key, so the five
 * saves that succeed update one row rather than five.
 */
test.describe('taslak bütçesi', () => {
  test('vitrin formu: aynı tarayıcıdan altıncı taslak kaydı anlaşılır bir hatayla reddedilir; form içeriği durur', async ({
    browser,
  }, testInfo) => {
    const stage = await seedStage('showcase', 'E2E Gate Bütçe');
    const customer = await createCustomer('E2E Gate Bütçe');
    const visitor = await openVisitor(browser, testInfo);
    const contact = { name: customer.name, phone: customer.phone, email: customer.email };
    const back = formPath(stage);

    try {
      for (let round = 1; round <= 5; round += 1) {
        await openForm(visitor, stage);
        await fillShowcaseBody(visitor.page, stage.location);
        await typeContactExpecting(visitor.page, 'showcase', contact, 'identity-login-required');
        await leaveThroughLoginCta(visitor.page, back);
        // One row, updated in place, however many times the browser parks it.
        expect(await prisma().requestDraft.count({ where: { expectedUserId: customer.id } })).toBe(1);
      }

      await openForm(visitor, stage);
      await fillShowcaseBody(visitor.page, stage.location);
      await typeContactExpecting(visitor.page, 'showcase', contact, 'identity-login-required');
      await visitor.page.getByTestId('identity-login-cta').click();

      const refusal = visitor.page.getByTestId('identity-draft-error');
      await expect(refusal).toBeVisible();
      await expect(refusal).toContainText('Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.');
      await expect(refusal.getByRole('button', { name: 'Tekrar dene' })).toBeVisible();
      // Nobody went anywhere, and nothing typed was lost.
      await expect(visitor.page).toHaveURL(new RegExp(`/vitrin/${stage.card!.id}`));
      await expectShowcaseBodyRestored(visitor.page, stage.location);
      await expect(visitor.page.getByLabel('Telefon *')).toHaveValue(customer.phone);
      await expect(visitor.page.getByLabel('E-posta *')).toHaveValue(customer.email);
      // The refused save left the row as the fifth one had it.
      expect(await prisma().requestDraft.count({ where: { expectedUserId: customer.id } })).toBe(1);
    } finally {
      await visitor.close();
    }
  });
});
