import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { expectNoHorizontalOverflow } from '../src/campaign-fixtures';
import {
  countRefundTransactions,
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  createStaffAdmin,
  openReportCount,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
} from '../src/fixtures';
import { seedOffer, seedRequestReport } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { artifactsDir, contactSharingRuntime, primaryRuntime, type Runtime } from '../src/runtime';
import { confirmThrough, waitForHydration } from '../src/confirm-dialog';

/**
 * ADMIN-DESIGN-001 Faz 3A: talepler, teklifler and the refund scan, as an
 * operator drives them.
 *
 * What the redesign changed, and what these cases pin:
 * - The request and offer details are a summary card over URL tabs. A tab is a
 *   link: it can be opened directly, it follows the browser's Back and
 *   Forward, and the keyboard reaches it like any link.
 * - Every destructive operation asks first, in a dialog that says what will
 *   happen, and nothing is written until it is confirmed — proven here against
 *   the database, not the markup. The bulk refund in particular never calls
 *   its endpoint before the confirmation.
 * - Sections and actions follow `/admin/me/permissions`: a tab or block whose
 *   read permission is missing is absent (a hand-typed `?tab=` falls back to
 *   the first tab), and every write control asks for its own permission.
 * - None of the six screens gets wider than a 320px phone, on any tab.
 *
 * The API's side of each operation is proven in its own specs
 * (request-report-flow, offer-withdrawal, contact-sharing); this one proves
 * the screens in front of them.
 */

const SHOTS = resolve(artifactsDir, 'admin-design');
function shot(testInfo: TestInfo, name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  return resolve(SHOTS, `${testInfo.project.name}-${name}.png`);
}

const DESKTOP = { width: 1440, height: 900 };
const STARTING_CREDITS = 20;

/** A request with one offer from one provider and one open report from another. */
async function seedScene(options: { customerOwned?: boolean } = {}) {
  const location = uniqueLocation();
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Faz3A Müşteri');
  const provider = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });
  const reporter = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });

  const request =
    options.customerOwned === false
      ? await seedGuestRequest(category.id, location)
      : await seedCustomerRequest({ customerId: customer.id, categoryId: category.id, location, content: 'full' });
  const offer = await seedOffer({ requestId: request.id, providerId: provider.id });
  await seedRequestReport({ requestId: request.id, reporterProviderId: reporter.id });

  return { category, customer, provider, reporter, request, offer, location };
}

/** A request no customer account owns — the only kind a staff account may decide offers on. */
async function seedGuestRequest(categoryId: string, location: { city: string; district: string }) {
  const suffix = uniqueSuffix();
  return prisma().serviceRequest.create({
    data: {
      categoryId,
      customerId: null,
      requestNumber: `TR-E2E-${suffix}`,
      customerName: `E2E Misafir ${suffix}`,
      customerPhone: uniquePhone(),
      customerEmail: `e2e-guest-${suffix}@example.test`,
      city: location.city,
      district: location.district,
      status: 'APPROVED',
      approvedAt: new Date(),
      qualityScore: 60,
    },
    select: { id: true, requestNumber: true },
  });
}

/** A matched request with a contact-sharing audit row behind it. */
async function seedMatchedRequest() {
  const location = uniqueLocation();
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Faz3A Eşleşme');
  const provider = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });
  const request = await seedCustomerRequest({ customerId: customer.id, categoryId: category.id, location, content: 'full' });
  const offer = await seedOffer({ requestId: request.id, providerId: provider.id, status: 'ACCEPTED' });
  await prisma().serviceRequest.update({
    where: { id: request.id },
    data: { status: 'MATCHED', matchedOfferId: offer.id, matchedAt: new Date() },
  });
  await prisma().contactRevealEvent.create({
    data: {
      requestId: request.id,
      offerId: offer.id,
      customerUserId: customer.id,
      providerId: provider.id,
      disclosureVersion: 'e2e-faz3a-v1',
    },
  });
  return { request, offer };
}

async function openAs(
  browser: Parameters<typeof Actor.open>[0],
  permissions: string[] | 'super',
  viewport = DESKTOP,
  runtime: Runtime = primaryRuntime,
) {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', runtime, { viewport });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

const requestTabs = (page: Page) => page.getByRole('navigation', { name: 'Talep sekmeleri' });
const offerTabs = (page: Page) => page.getByRole('navigation', { name: 'Teklif sekmeleri' });

test.describe('requests and offers (ADMIN-DESIGN-001 Faz 3A)', () => {
  test('the request detail is four URL tabs: deep links, Back/Forward and the keyboard', async ({
    browser,
  }, testInfo) => {
    const { request, provider, reporter } = await seedScene();
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    const path = `/requests/${request.id}`;

    try {
      await admin.gotoAdmin(path);
      await assertNoErrorScreen(page);
      const tabs = requestTabs(page);
      await expect(tabs.getByRole('link')).toHaveCount(4);
      await expect(tabs.getByRole('link', { name: 'Talep bilgileri' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('request-panel-bilgiler')).toBeVisible();
      await expect(page.getByTestId('request-open-reports')).toHaveText('1 şikayet karar bekliyor');
      // The summary strip counts what the page read.
      await expect(page.getByTestId('request-fact-offers')).toContainText('1');
      await expect(page.getByTestId('request-fact-reports')).toContainText('1 adet');
      await page.screenshot({ path: shot(testInfo, 'request-detail-bilgiler-1440'), fullPage: false });

      // ---- clicking a tab writes it into the URL -------------------------
      await tabs.getByRole('link', { name: /^Teklifler/ }).click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=teklifler$`));
      await expect(tabs.getByRole('link', { name: /^Teklifler/ })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('request-offer-row')).toHaveCount(1);
      await expect(page.getByTestId('request-offer-row')).toContainText(provider.businessName);
      await expect(page.getByTestId('request-offers-panel').getByRole('columnheader', { name: 'Ne zaman gelebilir' })).toHaveCount(1);
      await page.screenshot({ path: shot(testInfo, 'request-detail-teklifler-1440'), fullPage: false });

      await tabs.getByRole('link', { name: /^Şikayet/ }).click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sikayet$`));
      await expect(page.locator('#bildirimler')).toBeVisible();
      await expect(page.getByTestId('report-item')).toContainText(reporter.businessName);
      await expect(page.getByTestId('report-decisions')).toBeVisible();
      await page.screenshot({ path: shot(testInfo, 'request-detail-sikayet-1440'), fullPage: false });

      await tabs.getByRole('link', { name: 'Neler oldu' }).click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=gecmis$`));
      const history = page.getByTestId('request-history');
      await expect(history).toContainText('Müşteri talebi gönderdi');
      await expect(history).toContainText('Teklif geldi');
      await expect(history).toContainText('Şikayet bildirildi');
      await page.screenshot({ path: shot(testInfo, 'request-detail-gecmis-1440'), fullPage: false });

      // ---- the browser's Back and Forward move between tabs ---------------
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sikayet$`));
      await expect(page.locator('#bildirimler')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=teklifler$`));
      await expect(page.getByTestId('request-offers-panel')).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=sikayet$`));
      await expect(tabs.getByRole('link', { name: /^Şikayet/ })).toHaveAttribute('aria-current', 'page');

      // ---- a link straight to a tab, and one to a tab that does not exist --
      await admin.gotoAdmin(`${path}?tab=gecmis`);
      await expect(tabs.getByRole('link', { name: 'Neler oldu' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('request-history')).toBeVisible();
      await admin.gotoAdmin(`${path}?tab=yok-boyle-bir-sekme`);
      await expect(tabs.getByRole('link', { name: 'Talep bilgileri' })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('request-panel-bilgiler')).toBeVisible();

      // ---- the keyboard: tabs are links in the tab order ------------------
      // WebKit, like Safari, leaves links out of the Tab order by default, so
      // there the link is focused directly; Enter follows it in both.
      if (testInfo.project.name === 'webkit') {
        await tabs.getByRole('link', { name: /^Teklifler/ }).focus();
      } else {
        await tabs.getByRole('link', { name: 'Talep bilgileri' }).focus();
        await page.keyboard.press('Tab');
      }
      await expect(tabs.getByRole('link', { name: /^Teklifler/ })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=teklifler$`));
      await expect(page.getByTestId('request-offers-panel')).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('rejecting and cancelling a request ask first and write nothing until confirmed', async ({
    browser,
  }, testInfo) => {
    const { request, provider } = await seedScene();
    const second = await seedScene();
    const admin = await openAs(browser, 'super');
    const page = admin.page;

    try {
      // ---- "Talebi reddet" ---------------------------------------------
      await admin.gotoAdmin(`/requests/${request.id}`);
      await page.locator('details.status-reject-block > summary').click();
      const reject = page.getByTestId('status-reject');
      const rejectDialog = page.getByRole('dialog', { name: 'Talep reddedilsin mi?' });

      // A required reason left empty is the browser's to report; no dialog.
      await reject.click();
      await expect(rejectDialog).toBeHidden();

      await page.getByLabel('Ret gerekçesi (zorunlu)').fill('Test amaçlı açılmış bir talep.');
      await reject.click();
      await expect(rejectDialog).toBeVisible();
      await expect(rejectDialog).toContainText('açık teklifler');
      await expect(rejectDialog).toContainText('iade edilir');
      await expect(rejectDialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
      if (testInfo.project.name !== 'webkit') {
        // Focus stays inside the modal: Tab goes on to the confirmation.
        await page.keyboard.press('Tab');
        await expect(rejectDialog.getByRole('button', { name: 'Evet, reddet' })).toBeFocused();
      }
      await page.screenshot({ path: shot(testInfo, 'request-reject-dialog-1440'), fullPage: false });
      await page.keyboard.press('Escape');
      await expect(rejectDialog).toBeHidden();
      await expect(reject).toBeFocused();

      await reject.click();
      await rejectDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(rejectDialog).toBeHidden();
      await page.waitForTimeout(300);
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('APPROVED');
      expect(await countRefundTransactions(provider.id)).toBe(0);

      // Confirmed: exactly what the dialog said.
      await reject.click();
      await rejectDialog.getByRole('button', { name: 'Evet, reddet' }).click();
      await expect(page.getByTestId('request-status')).toHaveText('Reddedildi');
      await assertNoErrorScreen(page);
      const offer = await prisma().offer.findFirstOrThrow({ where: { requestId: request.id } });
      expect(offer.status).toBe('CANCELLED');
      expect(await countRefundTransactions(provider.id)).toBe(1);

      // ---- "İptal et" -----------------------------------------------------
      await admin.gotoAdmin(`/requests/${second.request.id}`);
      const cancel = page.getByTestId('request-cancel');
      const cancelDialog = page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' });
      await cancel.click();
      // What /cancel does to an open request (PR #118 contract): its live
      // offers close and get their credit back; there is no winner to decide on.
      await expect(cancelDialog).toContainText('1 açık teklif (gönderildi, görüntülendi, kısa listede) kapatılır ve harcanan kredileri iade edilir');
      await expect(cancelDialog).toContainText('Müşteriye iptal teyidi');
      await expect(page.getByTestId('request-cancel-refund-winner')).toHaveCount(0);
      await cancelDialog.getByRole('button', { name: 'Kapat' }).click();
      await expect(cancelDialog).toBeHidden();
      await page.waitForTimeout(300);
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: second.request.id } })).status).toBe(
        'APPROVED',
      );
      await cancel.click();
      await cancelDialog.getByRole('button', { name: 'Evet, iptal et' }).click();
      await expect(page.getByTestId('request-status')).toHaveText('İptal Edildi');
      expect((await prisma().offer.findFirstOrThrow({ where: { requestId: second.request.id } })).status).toBe('CANCELLED');
      expect(await countRefundTransactions(second.provider.id)).toBe(1);

      // ---- "Talebi kaldır" on the Şikayet tab ----------------------------
      const third = await seedScene();
      await admin.gotoAdmin(`/requests/${third.request.id}?tab=sikayet`);
      await page
        .getByRole('group', { name: 'Talebi kaldır' })
        .locator('select[name="removalReason"]')
        .selectOption('FAKE_OR_TEST');
      await page.getByTestId('report-remove').click();
      const removeDialog = page.getByRole('dialog', { name: 'Talep kaldırılsın mı?' });
      await expect(removeDialog).toContainText('Müşteriye, seçtiğiniz gerekçeyle');
      await page.keyboard.press('Escape');
      await expect(removeDialog).toBeHidden();
      await page.waitForTimeout(300);
      expect(await openReportCount(third.request.id)).toBe(1);
    } finally {
      await admin.close();
    }
  });

  test('the offer detail: tabs, the operations it can really perform, and a confirmed manual refund', async ({
    browser,
  }, testInfo) => {
    const { offer, provider, request } = await seedScene();
    const admin = await openAs(browser, 'super');
    const page = admin.page;
    const path = `/offers/${offer.id}`;

    try {
      await admin.gotoAdmin(path);
      await assertNoErrorScreen(page);
      const tabs = offerTabs(page);
      await expect(tabs.getByRole('link')).toHaveText(['Teklif ve işlemler', 'İlgili talep', 'Kredi ve iade', 'Neler oldu']);
      const actions = page.getByTestId('offer-actions');
      await expect(actions.getByTestId('offer-action-refund')).toBeVisible();
      await expect(actions.getByTestId('offer-action-accept')).toBeVisible();
      await expect(actions.getByTestId('offer-action-shortlist')).toBeVisible();
      await expect(actions.getByTestId('offer-action-reject')).toBeVisible();
      // The design's other four operations have no API: not drawn at all.
      for (const name of ['Teklifi müşteriden kaldır', 'Müşteriye hatırlatma gönder', 'Hizmet vereni uyar', 'Eşleşmeyi iptal et']) {
        await expect(page.getByRole('button', { name, includeHidden: true }), name).toHaveCount(0);
      }
      await page.screenshot({ path: shot(testInfo, 'offer-detail-islemler-1440'), fullPage: false });

      // Accepting on the customer's behalf is final: it asks, and Esc leaves it.
      await page.getByTestId('offer-accept').click();
      const acceptDialog = page.getByRole('dialog', { name: 'Teklif müşteri adına kabul edilsin mi?' });
      await expect(acceptDialog).toContainText('diğer açık teklifler');
      // Never refunded: the dialog says nothing about credit
      // (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
      await expect(acceptDialog.getByTestId('offer-accept-recharge')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(acceptDialog).toBeHidden();
      await page.waitForTimeout(300);
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('SUBMITTED');
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('APPROVED');

      // ---- the refund row takes the operator to the refund form -----------
      await page.getByRole('link', { name: 'İade formuna git' }).click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=kredi$`));
      await expect(tabs.getByRole('link', { name: 'Kredi ve iade' })).toHaveAttribute('aria-current', 'page');
      await page.getByLabel('Yönetici notu').fill('E2E: müşteriye ulaşılamadı');
      const refund = page.getByTestId('offer-refund');
      const refundDialog = page.getByRole('dialog', { name: 'Kredi iade edilsin mi?' });
      // No reason is preselected (Paket A): without one the dialog does not open.
      const reason = page.getByTestId('offer-refund-reason');
      await expect(reason).toHaveValue('');
      await refund.click();
      await expect(page.getByTestId('offer-refund-dialog')).toBeHidden();
      expect(await reason.evaluate((element) => (element as HTMLSelectElement).validity.valueMissing)).toBe(true);
      await reason.selectOption('CUSTOMER_UNREACHABLE');
      await refund.click();
      await expect(refundDialog).toContainText(`3 kredi ${provider.businessName} bakiyesine geri yüklenir`);
      await expect(refundDialog).toContainText('kredi iadesi e-postası gider');
      await page.screenshot({ path: shot(testInfo, 'offer-refund-dialog-1440'), fullPage: false });
      await refundDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await page.waitForTimeout(300);
      expect(await countRefundTransactions(provider.id)).toBe(0);
      // The edit survived the cancel: nothing was submitted or reset.
      await expect(page.getByLabel('Yönetici notu')).toHaveValue('E2E: müşteriye ulaşılamadı');

      await refund.click();
      await refundDialog.getByRole('button', { name: 'Evet, iade et' }).click();
      await expect(page.getByText('Manuel iade tamamlandı. Kredi hizmet verenin bakiyesine eklendi.')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=kredi&refunded=1$`));
      expect(await countRefundTransactions(provider.id)).toBe(1);
      // Once refunded, the operation is gone from the list.
      await tabs.getByRole('link', { name: 'Teklif ve işlemler' }).click();
      await expect(page.getByTestId('offer-action-refund')).toHaveCount(0);

      // Refunded now, so accepting would charge the 3 credits again, and the
      // dialog says so with the amount (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
      // Esc leaves it; nothing is charged.
      await waitForHydration(page.getByTestId('offer-accept'));
      await page.getByTestId('offer-accept').click();
      const recharge = acceptDialog.getByTestId('offer-accept-recharge');
      await expect(recharge).toContainText('Kredi yeniden tahsil edilir');
      await expect(recharge).toContainText(`${provider.businessName} bakiyesinden 3 kredi yeniden düşülür`);
      await page.screenshot({ path: shot(testInfo, 'offer-accept-recharge-dialog-1440'), fullPage: false });
      await page.keyboard.press('Escape');
      await expect(acceptDialog).toBeHidden();
      await page.waitForTimeout(300);
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: offer.id } })).creditRechargeTransactionId).toBeNull();

      // ---- the related request, with every offer it received -------------
      await tabs.getByRole('link', { name: 'İlgili talep' }).click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=talep$`));
      await expect(page.getByTestId('offer-siblings')).toContainText('Bu talebe başka teklif gelmedi.');
      await page.screenshot({ path: shot(testInfo, 'offer-detail-talep-1440'), fullPage: false });

      // ---- Back / Forward and the history tab -----------------------------
      await tabs.getByRole('link', { name: 'Neler oldu' }).click();
      await expect(page.getByTestId('offer-history')).toContainText('Kredi iadesi yapıldı');
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=talep$`));
      await expect(page.getByTestId('offer-siblings')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByTestId('offer-panel-islemler')).toBeVisible();
      await page.goForward();
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${path}\\?tab=gecmis$`));
      await expect(page.getByTestId('offer-history')).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('the bulk refund never calls its endpoint before it is confirmed', async ({ browser }, testInfo) => {
    const location = uniqueLocation();
    const category = await createCategory(3);
    const customer = await createCustomer('E2E Faz3A İade');
    const provider = await createProvider({ categoryId: category.id, location, credits: STARTING_CREDITS });
    const request = await seedCustomerRequest({ customerId: customer.id, categoryId: category.id, location, content: 'empty' });
    const offer = await seedOffer({ requestId: request.id, providerId: provider.id, refund: 'eligible' });
    const admin = await openAs(browser, 'super');
    const page = admin.page;

    // Both calls are server actions of this screen: a POST from the page
    // carrying a `next-action` header. None may leave before the confirmation.
    let actionCalls = 0;
    page.on('request', (sent) => {
      if (sent.method() === 'POST' && sent.headers()['next-action']) actionCalls += 1;
    });
    const refunded = async () =>
      Boolean((await prisma().offer.findUniqueOrThrow({ where: { id: offer.id } })).creditRefundedAt);

    try {
      await admin.gotoAdmin('/refund-scan?limit=500');
      await assertNoErrorScreen(page);
      await expect(page.getByTestId('refund-scan-row').filter({ hasText: offer.id })).toHaveCount(1);
      await page.screenshot({ path: shot(testInfo, 'refund-scan-1440'), fullPage: false });

      // A changed limit closes the run until the preview matches it again.
      const execute = page.getByTestId('refund-scan-execute');
      await expect(execute).toBeEnabled();
      await page.getByLabel('Limit').fill('400');
      await expect(execute).toBeDisabled();
      await expect(page.getByTestId('refund-scan-stale')).toBeVisible();
      await page.getByRole('button', { name: 'Yeniden tara' }).click();
      await expect(page.getByTestId('refund-scan-stale')).toHaveCount(0);
      await expect(execute).toBeEnabled();
      actionCalls = 0;

      // Esc, "Vazgeç", ×: the endpoint is never called.
      const dialog = page.getByRole('dialog', { name: /teklifin kredisi iade edilsin mi\?$/ });
      await execute.click();
      await expect(dialog).toContainText('en fazla 400 aday yeniden sorgulanır');
      await expect(dialog).toContainText('kredi iadesi e-postası gider');
      await page.screenshot({ path: shot(testInfo, 'refund-scan-dialog-1440'), fullPage: false });
      await page.keyboard.press('Escape');
      await execute.click();
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await execute.click();
      await dialog.getByRole('button', { name: 'Kapat' }).click();
      await page.waitForTimeout(500);
      expect(actionCalls).toBe(0);
      expect(await refunded()).toBe(false);

      // Confirmed: one call, and the offer's credit is back.
      await execute.click();
      await dialog.getByRole('button', { name: 'Evet, iadeyi çalıştır' }).click();
      const result = page.getByTestId('refund-scan-result');
      await expect(result).toBeVisible();
      await expect(result.getByRole('row').filter({ hasText: offer.id })).toContainText('İade edildi');
      // The confirmation proof (ADMIN-DESTRUCTIVE-CONFIRMATION-001), the run,
      // then the fresh preview.
      expect(actionCalls).toBe(3);
      expect(await refunded()).toBe(true);
      // The preview is read again after the run: the offer is not offered twice.
      await expect(page.getByTestId('refund-scan-row').filter({ hasText: offer.id })).toHaveCount(0);
      await page.screenshot({ path: shot(testInfo, 'refund-scan-result-1440'), fullPage: false });
    } finally {
      await admin.close();
    }
  });
});

test.describe('Faz 3A permissions: sections and actions follow /admin/me/permissions', () => {
  test('a reader sees the sections it holds and no write control', async ({ browser }) => {
    const { request } = await seedScene();
    const matched = await seedMatchedRequest();
    const reader = await openAs(browser, ['REQUESTS_READ', 'OFFERS_READ', 'REQUEST_REPORTS_READ', 'CONTACT_REVEAL_READ']);
    const noAudit = await openAs(browser, ['REQUESTS_READ', 'OFFERS_READ']);

    try {
      const page = reader.page;
      await reader.gotoAdmin(`/requests/${request.id}`);
      await expect(requestTabs(page).getByRole('link')).toHaveCount(4);
      for (const name of ['Onayla', 'İncelemeye al', 'Talebi reddet', 'Kaliteyi yeniden hesapla', 'İptal et', 'Hizmeti tamamlandı işaretle']) {
        await expect(page.getByRole('button', { name, includeHidden: true }), name).toHaveCount(0);
      }
      await reader.gotoAdmin(`/requests/${request.id}?tab=teklifler`);
      await expect(page.getByTestId('request-offer-row')).toHaveCount(1);
      await reader.gotoAdmin(`/requests/${request.id}?tab=sikayet`);
      await expect(page.getByTestId('report-list')).toBeVisible();
      // Reading reports is not deciding them.
      await expect(page.getByTestId('report-decisions')).toHaveCount(0);
      await expect(page.getByTestId('report-reopen')).toHaveCount(0);

      // The contact-sharing audit: its own permission, nothing else.
      await reader.gotoAdmin(`/requests/${matched.request.id}`);
      await expect(page.getByTestId('contact-reveal-audit')).toContainText('e2e-faz3a-v1');
      await noAudit.gotoAdmin(`/requests/${matched.request.id}`);
      await expect(noAudit.page.getByTestId('request-panel-bilgiler')).toBeVisible();
      await expect(noAudit.page.getByTestId('contact-reveal-audit')).toHaveCount(0);
      await expect(requestTabs(noAudit.page).getByRole('link')).toHaveText([/^Talep bilgileri/, /^Teklifler/, 'Neler oldu']);
    } finally {
      await reader.close();
      await noAudit.close();
    }
  });

  test('deciding reports needs REQUEST_REPORTS_RESOLVE, and the queue links only where it may', async ({ browser }) => {
    const { request } = await seedScene();
    const decider = await openAs(browser, ['REQUESTS_READ', 'REQUEST_REPORTS_READ', 'REQUEST_REPORTS_RESOLVE']);
    const queueOnly = await openAs(browser, ['REQUEST_REPORTS_READ']);

    try {
      await decider.gotoAdmin(`/requests/${request.id}?tab=sikayet`);
      await expect(decider.page.getByTestId('report-decisions')).toBeVisible();
      await expect(decider.page.getByTestId('report-dismiss')).toBeVisible();
      await expect(decider.page.getByTestId('report-remove')).toBeVisible();
      // No OFFERS_READ: no offers tab; no REQUESTS_STATUS: no moderation.
      await expect(requestTabs(decider.page).getByRole('link', { name: /^Teklifler/ })).toHaveCount(0);
      await decider.gotoAdmin(`/requests/${request.id}`);
      await expect(decider.page.getByRole('button', { name: 'Onayla' })).toHaveCount(0);

      await queueOnly.gotoAdmin('/requests/reports');
      const row = queueOnly.page.locator(`[data-testid="report-queue-row"][data-request-id="${request.id}"]`);
      await expect(row).toHaveCount(1);
      // No REQUESTS_READ: the request number is text, not a link to a page it cannot open.
      await expect(row.getByRole('link', { name: /^Talebi aç/ })).toHaveCount(0);
      await expect(row.getByRole('link', { name: /^Aç:/ })).toHaveCount(0);

      // With it, the row's "Aç" goes straight to the decision.
      await decider.gotoAdmin('/requests/reports');
      await decider.page
        .locator(`[data-testid="report-queue-row"][data-request-id="${request.id}"]`)
        .getByRole('link', { name: /^Aç:/ })
        .click();
      await expect(decider.page).toHaveURL(new RegExp(`/requests/${request.id}\\?tab=sikayet$`));
      await expect(decider.page.getByTestId('report-decisions')).toBeVisible();
    } finally {
      await decider.close();
      await queueOnly.close();
    }
  });

  test('offer operations: each needs its permission, and the API’s own ownership rule', async ({ browser }) => {
    const owned = await seedScene();
    const guest = await seedScene({ customerOwned: false });
    const reader = await openAs(browser, ['OFFERS_READ']);
    const operator = await openAs(browser, ['OFFERS_READ', 'OFFERS_STATUS', 'OFFER_REFUND_MANUAL']);

    try {
      await reader.gotoAdmin(`/offers/${owned.offer.id}`);
      await expect(reader.page.getByTestId('offer-actions')).toHaveCount(0);
      await expect(reader.page.getByText('Bu teklif için bu hesapla yapılabilecek bir işlem yok.')).toBeVisible();
      await reader.gotoAdmin(`/offers/${owned.offer.id}?tab=kredi`);
      await expect(reader.page.getByTestId('offer-refund-form')).toHaveCount(0);
      // No REQUESTS_READ, no PROVIDERS_READ_DETAIL: no links to those screens.
      await expect(reader.page.getByRole('link', { name: 'Talebi aç' })).toHaveCount(0);
      await expect(reader.page.getByRole('link', { name: 'Hizmet vereni aç' })).toHaveCount(0);

      // A customer-owned request: the API lets only the customer or a super
      // admin decide, so a staff account is told so instead of being offered
      // buttons that would land on /yetkisiz. The refund is permission-only.
      await operator.gotoAdmin(`/offers/${owned.offer.id}`);
      await expect(operator.page.getByTestId('offer-actions-note')).toContainText('müşteri hesabına bağlı');
      await expect(operator.page.getByTestId('offer-accept')).toHaveCount(0);
      await expect(operator.page.getByTestId('offer-reject')).toHaveCount(0);
      await expect(operator.page.getByTestId('offer-action-refund')).toBeVisible();
      await operator.gotoAdmin(`/offers/${owned.offer.id}?tab=kredi`);
      await expect(operator.page.getByTestId('offer-refund')).toBeVisible();

      // A guest request: the same account may decide.
      await operator.gotoAdmin(`/offers/${guest.offer.id}`);
      await expect(operator.page.getByTestId('offer-accept')).toBeVisible();
      await expect(operator.page.getByTestId('offer-reject')).toBeVisible();
      await expect(operator.page.getByTestId('offer-shortlist')).toBeVisible();
    } finally {
      await reader.close();
      await operator.close();
    }
  });

  test('the refund run needs OFFER_REFUND_EXECUTE; the preview does not', async ({ browser }) => {
    const previewer = await openAs(browser, ['OFFER_REFUND_SCAN_READ']);
    const executor = await openAs(browser, ['OFFER_REFUND_SCAN_READ', 'OFFER_REFUND_EXECUTE']);

    try {
      await previewer.gotoAdmin('/refund-scan');
      await assertNoErrorScreen(previewer.page);
      await expect(previewer.page.getByText('çalıştırma yetkisi yok')).toBeVisible();
      await expect(previewer.page.getByTestId('refund-scan-execute-form')).toHaveCount(0);
      await expect(previewer.page.getByRole('button', { name: 'Yeniden tara' })).toBeVisible();

      await executor.gotoAdmin('/refund-scan');
      await expect(executor.page.getByTestId('refund-scan-execute')).toBeVisible();
    } finally {
      await previewer.close();
      await executor.close();
    }
  });

  test('the lists link only to the screens a session may open', async ({ browser }) => {
    const { request, offer } = await seedScene();
    const requestsOnly = await openAs(browser, ['REQUESTS_READ']);
    const offersOnly = await openAs(browser, ['OFFERS_READ']);

    try {
      const { customerName } = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
      await requestsOnly.gotoAdmin(`/requests?q=${encodeURIComponent(customerName)}`);
      const row = requestsOnly.page.locator(`[data-testid="request-row"][data-request-id="${request.id}"]`);
      await expect(row.getByRole('link', { name: /^Aç:/ })).toBeVisible();
      await expect(row.getByRole('link', { name: /^Teklifler:/ })).toHaveCount(0);

      await offersOnly.gotoAdmin(`/offers?requestId=${request.id}`);
      const offerRow = offersOnly.page.locator(`[data-testid="offer-row"][data-offer-id="${offer.id}"]`);
      await expect(offerRow.getByRole('link', { name: /^Aç:/ })).toBeVisible();
      await expect(offerRow.getByRole('link', { name: /^Talep:/ })).toHaveCount(0);
      await expect(offerRow.getByRole('link', { name: /^Hizmet veren:/ })).toHaveCount(0);
    } finally {
      await requestsOnly.close();
      await offersOnly.close();
    }
  });
});

test.describe('Faz 3A lists and layout', () => {
  test('saved views, filters and pins live in the URL', async ({ browser }, testInfo) => {
    const { request, offer } = await seedScene();
    const admin = await openAs(browser, 'super');
    const page = admin.page;

    try {
      // ---- /requests ------------------------------------------------------
      await admin.gotoAdmin('/requests');
      const views = page.getByRole('navigation', { name: 'Talep görünümleri' });
      await expect(views.getByRole('link', { name: /^Tümü/ })).toHaveAttribute('aria-current', 'page');
      await page.screenshot({ path: shot(testInfo, 'requests-1440'), fullPage: false });
      await views.getByRole('link', { name: /^Onaylandı/ }).click();
      await expect(page).toHaveURL(/\/requests\?status=APPROVED$/);
      await expect(views.getByRole('link', { name: /^Onaylandı/ })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#request-status')).toHaveValue('APPROVED');

      const requestNumber = request.requestNumber ?? '';
      const seeded = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
      const filters = page.getByRole('search', { name: 'Talep filtreleri' });
      await filters.getByLabel('Ara').fill(seeded.customerName);
      await filters.getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/[?&]q=/);
      await expect(page).toHaveURL(/[?&]status=APPROVED(&|$)/);
      await expect(page.getByTestId('request-row')).toHaveCount(1);
      await expect(page.getByTestId('request-row')).toContainText(requestNumber);
      await filters.getByRole('link', { name: 'Temizle' }).click();
      await expect(page).toHaveURL(/\/requests$/);
      await expect(filters.getByLabel('Ara')).toHaveValue('');

      // ---- /offers: a pin survives the filter bar's "Temizle" -------------
      await admin.gotoAdmin(`/offers?requestId=${request.id}&status=SUBMITTED`);
      await expect(page.getByTestId('offer-pins')).toBeVisible();
      await expect(page.getByTestId('offer-row')).toHaveCount(1);
      await page.screenshot({ path: shot(testInfo, 'offers-pinned-1440'), fullPage: false });
      await page.getByRole('search', { name: 'Teklif filtreleri' }).getByRole('link', { name: 'Temizle' }).click();
      await expect(page).toHaveURL(new RegExp(`/offers\\?requestId=${request.id}$`));
      await expect(page.locator(`[data-testid="offer-row"][data-offer-id="${offer.id}"]`)).toHaveCount(1);
      await page.getByRole('link', { name: 'Talep sabitlemesini kaldır' }).click();
      await expect(page).toHaveURL(/\/offers$/);

      // ---- /requests/reports ----------------------------------------------
      await admin.gotoAdmin('/requests/reports');
      const reportViews = page.getByRole('navigation', { name: 'Bildirim durumu' });
      await expect(reportViews.getByRole('link', { name: /^Açık/ })).toHaveAttribute('aria-current', 'page');
      // At 1440px the whole queue — "Aç" included — fits its box, as in the design.
      expect(
        await page.evaluate(() => {
          const scroller = document.querySelector('.data-list-scroll');
          return scroller ? scroller.scrollWidth - scroller.clientWidth : -1;
        }),
      ).toBe(0);
      await page.screenshot({ path: shot(testInfo, 'request-reports-1440'), fullPage: false });
      await reportViews.getByRole('link', { name: /^Çözülen/ }).click();
      await expect(page).toHaveURL(/\/requests\/reports\?state=resolved$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/requests\/reports$/);
      await expect(page.locator(`[data-testid="report-queue-row"][data-request-id="${request.id}"]`)).toHaveCount(1);
    } finally {
      await admin.close();
    }
  });

  test('no screen or tab is wider than a 320px, 390px or 1440px window', async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const { request, offer } = await seedScene();
    const account = await createAdmin();
    const paths = [
      '/requests',
      '/requests/reports',
      '/offers',
      '/refund-scan',
      ...['', '?tab=teklifler', '?tab=sikayet', '?tab=gecmis'].map((tab) => `/requests/${request.id}${tab}`),
      ...['', '?tab=talep', '?tab=kredi', '?tab=gecmis'].map((tab) => `/offers/${offer.id}${tab}`),
    ];

    for (const viewport of [
      { width: 320, height: 740 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      const admin = await Actor.open(browser, `faz3a-${viewport.width}`, primaryRuntime, { viewport });
      try {
        await admin.loginToAdmin(account.email, account.password);
        for (const path of paths) {
          await admin.gotoAdmin(path);
          await assertNoErrorScreen(admin.page);
          await expectNoHorizontalOverflow(admin.page, `${path} @${viewport.width}`);
        }
        if (viewport.width < 1440) {
          for (const [name, path] of [
            ['requests', '/requests'],
            ['request-reports', '/requests/reports'],
            ['offers', '/offers'],
            ['request-detail', `/requests/${request.id}`],
            ['request-detail-sikayet', `/requests/${request.id}?tab=sikayet`],
            ['offer-detail', `/offers/${offer.id}`],
            ['refund-scan', '/refund-scan'],
          ] as const) {
            await admin.gotoAdmin(path);
            await admin.page.screenshot({ path: shot(testInfo, `${name}-${viewport.width}`), fullPage: false });
          }
          // A confirmation fits the phone too.
          await admin.gotoAdmin(`/requests/${request.id}`);
          await admin.page.getByTestId('request-cancel').click();
          const dialog = admin.page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' });
          await expect(dialog).toBeVisible();
          const box = await dialog.boundingBox();
          expect(box && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);
          await admin.page.screenshot({ path: shot(testInfo, `request-cancel-dialog-${viewport.width}`), fullPage: false });
          await admin.page.keyboard.press('Escape');
        }
      } finally {
        await admin.close();
      }
    }
  });
});

/**
 * PR #118 review fixes. Each is the screen's own guard; the API still accepts
 * the same moves when called directly, which the PR reports as a separate
 * backend item rather than claiming it fixed here.
 */
test.describe('Faz 3A review: moves the screen no longer offers', () => {
  const MODERATION_BUTTONS = ['İncelemeye al', 'Onayla'];

  async function expectNoModerationMoves(page: Page, label: string) {
    for (const name of MODERATION_BUTTONS) {
      await expect(page.getByRole('button', { name, exact: true, includeHidden: true }), `${label}: ${name}`).toHaveCount(0);
    }
    await expect(page.getByTestId('request-moderation-closed'), label).toBeVisible();
  }

  /** An accepted offer on a request no customer account owns: the one a staff account may decide on. */
  async function seedGuestMatch() {
    const scene = await seedScene({ customerOwned: false });
    await prisma().offer.update({ where: { id: scene.offer.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
    await prisma().serviceRequest.update({
      where: { id: scene.request.id },
      data: { status: 'MATCHED', matchedOfferId: scene.offer.id, matchedAt: new Date() },
    });
    return scene;
  }

  test('an accepted offer is offered neither a reject nor a shortlist; a live one still is', async ({ browser }) => {
    const matched = await seedMatchedRequest();
    const guestMatch = await seedGuestMatch();
    const guestLive = await seedScene({ customerOwned: false });
    const admin = await openAs(browser, 'super');
    const staff = await openAs(browser, ['OFFERS_READ', 'OFFERS_STATUS']);

    try {
      for (const [actor, offerId, label] of [
        [admin, matched.offer.id, 'super admin'],
        [staff, guestMatch.offer.id, 'staff with OFFERS_STATUS'],
      ] as const) {
        await actor.gotoAdmin(`/offers/${offerId}`);
        await assertNoErrorScreen(actor.page);
        for (const testId of ['offer-reject', 'offer-shortlist', 'offer-accept']) {
          await expect(actor.page.getByTestId(testId), `${label}: ${testId}`).toHaveCount(0);
        }
        await expect(actor.page.getByTestId('offer-actions-note'), label).toContainText(
          'Kabul edilmiş teklifin durumu buradan değiştirilemez',
        );
        expect((await prisma().offer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('ACCEPTED');
      }

      // The same staff account, on a live offer of a guest request: the move
      // the API allows is offered, and it goes through.
      await staff.gotoAdmin(`/offers/${guestLive.offer.id}`);
      await expect(staff.page.getByTestId('offer-reject')).toBeVisible();
      await staff.page.getByTestId('offer-shortlist').click();
      await expect(staff.page.getByText('Teklif durumu güncellendi.')).toBeVisible();
      await expect
        .poll(async () => (await prisma().offer.findUniqueOrThrow({ where: { id: guestLive.offer.id } })).status)
        .toBe('SHORTLISTED');
      await assertNoErrorScreen(staff.page);
    } finally {
      await admin.close();
      await staff.close();
    }
  });

  test('moderation is offered only inside the queue: SUBMITTED, IN_REVIEW, APPROVED', async ({ browser }) => {
    const admin = await openAs(browser, 'super');
    const staff = await openAs(browser, ['REQUESTS_READ', 'REQUESTS_STATUS']);
    const reader = await openAs(browser, ['REQUESTS_READ']);

    try {
      // ---- every status outside the queue: no move, and a reason ----------
      const matched = await seedMatchedRequest();
      await admin.gotoAdmin(`/requests/${matched.request.id}`);
      await expectNoModerationMoves(admin.page, 'MATCHED (super admin)');
      await staff.gotoAdmin(`/requests/${matched.request.id}`);
      await expectNoModerationMoves(staff.page, 'MATCHED (staff)');

      for (const status of ['DRAFT', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const) {
        const { request } = await seedScene();
        await prisma().serviceRequest.update({ where: { id: request.id }, data: { status } });
        await admin.gotoAdmin(`/requests/${request.id}`);
        await assertNoErrorScreen(admin.page);
        await expectNoModerationMoves(admin.page, status);
        expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(status);
      }

      // ---- inside the queue: the moves work, the current one is closed ----
      const { request } = await seedScene();
      await prisma().serviceRequest.update({ where: { id: request.id }, data: { status: 'SUBMITTED', approvedAt: null } });
      await staff.gotoAdmin(`/requests/${request.id}`);
      const moves = staff.page.getByTestId('request-moderation-actions');
      await moves.getByRole('button', { name: 'İncelemeye al' }).click();
      await expect(staff.page.getByTestId('request-status')).toHaveText('İncelemede');
      await expect(moves.getByRole('button', { name: /^İncelemeye al/ })).toBeDisabled();
      // Publishing asks first (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2); the
      // first step into review above does not.
      await confirmThrough(moves.getByTestId('request-approve'), 'Evet, onayla ve yayınla');
      await expect(staff.page.getByTestId('request-status')).toHaveText('Onaylandı');
      await expect(moves.getByRole('button', { name: /^Onayla/ })).toBeDisabled();
      await expect(moves.getByRole('button', { name: 'İncelemeye al' })).toBeEnabled();
      await expect(staff.page.getByTestId('request-moderation-closed')).toHaveCount(0);

      // ---- no REQUESTS_STATUS: neither the moves nor the note --------------
      await reader.gotoAdmin(`/requests/${request.id}`);
      await expect(reader.page.getByTestId('request-moderation-actions')).toHaveCount(0);
      await expect(reader.page.getByTestId('request-moderation-closed')).toHaveCount(0);
    } finally {
      await admin.close();
      await staff.close();
      await reader.close();
    }
  });

  test('"Aynı talebe gelen diğer teklifler" lists the others only, and says so', async ({ browser }) => {
    const scene = await seedScene();
    const second = await createProvider({ categoryId: scene.category.id, location: scene.location, credits: STARTING_CREDITS });
    const other = await seedOffer({ requestId: scene.request.id, providerId: second.id, priceAmount: 210_000 });
    const lone = await seedScene();
    const reader = await openAs(browser, ['OFFERS_READ']);

    try {
      await reader.gotoAdmin(`/offers/${scene.offer.id}?tab=talep`);
      const card = reader.page.getByTestId('offer-siblings');
      const rows = card.getByTestId('offer-sibling-row');
      await expect(rows).toHaveCount(1);
      await expect(rows).toHaveAttribute('data-offer-id', other.id);
      await expect(rows).toContainText(second.businessName);
      await expect(rows).not.toContainText(scene.provider.businessName);
      await expect(reader.page.getByText('1 diğer teklif · talebe gelen toplam teklif: 2')).toBeVisible();
      await rows.getByRole('link', { name: /^Aç:/ }).click();
      await expect(reader.page).toHaveURL(new RegExp(`/offers/${other.id}$`));

      // From the other side, the first offer is the "other" one.
      await reader.gotoAdmin(`/offers/${other.id}?tab=talep`);
      await expect(reader.page.getByTestId('offer-sibling-row')).toHaveAttribute('data-offer-id', scene.offer.id);

      // A request with a single offer: the empty state, and the true count.
      await reader.gotoAdmin(`/offers/${lone.offer.id}?tab=talep`);
      await expect(reader.page.getByTestId('offer-siblings')).toContainText('Bu talebe başka teklif gelmedi.');
      await expect(reader.page.getByTestId('offer-sibling-row')).toHaveCount(0);
      await expect(reader.page.getByText('0 diğer teklif · talebe gelen toplam teklif: 1')).toBeVisible();
    } finally {
      await reader.close();
    }
  });
});

/**
 * The API's own status guards (PR #119 API-GUARD-OFFER-001 / REQUEST-001,
 * PR #120 API-GUARD-REQUEST-002) and the lifecycle endpoints answer a write
 * the row's state no longer allows with a 409. The screen only draws the
 * moves the state allows, so the realistic way to reach one is a page drawn
 * before the row moved — reproduced here by changing the row under an open
 * page. Each refusal must land next to the control that was used, say what
 * happened, and leave the database exactly as it was.
 *
 * Also pinned: no refusal or hint sends the operator to "İptal et" as a
 * substitute for a rejection. A closed request cannot be cancelled, and a
 * matched request's cancel leaves the accepted offer, its credit and the
 * notifications to open product decisions (ADMIN-ACTIONS-005 K2–K5).
 *
 * Screens are taken at 1440px in Chromium and 320px in WebKit, into their own
 * folder so they are never mixed up with the earlier head's.
 */
test.describe('Faz 3A: API refusals land on the screen, not the error boundary', () => {
  const SHOTS_409 = resolve(artifactsDir, 'admin-design-409');
  const OLD_CANCEL_HINT = /İptal et['’"”]?\s*kullan/;

  function viewportFor(testInfo: TestInfo) {
    return testInfo.project.name === 'webkit' ? { width: 320, height: 760 } : DESKTOP;
  }

  async function capture(page: Page, testInfo: TestInfo, name: string, focus?: ReturnType<Page['getByTestId']>) {
    if (focus) await focus.scrollIntoViewIfNeeded();
    mkdirSync(SHOTS_409, { recursive: true });
    const width = page.viewportSize()?.width ?? 0;
    await page.screenshot({ path: resolve(SHOTS_409, `${testInfo.project.name}-${name}-${width}.png`), fullPage: false });
  }

  test('a decided offer: the 409 is explained on the operations list and nothing moves', async ({
    browser,
  }, testInfo) => {
    const viewport = viewportFor(testInfo);
    const guestLive = await seedScene({ customerOwned: false });
    const customerOwned = await seedScene();
    const staff = await openAs(browser, ['OFFERS_READ', 'OFFERS_STATUS'], viewport);
    const admin = await openAs(browser, 'super', viewport);

    try {
      // ---- rejected under the page, then shortlisted ------------------------
      await staff.gotoAdmin(`/offers/${guestLive.offer.id}`);
      await expect(staff.page.getByTestId('offer-shortlist')).toBeVisible();
      await prisma().offer.update({
        where: { id: guestLive.offer.id },
        data: { status: 'REJECTED', rejectedAt: new Date() },
      });
      await staff.page.getByTestId('offer-shortlist').click();
      const staffError = staff.page.getByTestId('offer-status-error');
      await expect(staffError).toContainText('Bu teklif için karar zaten verilmiş');
      await expect(staff.page).toHaveURL(/statusError=decided/);
      await assertNoErrorScreen(staff.page);
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: guestLive.offer.id } })).status).toBe('REJECTED');
      // Redrawn from the new state: nothing a rejected offer cannot do is offered.
      for (const testId of ['offer-shortlist', 'offer-reject', 'offer-accept']) {
        await expect(staff.page.getByTestId(testId), testId).toHaveCount(0);
      }
      await expect(staff.page.getByTestId('offer-actions-note')).toContainText('Reddedilmiş teklif yeniden açılamaz');
      await capture(staff.page, testInfo, 'offer-409-decided', staffError);

      // ---- accepted and matched under the page, then rejected ---------------
      const { offer, request } = customerOwned;
      await admin.gotoAdmin(`/offers/${offer.id}`);
      await prisma().offer.update({ where: { id: offer.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      await prisma().serviceRequest.update({
        where: { id: request.id },
        data: { status: 'MATCHED', matchedOfferId: offer.id, matchedAt: new Date() },
      });
      await admin.page.getByTestId('offer-reject').click();
      await admin.page
        .getByRole('dialog', { name: 'Teklif müşteri adına reddedilsin mi?' })
        .getByRole('button', { name: 'Evet, reddet' })
        .click();
      await expect(admin.page.getByTestId('offer-status-error')).toContainText('kabul edilmiş teklif reddedilemez');
      await assertNoErrorScreen(admin.page);
      const kept = await prisma().offer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(kept.status).toBe('ACCEPTED');
      expect(kept.rejectedAt).toBeNull();
      const stillMatched = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(stillMatched.status).toBe('MATCHED');
      expect(stillMatched.matchedOfferId).toBe(offer.id);
      await expect(admin.page.getByTestId('offer-actions-note')).toContainText(
        'Kabul edilmiş teklifin durumu buradan değiştirilemez',
      );
    } finally {
      await staff.close();
      await admin.close();
    }
  });

  test('a request that moved under the page: moderation, cancel and complete explain the 409', async ({
    browser,
  }, testInfo) => {
    const admin = await openAs(browser, 'super', viewportFor(testInfo));
    const page = admin.page;
    const statusError = page.getByTestId('status-error');

    try {
      // ---- "Onayla" on a request that was cancelled meanwhile ---------------
      const moderated = await seedScene();
      await prisma().serviceRequest.update({
        where: { id: moderated.request.id },
        data: { status: 'SUBMITTED', approvedAt: null },
      });
      await admin.gotoAdmin(`/requests/${moderated.request.id}`);
      await prisma().serviceRequest.update({
        where: { id: moderated.request.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await confirmThrough(page.getByTestId('request-approve'), 'Evet, onayla ve yayınla');
      await expect(statusError).toContainText('Talep artık inceleme kuyruğunda değil');
      await expect(page).toHaveURL(/statusError=transitionNotAllowed/);
      await assertNoErrorScreen(page);
      const afterModeration = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: moderated.request.id } });
      expect(afterModeration.status).toBe('CANCELLED');
      expect(afterModeration.approvedAt).toBeNull();
      await expect(page.getByTestId('request-status')).toHaveText('İptal Edildi');
      await capture(page, testInfo, 'request-409-transition', statusError);

      // ---- "İptal et" on a request that was completed meanwhile -------------
      const cancelled = await seedScene();
      await admin.gotoAdmin(`/requests/${cancelled.request.id}`);
      await prisma().serviceRequest.update({
        where: { id: cancelled.request.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await page.getByTestId('request-cancel').click();
      await page
        .getByRole('dialog', { name: 'Talep iptal edilsin mi?' })
        .getByRole('button', { name: 'Evet, iptal et' })
        .click();
      await expect(statusError).toContainText('Talep iptal edilmedi');
      await expect(page).toHaveURL(/statusError=notCancellable/);
      await assertNoErrorScreen(page);
      const afterCancel = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: cancelled.request.id } });
      expect(afterCancel.status).toBe('COMPLETED');
      expect(afterCancel.cancelledAt).toBeNull();
      // The closed request's reject hint says a cancel is not possible either.
      await page.locator('details.status-reject-block > summary').click();
      await expect(page.getByTestId('status-reject-hint')).toContainText('Kapanmış talep reddedilemez');
      await expect(page.getByTestId('status-reject-hint')).not.toContainText(OLD_CANCEL_HINT);
      await capture(page, testInfo, 'request-409-not-cancellable', statusError);

      // ---- a matched request: a stale "tamamla" -----------------------------
      const matched = await seedMatchedRequest();
      await admin.gotoAdmin(`/requests/${matched.request.id}`);
      await prisma().serviceRequest.update({
        where: { id: matched.request.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await confirmThrough(page.getByTestId('request-complete'), 'Evet, tamamlandı işaretle');
      await expect(statusError).toContainText('Talep tamamlandı olarak işaretlenmedi');
      await expect(page).toHaveURL(/statusError=notCompletable/);
      await assertNoErrorScreen(page);
      const afterComplete = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: matched.request.id } });
      expect(afterComplete.status).toBe('CANCELLED');
      expect(afterComplete.completedAt).toBeNull();
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: matched.offer.id } })).status).toBe('ACCEPTED');
    } finally {
      await admin.close();
    }
  });

  test('a rejection refused because the request matched meanwhile explains why, without steering to "İptal et"', async ({
    browser,
  }, testInfo) => {
    const scene = await seedScene();
    const admin = await openAs(browser, 'super', viewportFor(testInfo));
    const page = admin.page;

    try {
      await admin.gotoAdmin(`/requests/${scene.request.id}`);
      await page.locator('details.status-reject-block > summary').click();
      await page.getByLabel('Ret gerekçesi (zorunlu)').fill('Test amaçlı açılmış bir talep.');
      // The customer accepts the offer while the operator is typing.
      await prisma().offer.update({ where: { id: scene.offer.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
      await prisma().serviceRequest.update({
        where: { id: scene.request.id },
        data: { status: 'MATCHED', matchedOfferId: scene.offer.id, matchedAt: new Date() },
      });
      await page.getByTestId('status-reject').click();
      await page
        .getByRole('dialog', { name: 'Talep reddedilsin mi?' })
        .getByRole('button', { name: 'Evet, reddet' })
        .click();

      const statusError = page.getByTestId('status-error');
      await expect(page).toHaveURL(/statusError=notRemovable/);
      await expect(statusError).toContainText('Talep reddedilmedi');
      await expect(statusError).toContainText('eşleşmiş talep reddedilemez');
      await expect(statusError).toContainText('Eşleşmeyi sonlandıran işlem');
      await expect(statusError).toContainText('Müşteri eşleşmiş talebi iptal edemez');
      await expect(statusError).not.toContainText(OLD_CANCEL_HINT);
      await assertNoErrorScreen(page);
      await capture(page, testInfo, 'request-409-not-removable', statusError);

      const after = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: scene.request.id } });
      expect(after.status).toBe('MATCHED');
      expect(after.matchedOfferId).toBe(scene.offer.id);
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: scene.offer.id } })).status).toBe('ACCEPTED');
      expect(await countRefundTransactions(scene.provider.id)).toBe(0);

      // The same reason on the Şikayet tab, where "Talebi kaldır" is now closed.
      await admin.gotoAdmin(`/requests/${scene.request.id}?tab=sikayet`);
      const removeHint = page.getByTestId('report-remove-hint');
      await expect(removeHint).toContainText('eşleşmiş talep reddedilemez ve şikayetle kaldırılamaz');
      await expect(removeHint).not.toContainText(OLD_CANCEL_HINT);
    } finally {
      await admin.close();
    }
  });

  test('the matched cancel: the dialog counts what it will do, and the database shows exactly that', async ({
    browser,
  }, testInfo) => {
    const matched = await seedMatchedRequest();
    const request = await prisma().serviceRequest.findUniqueOrThrow({
      where: { id: matched.request.id },
      select: { categoryId: true, city: true, district: true },
    });
    const location = { city: request.city, district: request.district };
    const winnerProviderId = (await prisma().offer.findUniqueOrThrow({ where: { id: matched.offer.id } })).providerId;
    // An old row the acceptance did not close, a competitor it rejected, and
    // one the customer rejected by hand before accepting.
    const straggler = await createProvider({ categoryId: request.categoryId, location, credits: STARTING_CREDITS });
    const loser = await createProvider({ categoryId: request.categoryId, location, credits: STARTING_CREDITS });
    const declined = await createProvider({ categoryId: request.categoryId, location, credits: STARTING_CREDITS });
    const liveOffer = await seedOffer({ requestId: matched.request.id, providerId: straggler.id, status: 'VIEWED' });
    const lostOffer = await seedOffer({ requestId: matched.request.id, providerId: loser.id });
    const declinedOffer = await seedOffer({ requestId: matched.request.id, providerId: declined.id });
    await prisma().offer.update({
      where: { id: lostOffer.id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: 'COMPETITOR_ACCEPTED' },
    });
    await prisma().offer.update({ where: { id: declinedOffer.id }, data: { status: 'REJECTED', rejectedAt: new Date() } });
    const admin = await openAs(browser, 'super', viewportFor(testInfo));
    const page = admin.page;

    try {
      await admin.gotoAdmin(`/requests/${matched.request.id}`);
      await page.locator('details.status-reject-block > summary').click();
      await expect(page.getByTestId('status-reject-hint')).toContainText('Eşleşmeyi sonlandıran işlem');
      await expect(page.getByTestId('status-reject-hint')).not.toContainText(OLD_CANCEL_HINT);

      await expect(page.getByTestId('match-state')).toContainText('Aktif');
      const refundWinner = page.getByTestId('request-cancel-refund-winner');
      await expect(refundWinner).toBeChecked();
      await expect(refundWinner).toBeEnabled();
      await page.getByTestId('request-cancel').click();
      const dialog = page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' });
      await expect(page.getByTestId('request-cancel-winner')).toContainText('Kabul edilen teklif kapatılır ve eşleşme sona erer');
      await expect(page.getByTestId('request-cancel-winner')).toContainText('Kazanan teklifin 3 kredisi iade edilir');
      const others = page.getByTestId('request-cancel-other-offers');
      await expect(others).toContainText('Kabul edilen dışında 1 açık teklif');
      // Named "rejected because another was accepted" only on the record's word.
      await expect(others).toContainText('Başka teklif kabul edildiği için reddedilmiş 1 teklifin harcanan kredisi iade edilir');
      await expect(others).toContainText('Elle reddedilmiş 1 teklifin de harcanan kredisi iade edilir');
      await expect(others).not.toContainText('kabul anında reddedilmiş');
      await capture(page, testInfo, 'request-cancel-dialog-matched');

      await dialog.getByRole('button', { name: 'Evet, iptal et' }).click();
      await expect(page.getByTestId('request-status')).toHaveText('İptal Edildi');
      await expect(page.getByTestId('request-cancelled-notice')).toBeVisible();
      await expect(page.getByTestId('request-cancellation-decision')).toHaveText('Kazanan teklifin kredisi iade edildi');
      // The historical match pointer is shown as an ended match, never a live one.
      await expect(page.getByTestId('match-state')).toContainText('Sona erdi · talep iptal edildi');
      await expect(page.getByTestId('match-state')).not.toContainText('Aktif');
      await assertNoErrorScreen(page);
      await capture(page, testInfo, 'request-cancellation-record', page.getByTestId('request-cancellation'));

      const offers = await prisma().offer.findMany({
        where: { requestId: matched.request.id },
        select: { id: true, status: true, acceptedAt: true },
      });
      const byId = new Map(offers.map((offer) => [offer.id, offer]));
      expect(byId.get(matched.offer.id)?.status).toBe('CANCELLED');
      expect(byId.get(matched.offer.id)?.acceptedAt).not.toBeNull();
      expect(byId.get(liveOffer.id)?.status).toBe('CANCELLED');
      expect(byId.get(lostOffer.id)?.status).toBe('REJECTED');
      expect(byId.get(declinedOffer.id)?.status).toBe('REJECTED');
      expect(await countRefundTransactions(winnerProviderId)).toBe(1);
      expect(await countRefundTransactions(straggler.id)).toBe(1);
      expect(await countRefundTransactions(loser.id)).toBe(1);
      // K4: the offer the customer declined by hand gets its credit back too.
      expect(await countRefundTransactions(declined.id)).toBe(1);
      const closed = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: matched.request.id } });
      expect(closed.status).toBe('CANCELLED');
      expect(closed.matchedOfferId).toBe(matched.offer.id);
      // Notices: the customer, the winner and the three affected offers (the
      // straggler closed and refunded, the competitor and the hand-declined
      // offer refunded).
      const notices = () =>
        prisma().notificationLog.findMany({
          where: { requestId: matched.request.id, template: { startsWith: 'request-cancelled' } },
          select: { template: true, dedupeKey: true },
        });
      await expect.poll(async () => (await notices()).length).toBe(5);
      const keys = (await notices()).map((row) => row.dedupeKey).sort();
      expect(keys).toEqual(
        [
          `request-cancelled-customer:${matched.request.id}`,
          `request-cancelled-offer:${liveOffer.id}`,
          `request-cancelled-offer:${lostOffer.id}`,
          `request-cancelled-offer:${declinedOffer.id}`,
          `request-cancelled-winner:${matched.offer.id}`,
        ].sort(),
      );
    } finally {
      await admin.close();
    }
  });

  test('the open-request cancel dialog says its live offers close and are refunded', async ({ browser }, testInfo) => {
    const { request } = await seedScene();
    const admin = await openAs(browser, 'super', viewportFor(testInfo));
    const page = admin.page;

    try {
      await admin.gotoAdmin(`/requests/${request.id}`);
      await expect(page.getByTestId('request-cancel-refund-winner')).toHaveCount(0);
      await page.getByTestId('request-cancel').click();
      const dialog = page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' });
      await expect(page.getByTestId('request-cancel-other-offers')).toContainText(
        '1 açık teklif (gönderildi, görüntülendi, kısa listede) kapatılır ve harcanan kredileri iade edilir',
      );
      await expect(dialog).toContainText('Daha önce iade edilmiş hiçbir kredi ikinci kez iade edilmez');
      await capture(page, testInfo, 'request-cancel-dialog-open');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('APPROVED');
    } finally {
      await admin.close();
    }
  });

  test('operations cancel: REQUESTS_CANCEL refunds the winner; withholding needs its own permission and a reason', async ({
    browser,
  }, testInfo) => {
    const viewport = viewportFor(testInfo);
    const canceller = await openAs(browser, ['REQUESTS_READ', 'REQUESTS_CANCEL'], viewport);
    const withholder = await openAs(browser, ['REQUESTS_READ', 'REQUESTS_CANCEL', 'REQUESTS_CANCEL_WITHOUT_REFUND'], viewport);
    const moderator = await openAs(browser, ['REQUESTS_READ', 'REQUESTS_STATUS'], viewport);

    try {
      // ---- REQUESTS_CANCEL alone: the refund box is checked and locked ------
      const first = await seedMatchedRequest();
      const firstWinner = (await prisma().offer.findUniqueOrThrow({ where: { id: first.offer.id } })).providerId;
      await canceller.gotoAdmin(`/requests/${first.request.id}`);
      const locked = canceller.page.getByTestId('request-cancel-refund-winner');
      await expect(locked).toBeChecked();
      await expect(locked).toBeDisabled();
      await expect(canceller.page.getByTestId('request-cancel-refund-locked')).toContainText('ayrı yetki ister');
      await canceller.page.getByTestId('request-cancel').click();
      await canceller.page
        .getByRole('dialog', { name: 'Talep iptal edilsin mi?' })
        .getByRole('button', { name: 'Evet, iptal et' })
        .click();
      await expect(canceller.page.getByTestId('request-status')).toHaveText('İptal Edildi');
      expect(await countRefundTransactions(firstWinner)).toBe(1);
      const firstAudit = await prisma().serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: first.request.id } });
      expect(firstAudit).toMatchObject({ actorKind: 'STAFF', winnerRefundDecision: 'REFUNDED', withholdReason: null });

      // ---- with the exception permission: unchecking asks for a reason -----
      const second = await seedMatchedRequest();
      const secondWinner = (await prisma().offer.findUniqueOrThrow({ where: { id: second.offer.id } })).providerId;
      const page = withholder.page;
      await withholder.gotoAdmin(`/requests/${second.request.id}`);
      const box = page.getByTestId('request-cancel-refund-winner');
      await expect(box).toBeEnabled();
      await box.uncheck();
      const reason = page.getByTestId('request-cancel-withhold-reason');
      await expect(reason).toBeVisible();
      // An empty reason is the browser's to refuse: no dialog, nothing posted.
      const dialog = page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' });
      await page.getByTestId('request-cancel').click();
      await expect(dialog).toBeHidden();
      const withheldReason = 'Hizmet veren müşteriye ulaşmadığını kendisi bildirdi.';
      await reason.fill(withheldReason);
      await page.getByTestId('request-cancel').click();
      await expect(page.getByTestId('request-cancel-winner')).toContainText('Kazanan teklifin kredisi iade edilmez');
      await capture(page, testInfo, 'request-cancel-dialog-withhold');
      await dialog.getByRole('button', { name: 'Evet, iptal et' }).click();
      await expect(page.getByTestId('request-status')).toHaveText('İptal Edildi');
      await expect(page.getByTestId('request-cancellation-reason')).toHaveText(withheldReason);
      await assertNoErrorScreen(page);
      expect(await countRefundTransactions(secondWinner)).toBe(0);
      const secondAudit = await prisma().serviceRequestCancellation.findUniqueOrThrow({ where: { requestId: second.request.id } });
      expect(secondAudit).toMatchObject({ winnerRefundDecision: 'WITHHELD', withholdReason: withheldReason });

      // ---- without REQUESTS_CANCEL: no cancel control at all ---------------
      const third = await seedMatchedRequest();
      await moderator.gotoAdmin(`/requests/${third.request.id}`);
      await expect(moderator.page.getByTestId('request-cancel')).toHaveCount(0);
      await expect(moderator.page.getByRole('button', { name: 'İptal et', includeHidden: true })).toHaveCount(0);
    } finally {
      await canceller.close();
      await withholder.close();
      await moderator.close();
    }
  });

  test('the customer cancels their own request until an offer is accepted', async ({ browser }, testInfo) => {
    const viewport = viewportFor(testInfo);
    const open = await seedScene();
    const customer = await Actor.open(browser, 'customer', primaryRuntime, { viewport });

    try {
      await customer.loginToWeb(open.customer.email, open.customer.password);
      const page = customer.page;

      // ---- an open request: asked first, then cancelled ---------------------
      await customer.gotoWeb(`/requests/${open.request.id}/offers`);
      await page.getByTestId('customer-cancel-request').click();
      const dialog = page.getByTestId('customer-cancel-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('customer-cancel-offers')).toContainText('Açık 1 teklif kapatılır');
      await expect(dialog).toContainText('İptal teyidi, talebinizde kayıtlı e-posta adresine gönderilir');
      await expect(dialog).not.toContainText('kredi');
      await capture(page, testInfo, 'customer-cancel-dialog');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: open.request.id } })).status).toBe('APPROVED');

      await page.getByTestId('customer-cancel-request').click();
      await page.getByTestId('customer-cancel-confirm').click();
      await expect(page.getByTestId('customer-cancel-outcome')).toContainText('Talebiniz iptal edildi');
      await expect(page.getByTestId('customer-cancel-request')).toHaveCount(0);
      await capture(page, testInfo, 'customer-cancelled');
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: open.request.id } })).status).toBe('CANCELLED');
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: open.offer.id } })).status).toBe('CANCELLED');
      expect(await countRefundTransactions(open.provider.id)).toBe(1);

      // ---- a request with no offer: the dialog says so, and promises nothing --
      const empty = await seedCustomerRequest({
        customerId: open.customer.id,
        categoryId: open.category.id,
        location: open.location,
        content: 'full',
      });
      await customer.gotoWeb(`/requests/${empty.id}/offers`);
      await page.getByTestId('customer-cancel-request').click();
      const emptyDialog = page.getByTestId('customer-cancel-dialog');
      await expect(page.getByTestId('customer-cancel-offers')).toContainText(
        'Bu talepte şu anda açık teklif yok; iptalden sonra da yeni teklif gelmez.',
      );
      await expect(emptyDialog).not.toContainText('Teklif veren olursa');
      await capture(page, testInfo, 'customer-cancel-dialog-no-offers');
      await emptyDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(emptyDialog).toBeHidden();
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe('APPROVED');

      // ---- a request that matched while the page was open: 409, explained --
      const stale = await seedScene();
      const staleCustomer = await Actor.open(browser, 'customer-stale', primaryRuntime, { viewport });
      try {
        await staleCustomer.loginToWeb(stale.customer.email, stale.customer.password);
        await staleCustomer.gotoWeb(`/requests/${stale.request.id}/offers`);
        await prisma().offer.update({ where: { id: stale.offer.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } });
        await prisma().serviceRequest.update({
          where: { id: stale.request.id },
          data: { status: 'MATCHED', matchedOfferId: stale.offer.id, matchedAt: new Date() },
        });
        await staleCustomer.page.getByTestId('customer-cancel-request').click();
        await staleCustomer.page.getByTestId('customer-cancel-confirm').click();
        const outcome = staleCustomer.page.getByTestId('customer-cancel-outcome');
        await expect(outcome).toContainText('bir teklifi kabul ettiğiniz için');
        await assertNoErrorScreen(staleCustomer.page);
        // Redrawn as matched: no cancel offered any more.
        await expect(staleCustomer.page.getByTestId('customer-cancel-request')).toHaveCount(0);
        await capture(staleCustomer.page, testInfo, 'customer-cancel-refused-matched');
        const kept = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: stale.request.id } });
        expect(kept.status).toBe('MATCHED');
        expect((await prisma().offer.findUniqueOrThrow({ where: { id: stale.offer.id } })).status).toBe('ACCEPTED');
        expect(await prisma().serviceRequestCancellation.count({ where: { requestId: stale.request.id } })).toBe(0);
      } finally {
        await staleCustomer.close();
      }
    } finally {
      await customer.close();
    }
  });

  test('closed and draft requests: the reject hint names the real path for each status', async ({ browser }) => {
    const admin = await openAs(browser, 'super');
    const page = admin.page;

    try {
      const expected: Record<string, string> = {
        COMPLETED: 'Talep tamamlandı. Kapanmış talep reddedilemez, kaldırılamaz ve iptal edilemez',
        CANCELLED: 'Talep iptal edildi. Kapanmış talep reddedilemez, kaldırılamaz ve yeniden açılamaz',
        EXPIRED: 'Talebin süresi doldu. Kapanmış talep reddedilemez, kaldırılamaz ve iptal edilemez',
        REJECTED: 'Talep zaten reddedilmiş',
        DRAFT: 'Taslak reddedilemez',
      };
      for (const [status, text] of Object.entries(expected)) {
        const { request } = await seedScene();
        await prisma().serviceRequest.update({
          where: { id: request.id },
          data: { status: status as 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED' | 'DRAFT' },
        });
        await admin.gotoAdmin(`/requests/${request.id}`);
        const hint = page.getByTestId('status-reject-hint');
        await expect(hint, status).toContainText(text);
        await expect(hint, status).not.toContainText(OLD_CANCEL_HINT);
        // A closed request offers no cancel; a draft is the one that still may.
        if (status === 'DRAFT') {
          await expect(page.getByTestId('request-cancel'), status).toBeVisible();
        } else {
          await expect(page.getByTestId('request-cancel'), status).toHaveCount(0);
        }
      }
    } finally {
      await admin.close();
    }
  });

  test('an admin acceptance without the customer’s disclosure consent is explained, not a crash', async ({
    browser,
  }, testInfo) => {
    const { offer, request } = await seedScene();
    const admin = await openAs(browser, 'super', viewportFor(testInfo), contactSharingRuntime);

    try {
      await admin.gotoAdmin(`/offers/${offer.id}`);
      await admin.page.getByTestId('offer-accept').click();
      await admin.page
        .getByRole('dialog', { name: 'Teklif müşteri adına kabul edilsin mi?' })
        .getByRole('button', { name: 'Evet, kabul et' })
        .click();
      const error = admin.page.getByTestId('offer-status-error');
      await expect(error).toContainText('müşterinin güncel bilgilendirme metnine onayı kayıtlı değil');
      await expect(admin.page).toHaveURL(/statusError=disclosureRequired/);
      await assertNoErrorScreen(admin.page);
      await capture(admin.page, testInfo, 'offer-409-disclosure', error);
      expect((await prisma().offer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('SUBMITTED');
      const unchanged = await prisma().serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(unchanged.status).toBe('APPROVED');
      expect(unchanged.matchedOfferId).toBeNull();
      expect(await prisma().contactRevealEvent.count({ where: { requestId: request.id } })).toBe(0);
    } finally {
      await admin.close();
    }
  });
});
