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
import { artifactsDir, primaryRuntime } from '../src/runtime';

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
) {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime, { viewport });
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

      // ---- "İptal et" (a super admin's alone) ----------------------------
      await admin.gotoAdmin(`/requests/${second.request.id}`);
      const cancel = page.getByTestId('request-cancel');
      const cancelDialog = page.getByRole('dialog', { name: 'Talep iptal edilsin mi?' });
      await cancel.click();
      await expect(cancelDialog).toContainText('harcanan krediler iade edilmez');
      await cancelDialog.getByRole('button', { name: 'Kapat' }).click();
      await expect(cancelDialog).toBeHidden();
      await page.waitForTimeout(300);
      expect((await prisma().serviceRequest.findUniqueOrThrow({ where: { id: second.request.id } })).status).toBe(
        'APPROVED',
      );
      await cancel.click();
      await cancelDialog.getByRole('button', { name: 'Evet, iptal et' }).click();
      await expect(page.getByTestId('request-status')).toHaveText('İptal Edildi');

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
      // The run, then the fresh preview.
      expect(actionCalls).toBe(2);
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
