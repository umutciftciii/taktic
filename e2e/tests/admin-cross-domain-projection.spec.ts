import { expect, test, type Page } from '@playwright/test';
// The canonical terms text and its snapshot layout: two side-effect-free
// modules, so the refund fixture writes exactly the evidence the checkout
// writes (the database recomputes and checks its digest and shape).
import { PURCHASE_TERMS_DOCUMENT_SET } from '../../apps/api/src/modules/purchase-terms/purchase-terms.documents';
import { buildPurchaseTermsSnapshot, sha256Hex } from '../../apps/api/src/modules/purchase-terms/purchase-terms.snapshot';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createLemonSqueezyCreditPackage,
  createProvider,
  createStaffAdmin,
  createSupportTicket,
  prisma,
  uniqueLocation,
  uniqueSuffix,
} from '../src/fixtures';
import { seedActiveCampaign, seedGrantedLot } from '../src/campaign-fixtures';
import { seedOffer } from '../src/offer-fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001 through the real screens.
 *
 * The API now leaves another domain's block out of an admin response for a
 * session that cannot read that domain: a provider's balance, offers and
 * purchases; a customer's requests and offers; a request owner's contact on
 * an offer; the customer account behind a request. These pin that the
 * screens follow — no column, figure, tab or row for a block that was not
 * sent, no error screen where a response got smaller — and that SUPER_ADMIN
 * still sees every block.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

async function expectOpen(page: Page) {
  await assertNoErrorScreen(page);
  await expect(page).not.toHaveURL(/\/yetkisiz$/);
}

const header = (page: Page, name: string) => page.getByRole('columnheader', { name, exact: true });

/** One provider with a balance, an offer on one customer's request and a paid purchase. */
async function seedWorld() {
  const location = uniqueLocation();
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Projeksiyon');
  const provider = await createProvider({ categoryId: category.id, location, credits: 40 });
  const request = await seedCustomerRequest({ customerId: customer.id, categoryId: category.id, location, content: 'full' });
  const offer = await seedOffer({ requestId: request.id, providerId: provider.id });
  const pkg = await createLemonSqueezyCreditPackage({ creditAmount: 10, priceAmount: 10_000 });
  await prisma().packagePurchase.create({
    data: {
      providerId: provider.id,
      packageId: pkg.id,
      status: 'PAID',
      creditAmountSnapshot: 10,
      priceAmountSnapshot: 10_000,
      packageNameSnapshot: pkg.name,
      paidAt: new Date(),
    },
  });
  const stored = await prisma().serviceRequest.findUniqueOrThrow({
    where: { id: request.id },
    select: { customerName: true, customerPhone: true, customerEmail: true },
  });
  const account = await prisma().user.findUniqueOrThrow({ where: { id: customer.id }, select: { email: true } });
  const profile = await prisma().providerProfile.findUniqueOrThrow({
    where: { id: provider.id },
    select: { contactName: true },
  });
  return { category, customer, provider, request, offer, stored, account, profile };
}

test.describe('provider screens', () => {
  test('the list and the page draw no balance, offer or purchase figure the session cannot read', async ({ browser }) => {
    const { provider } = await seedWorld();
    const reader = await openAs(browser, ['PROVIDERS_READ', 'PROVIDERS_READ_DETAIL']);
    const offers = await openAs(browser, ['PROVIDERS_READ', 'PROVIDERS_READ_DETAIL', 'OFFERS_READ']);
    const admin = await openAs(browser, 'super');

    try {
      const search = `/providers?q=${encodeURIComponent(provider.businessName)}`;

      await reader.gotoAdmin(search);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('provider-row')).toHaveCount(1);
      for (const name of ['Kredi', 'Açık teklif', 'Paket']) await expect(header(reader.page, name)).toHaveCount(0);
      await expect(reader.page.getByTestId('provider-credit')).toHaveCount(0);

      await reader.gotoAdmin(`/providers/${provider.id}`);
      await expectOpen(reader.page);
      const readerTabs = reader.page.getByRole('navigation', { name: 'Hizmet veren sekmeleri' });
      await expect(readerTabs.getByRole('link')).toHaveText(['İşletme bilgileri', 'Neler oldu']);
      for (const testId of ['provider-fact-credit', 'provider-fact-open-offers', 'provider-fact-purchases']) {
        await expect(reader.page.getByTestId(testId)).toHaveCount(0);
      }
      // A hand-written tab it has nothing for falls back to the first tab.
      await reader.gotoAdmin(`/providers/${provider.id}?tab=teklifler`);
      await expect(reader.page.getByTestId('provider-panel-teklifler')).toHaveCount(0);

      // OFFERS_READ opens the offers — and only them.
      await offers.gotoAdmin(search);
      await expect(header(offers.page, 'Açık teklif')).toBeVisible();
      await expect(header(offers.page, 'Kredi')).toHaveCount(0);
      await offers.gotoAdmin(`/providers/${provider.id}?tab=teklifler`);
      await expectOpen(offers.page);
      await expect(offers.page.getByTestId('provider-tab-teklifler')).toContainText('Teklifler');
      await expect(offers.page.getByTestId('provider-tab-teklifler')).not.toContainText('paketler');
      await expect(offers.page.getByTestId('provider-recent-offers').locator('tbody tr')).toHaveCount(1);
      await expect(offers.page.getByText('Son paket alımları')).toHaveCount(0);
      await expect(offers.page.getByTestId('provider-fact-credit')).toHaveCount(0);
      await expect(offers.page.getByTestId('provider-fact-open-offers')).toContainText('1');

      // SUPER_ADMIN: every column, figure and card.
      await admin.gotoAdmin(search);
      for (const name of ['Kredi', 'Açık teklif', 'Paket']) await expect(header(admin.page, name)).toBeVisible();
      await expect(admin.page.getByTestId('provider-credit')).toContainText('37');
      await admin.gotoAdmin(`/providers/${provider.id}?tab=teklifler`);
      await expect(admin.page.getByTestId('provider-tab-teklifler')).toContainText('Teklifler ve paketler');
      await expect(admin.page.getByTestId('provider-fact-credit')).toContainText('37');
      await expect(admin.page.getByTestId('provider-fact-purchases')).toContainText('1');
      await expect(admin.page.getByTestId('provider-recent-purchases').locator('tbody tr')).toHaveCount(1);
    } finally {
      await reader.close();
      await offers.close();
      await admin.close();
    }
  });
});

test.describe('customer screens', () => {
  test('the account alone: no request or offer column, sort, filter, figure or tab', async ({ browser }) => {
    const { customer, account } = await seedWorld();
    const reader = await openAs(browser, ['CUSTOMERS_READ']);
    const requests = await openAs(browser, ['CUSTOMERS_READ', 'REQUESTS_READ']);
    const admin = await openAs(browser, 'super');

    try {
      const search = `/customers?q=${encodeURIComponent(account.email!)}`;

      await reader.gotoAdmin(search);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('customer-row')).toHaveCount(1);
      for (const name of ['Şehir', 'Talep', 'Teklif', 'Kabul', 'Son talep']) {
        await expect(header(reader.page, name)).toHaveCount(0);
      }
      await expect(reader.page.locator('#customer-city')).toHaveCount(0);
      await expect(reader.page.locator('#customer-sort option')).toHaveText(['İsim', 'Kayıt tarihi']);
      // A bookmarked sort it may not use falls back instead of failing.
      await reader.gotoAdmin('/customers?sortBy=requestCount&city=%C4%B0stanbul');
      await expectOpen(reader.page);

      await reader.gotoAdmin(`/customers/${customer.id}`);
      await expectOpen(reader.page);
      const tabs = reader.page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(tabs.getByRole('link')).toHaveText(['Profil ve iletişim', 'Neler oldu']);
      await expect(reader.page.getByTestId('customer-fact-requests')).toHaveCount(0);
      await expect(reader.page.getByTestId('customer-fact-offers')).toHaveCount(0);

      // REQUESTS_READ adds the requests and nothing of the offers.
      await requests.gotoAdmin(search);
      await expect(header(requests.page, 'Talep')).toBeVisible();
      await expect(header(requests.page, 'Teklif')).toHaveCount(0);
      await expect(requests.page.getByTestId('customer-request-count')).toContainText('1');
      await requests.gotoAdmin(`/customers/${customer.id}`);
      const requestTabs = requests.page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(requestTabs.getByRole('link')).toHaveText(['Profil ve iletişim', /Talep geçmişi/, 'Neler oldu']);
      await expect(requests.page.getByTestId('customer-fact-requests')).toContainText('1');

      await admin.gotoAdmin(`/customers/${customer.id}`);
      const adminTabs = admin.page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(adminTabs.getByRole('link')).toHaveText([
        'Profil ve iletişim',
        /Talep geçmişi/,
        /Aldığı teklifler/,
        /Notlar/,
        'Neler oldu',
      ]);
      await expect(admin.page.getByTestId('customer-fact-offers')).toContainText('1');
    } finally {
      await reader.close();
      await requests.close();
      await admin.close();
    }
  });
});

test.describe('offer and request screens', () => {
  test('an offer names its request and provider without either contact', async ({ browser }) => {
    const { offer, stored, provider, profile, request } = await seedWorld();
    const reader = await openAs(browser, ['OFFERS_READ']);
    const admin = await openAs(browser, 'super');

    try {
      await reader.gotoAdmin(`/offers?requestId=${request.id}`);
      await expectOpen(reader.page);
      await expect(reader.page.locator(`[data-testid="offer-row"][data-offer-id="${offer.id}"]`)).toHaveCount(1);
      await expect(header(reader.page, 'Müşteri')).toHaveCount(0);

      for (const tab of ['', '?tab=talep']) {
        await reader.gotoAdmin(`/offers/${offer.id}${tab}`);
        await expectOpen(reader.page);
        const body = reader.page.locator('main');
        for (const secret of [stored.customerPhone, stored.customerEmail!, stored.customerName, provider.phone, profile.contactName]) {
          await expect(body).not.toContainText(secret);
        }
      }
      await expect(reader.page.getByText(provider.businessName).first()).toBeVisible();

      await admin.gotoAdmin(`/offers/${offer.id}?tab=talep`);
      await expect(admin.page.locator('main')).toContainText(stored.customerPhone);
    } finally {
      await reader.close();
      await admin.close();
    }
  });

  test('a request reads as linked to an account the session cannot open', async ({ browser }) => {
    const { request, account } = await seedWorld();
    const reader = await openAs(browser, ['REQUESTS_READ']);
    const withCustomers = await openAs(browser, ['REQUESTS_READ', 'CUSTOMERS_READ']);

    try {
      await reader.gotoAdmin(`/requests/${request.id}`);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('request-account-linked')).toHaveText('Müşteri hesabına bağlı');
      await expect(reader.page.locator('main')).not.toContainText(account.email!);

      await withCustomers.gotoAdmin(`/requests/${request.id}`);
      await expect(withCustomers.page.getByTestId('request-account-linked')).toHaveCount(0);
      await expect(withCustomers.page.locator('main')).toContainText(account.email!);
    } finally {
      await reader.close();
      await withCustomers.close();
    }
  });
});

/**
 * API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-002: the three gaps -001 left open,
 * through their screens. A campaign redemption's lot balance is the ledger's
 * (FINANCE_LEDGER_READ); a refund's linked ticket content is the support
 * desk's (SUPPORT_READ); a staff actor's e-mail is the staff directory's
 * (ADMIN_USERS_READ). Without the permission the screen draws no figure, no
 * subject and no address — and no error screen; with it, or as SUPER_ADMIN,
 * it draws them as before.
 */
const LEDGER_HEADERS = ['Bakiye', 'Satın alınan kredi', 'Harcanan kredi', 'İade edilen kredi', 'Manuel net', 'Son hareket'];
const LEDGER_SORTS = ['currentBalance', 'totalCreditsPurchased', 'totalCreditsSpent', 'totalCreditsRefunded', 'manualNetCredits', 'lastTransactionAt'];

test.describe('RBAC-002 — lot balance, refund ticket, staff e-mail', () => {
  test('a redemption row shows the lot balance only to a session that may read the ledger', async ({ browser }) => {
    const root = await createAdmin();
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Projeksiyon Kampanya' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const seeded = await seedActiveCampaign(root.id, `e2e-projeksiyon-${uniqueSuffix()}`);
    await seedGrantedLot(seeded, provider.id, 10, 3);

    const reader = await openAs(browser, ['CAMPAIGNS_READ']);
    const ledger = await openAs(browser, ['CAMPAIGNS_READ', 'FINANCE_LEDGER_READ']);
    const admin = await openAs(browser, 'super');
    try {
      const path = `/campaigns/${seeded.campaign.id}`;
      for (const [actor, shown] of [
        [reader, false],
        [ledger, true],
        [admin, true],
      ] as const) {
        await actor.gotoAdmin(path);
        await expectOpen(actor.page);
        const row = actor.page.getByTestId('campaign-redemptions').getByTestId('campaign-redemption-row');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(provider.businessName);
        if (shown) await expect(row).toContainText('kalan 7');
        else await expect(row).not.toContainText('kalan');
      }
    } finally {
      await Promise.all([reader.close(), ledger.close(), admin.close()]);
    }
  });

  test('a refund page shows the linked ticket’s subject only to a session that may read support', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Projeksiyon İade' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const pkg = await createLemonSqueezyCreditPackage({ creditAmount: 10, priceAmount: 10_000 });
    // A refund request needs a purchase carrying purchase-terms evidence (the
    // database refuses one without), written the way the checkout writes it.
    const purchaseId = `pp-e2e-${uniqueSuffix()}`;
    const terms = buildPurchaseTermsSnapshot(PURCHASE_TERMS_DOCUMENT_SET);
    const purchase = await prisma().$transaction(async (tx) => {
      const acceptance = await tx.purchaseTermsAcceptance.create({
        data: {
          purchaseId,
          userId: provider.userId,
          documentKey: PURCHASE_TERMS_DOCUMENT_SET.documentKey,
          documentVersion: PURCHASE_TERMS_DOCUMENT_SET.version,
          documentSha256: sha256Hex(terms),
          documentTextSnapshot: terms,
          sourceChannel: 'WEB',
        },
      });
      return tx.packagePurchase.create({
        data: {
          id: purchaseId,
          providerId: provider.id,
          packageId: pkg.id,
          status: 'PAID',
          creditAmountSnapshot: 10,
          priceAmountSnapshot: 10_000,
          packageNameSnapshot: pkg.name,
          paidAt: new Date(),
          termsAcceptanceRequired: true,
          purchaseTermsAcceptanceId: acceptance.id,
        },
      });
    });
    const subject = `E2E gizli iade konusu ${uniqueSuffix()}`;
    const ticket = await createSupportTicket({ requesterId: provider.userId, requesterRole: 'PROVIDER', status: 'OPEN', subject });
    await prisma().supportTicket.update({ where: { id: ticket.id }, data: { topic: 'PACKAGE_AND_CREDIT_REFUND' } });
    const refund = await prisma().packageRefundRequest.create({
      data: {
        supportTicketId: ticket.id,
        purchaseId: purchase.id,
        providerId: provider.id,
        origin: 'PROVIDER',
        createdById: provider.userId,
        // The shape the eligibility service records at submission.
        submittedEligibility: {
          purchaseId: purchase.id,
          recommendation: 'REFUNDABLE',
          summary: 'Normal iade koşulları sağlanıyor.',
          reasons: [],
          blockingCodes: [],
          evaluatedAt: new Date().toISOString(),
          paidAt: purchase.paidAt?.toISOString() ?? null,
          windowEndsAt: null,
          facts: {
            offerSpendCountSincePaid: 0,
            firstOfferSpendAtSincePaid: null,
            linkedPromoConsumptionCount: 0,
            linkedPromoConsumedCredits: 0,
          },
        },
        submittedRecommendation: 'REFUNDABLE',
      },
    });

    const reader = await openAs(browser, ['PACKAGE_REFUND_READ']);
    const support = await openAs(browser, ['PACKAGE_REFUND_READ', 'SUPPORT_READ']);
    const admin = await openAs(browser, 'super');
    try {
      const path = `/package-refunds/${refund.id}`;

      await reader.gotoAdmin(path);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('package-refund-ticket-hidden')).toBeVisible();
      await expect(reader.page.getByTestId('package-refund-ticket-link')).toHaveCount(0);
      expect(await reader.page.content()).not.toContain(subject);

      for (const actor of [support, admin]) {
        await actor.gotoAdmin(path);
        await expectOpen(actor.page);
        const link = actor.page.getByTestId('package-refund-ticket-link');
        await expect(link).toHaveText(subject);
        await expect(link).toHaveAttribute('href', `/support/${ticket.id}`);
        await expect(actor.page.getByTestId('package-refund-ticket-hidden')).toHaveCount(0);
      }
    } finally {
      await Promise.all([reader.close(), support.close(), admin.close()]);
      // Leave no open ticket behind: the dashboard spec counts open support
      // tickets across the whole database and expects to start from zero.
      const now = new Date();
      await prisma().supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'CLOSED', resolvedAt: now, closedAt: now },
      });
    }
  });

  test('the credit ledger names the operator, and prints the operator’s e-mail only with ADMIN_USERS_READ', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Projeksiyon Defter' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
    const operator = await createStaffAdmin(['FINANCE_LEDGER_READ']);
    const operatorName = `E2E Operatör ${uniqueSuffix()}`;
    await prisma().user.update({ where: { id: operator.id }, data: { name: operatorName } });
    await prisma().providerCreditTransaction.create({
      data: {
        providerId: provider.id,
        type: 'ADMIN_GRANT',
        amount: 5,
        balanceAfter: 5,
        reason: 'E2E telafi',
        createdById: operator.id,
      },
    });

    const reader = await openAs(browser, ['FINANCE_LEDGER_READ']);
    const directory = await openAs(browser, ['FINANCE_LEDGER_READ', 'ADMIN_USERS_READ']);
    const admin = await openAs(browser, 'super');
    try {
      const path = `/finance/credit-ledger?providerId=${provider.id}`;
      for (const [actor, withEmail] of [
        [reader, false],
        [directory, true],
        [admin, true],
      ] as const) {
        await actor.gotoAdmin(path);
        await expectOpen(actor.page);
        const row = actor.page.getByTestId('ledger-row');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(operatorName);
        if (withEmail) await expect(row).toContainText(operator.email);
        else expect(await actor.page.content()).not.toContain(operator.email);
      }
    } finally {
      await Promise.all([reader.close(), directory.close(), admin.close()]);
    }
  });

  test('FINANCE_READ is the aggregate view: no per-provider credit figure, no latest ledger rows; with the ledger the screens are whole', async ({
    browser,
  }) => {
    const location = uniqueLocation();
    const category = await createCategory(2, { namePrefix: 'E2E Projeksiyon Finans' });
    const provider = await createProvider({ categoryId: category.id, location, credits: 23 });

    const reader = await openAs(browser, ['FINANCE_READ']);
    const ledger = await openAs(browser, ['FINANCE_READ', 'FINANCE_LEDGER_READ']);
    const admin = await openAs(browser, 'super');
    try {
      const search = `/finance/providers?q=${encodeURIComponent(provider.businessName)}`;

      await reader.gotoAdmin('/finance');
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('finance-kpi-revenue')).toBeVisible();
      await expect(reader.page.getByRole('heading', { name: 'Son kredi hareketleri' })).toHaveCount(0);
      await expect(reader.page.getByTestId('finance-recent-transactions')).toHaveCount(0);

      await reader.gotoAdmin(search);
      await expectOpen(reader.page);
      await expect(reader.page.getByTestId('provider-finance-row')).toHaveCount(1);
      // Payments stay; every figure read from the provider's credit ledger goes.
      for (const name of ['Toplam ödeme', 'Son ödeme']) await expect(header(reader.page, name)).toBeVisible();
      for (const name of LEDGER_HEADERS) await expect(header(reader.page, name)).toHaveCount(0);
      await expect(reader.page.getByTestId('provider-finance-balance')).toHaveCount(0);
      await expect(reader.page.locator('#provider-finance-sort option')).toHaveText(['İşletme adı', 'Toplam ödeme', 'Son ödeme']);
      // A hand-written ledger sort falls back to the default instead of a 403 screen.
      for (const field of LEDGER_SORTS) {
        await reader.gotoAdmin(`${search}&sortBy=${field}`);
        await expectOpen(reader.page);
        await expect(reader.page.getByTestId('provider-finance-row')).toHaveCount(1);
        await expect(reader.page.locator('#provider-finance-sort')).toHaveValue('lastPaymentAt');
      }

      for (const actor of [ledger, admin]) {
        await actor.gotoAdmin('/finance');
        await expectOpen(actor.page);
        await expect(actor.page.getByRole('heading', { name: 'Son kredi hareketleri' })).toBeVisible();

        await actor.gotoAdmin(`${search}&sortBy=currentBalance`);
        await expectOpen(actor.page);
        for (const name of LEDGER_HEADERS) await expect(header(actor.page, name)).toBeVisible();
        await expect(actor.page.getByTestId('provider-finance-balance')).toHaveText('23');
        await expect(actor.page.locator('#provider-finance-sort option')).toHaveCount(9);
      }
    } finally {
      await Promise.all([reader.close(), ledger.close(), admin.close()]);
    }
  });
});
