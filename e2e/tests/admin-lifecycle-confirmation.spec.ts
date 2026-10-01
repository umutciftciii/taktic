import { expect, test, type Locator, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, confirmThrough, waitForHydration } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createClaimableCustomer,
  createCustomer,
  createProvider,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { seedOffer, seedRequestReport } from '../src/offer-fixtures';
import { emailCountFor } from '../src/outbox';
import { seedCustomerRequest } from '../src/request-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 2, in the browser: the customer,
 * provider and request lifecycle moves that used to go straight through.
 *
 * Each one is driven the way an operator would: the dialog opens with the
 * consequence for the state the record is in, "Vazgeç" writes nothing, and
 * "Evet" does exactly what the button did before. The moves that stay direct
 * (a new request into review, PENDING_REVIEW out of DRAFT) are driven too, so
 * a guard that spread to them would show here. Two of the new confirmations
 * are also clicked before React hydrates: the queued submission reaches the
 * action without a proof and writes nothing.
 */

async function openSuper(browser: Parameters<typeof Actor.open>[0]) {
  const account = await createAdmin();
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return actor;
}

/** Opens the dialog, checks it says what it should, and backs out — nothing may move. */
async function openAndCancel(trigger: Locator, says: Array<string | RegExp>): Promise<Locator> {
  await waitForHydration(trigger);
  await trigger.click();
  const dialog = trigger.page().getByTestId(`${await trigger.getAttribute('data-testid')}-dialog`);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
  for (const text of says) await expect(dialog).toContainText(text);
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(dialog).toBeHidden();
  return dialog;
}

/** Gives a cancelled dialog's (non-)submission time to have done something, if it were going to. */
async function settle(page: Page) {
  await page.waitForTimeout(300);
}

const customerActive = async (id: string) =>
  (await prisma().user.findUniqueOrThrow({ where: { id }, select: { isActive: true } })).isActive;
const providerRow = (id: string) => prisma().providerProfile.findUniqueOrThrow({ where: { id } });
const requestRow = (id: string) => prisma().serviceRequest.findUniqueOrThrow({ where: { id } });

async function seedProvider(status: 'DRAFT' | 'PENDING_REVIEW' | 'REJECTED' | 'SUSPENDED') {
  const category = await createCategory(3);
  const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
  await prisma().providerProfile.update({
    where: { id: provider.id },
    data: {
      status,
      approvedAt: null,
      rejectionReason: status === 'REJECTED' ? 'Faz 2 E2E: belge eksik.' : null,
      rejectedAt: status === 'REJECTED' ? new Date() : null,
    },
  });
  return provider;
}

async function seedRequest(status: 'SUBMITTED' | 'APPROVED') {
  const location = uniqueLocation();
  const category = await createCategory(3);
  const customer = await createCustomer('E2E Faz2 Müşteri');
  const provider = await createProvider({ categoryId: category.id, location, credits: 20 });
  const request = await seedCustomerRequest({
    customerId: customer.id,
    categoryId: category.id,
    location,
    content: 'full',
    status,
    phoneVerifiedAt: new Date(),
  });
  return { request, provider, category, location };
}

test.describe('ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 2', () => {
  test('customer: "Hesabı etkinleştir" asks first; a click before hydration writes nothing', async ({ browser }) => {
    const customer = await createCustomer('E2E Faz2 Pasif Müşteri');
    await prisma().user.update({ where: { id: customer.id }, data: { isActive: false } });
    const admin = await openSuper(browser);
    const page = admin.page;

    try {
      // Before hydration: React replays the queued submission with no proof.
      const trigger = page.getByTestId('customer-activate');
      await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/customers/${customer.id}`, trigger);
      await expect(page.getByTestId('customer-status-error')).toContainText('onay penceresinden onay alınamadı');
      await expect(page.getByTestId('customer-activate-dialog')).toBeHidden();
      expect(await customerActive(customer.id)).toBe(false);

      await admin.gotoAdmin(`/customers/${customer.id}`);
      await openAndCancel(page.getByTestId('customer-activate'), [
        'yeniden giriş yapabilir',
        'Aynı telefon ve e-postayla yeniden yeni talep verebilir',
        'geçmiş değişmez',
      ]);
      await settle(page);
      expect(await customerActive(customer.id)).toBe(false);

      await confirmThrough(page.getByTestId('customer-activate'), 'Evet, etkinleştir');
      await expect(page.getByTestId('customer-status')).toHaveText('Aktif hesap');
      await expect.poll(() => customerActive(customer.id)).toBe(true);
      await assertNoErrorScreen(page);

      // The passivation keeps its own (Faz 1) dialog.
      await confirmThrough(page.getByTestId('customer-passivate'), 'Evet, pasife al');
      await expect.poll(() => customerActive(customer.id)).toBe(false);
    } finally {
      await admin.close();
    }
  });

  test('customer access link: the first goes straight through, a new one asks first', async ({ browser }) => {
    const customer = await createClaimableCustomer('E2E Faz2 Aktivasyon');
    const unused = () =>
      prisma().customerActivationToken.count({ where: { customerId: customer.id, usedAt: null } });
    const admin = await openSuper(browser);
    const page = admin.page;

    try {
      await admin.gotoAdmin(`/customers/${customer.id}`);
      const first = page.getByTestId('customer-activation-issue');
      await waitForHydration(first);
      await expect(first).not.toHaveAttribute('aria-haspopup', 'dialog');
      await first.click();
      const url = page.getByTestId('customer-activation-url');
      await expect(url).toContainText('token=');
      const firstUrl = await url.textContent();
      expect(await unused()).toBe(1);

      const reissue = page.getByTestId('customer-activation-issue');
      await expect(reissue).toHaveText('Yeni bağlantı oluştur');
      await openAndCancel(reissue, ['henüz kullanılmamış', 'hemen geçersiz olur', '72 saat']);
      await settle(page);
      await expect(url).toHaveText(firstUrl!);
      expect(await prisma().customerActivationToken.count({ where: { customerId: customer.id } })).toBe(1);

      await confirmThrough(reissue, 'Evet, yeni bağlantı oluştur');
      await expect(url).not.toHaveText(firstUrl!);
      await expect(url).toContainText('token=');
      expect(await prisma().customerActivationToken.count({ where: { customerId: customer.id } })).toBe(2);
      expect(await unused()).toBe(1);
    } finally {
      await admin.close();
    }
  });

  test('provider: approving from the header asks first, mails once; a click before hydration writes nothing', async ({
    browser,
  }) => {
    const provider = await seedProvider('PENDING_REVIEW');
    const mails = () => emailCountFor(provider.email, 'provider-application-approved');
    const admin = await openSuper(browser);
    const page = admin.page;

    try {
      const trigger = page.getByTestId('provider-approve');
      await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/providers/${provider.id}`, trigger);
      await expect(page.getByTestId('provider-status-error')).toContainText('onay penceresinden onay alınamadı');
      expect((await providerRow(provider.id)).status).toBe('PENDING_REVIEW');
      expect(mails()).toBe(0);

      await admin.gotoAdmin(`/providers/${provider.id}`);
      await openAndCancel(page.getByTestId('provider-approve'), [
        'İncelemedeki başvuru onaylanır',
        'teklif verebilir',
        'vitrin yayınları',
        'e-posta gider',
        'Kampanya motoru',
      ]);
      await settle(page);
      expect((await providerRow(provider.id)).status).toBe('PENDING_REVIEW');

      await confirmThrough(page.getByTestId('provider-approve'), 'Evet, onayla');
      await expect(page.getByTestId('provider-status')).toHaveText('Onaylandı');
      expect((await providerRow(provider.id)).status).toBe('APPROVED');
      await expect.poll(mails).toBe(1);

      // Suspending keeps its Faz 1 dialog; re-activating says it is a second approval.
      await confirmThrough(page.getByTestId('provider-suspend'), 'Evet, askıya al');
      await expect(page.getByTestId('provider-status')).toHaveText('Askıya alındı');
      const reactivate = page.getByTestId('provider-approve');
      await expect(reactivate).toHaveText('Tekrar aktif et');
      await openAndCancel(reactivate, ['Askıya alınmış işletme yeniden onaylı', 'e-posta tekrar gider']);
      await confirmThrough(reactivate, 'Evet, tekrar aktif et');
      await expect(page.getByTestId('provider-status')).toHaveText('Onaylandı');
      await expect.poll(mails).toBe(2);
    } finally {
      await admin.close();
    }
  });

  test('provider status form: DRAFT and APPROVED ask with the text for the state left; PENDING_REVIEW stays direct', async ({
    browser,
  }) => {
    const provider = await seedProvider('REJECTED');
    const admin = await openSuper(browser);
    const page = admin.page;
    const select = page.locator('#provider-status-select');
    const save = page.getByTestId('provider-status-save');

    try {
      // REJECTED → DRAFT: the reason goes, the claim links go.
      await admin.gotoAdmin(`/providers/${provider.id}`);
      await waitForHydration(save);
      await select.selectOption('DRAFT');
      await openAndCancel(save, ['Reddedilmiş başvuru taslağa döner', 'ret gerekçesi silinir', 'sahiplenme (claim)']);
      await settle(page);
      expect((await providerRow(provider.id)).status).toBe('REJECTED');
      await confirmThrough(save, 'Evet, taslağa al');
      await expect(page.getByTestId('provider-status')).toHaveText('Taslak');
      const drafted = await providerRow(provider.id);
      expect(drafted.status).toBe('DRAFT');
      expect(drafted.rejectionReason).toBeNull();

      // DRAFT → PENDING_REVIEW: direct, no dialog.
      await waitForHydration(save);
      await select.selectOption('PENDING_REVIEW');
      await expect(save).not.toHaveAttribute('aria-haspopup', 'dialog');
      await save.click();
      await expect(page.getByTestId('provider-status')).toHaveText('İnceleme bekliyor');
      expect((await providerRow(provider.id)).status).toBe('PENDING_REVIEW');

      // PENDING_REVIEW → DRAFT asks; DRAFT → APPROVED (form) says the review is skipped.
      await waitForHydration(save);
      await select.selectOption('DRAFT');
      await confirmThrough(save, 'Evet, taslağa al');
      await expect(page.getByTestId('provider-status')).toHaveText('Taslak');
      await waitForHydration(save);
      await select.selectOption('APPROVED');
      await openAndCancel(save, ['taslak', 'inceleme adımı atlanarak doğrudan onaylanır']);
      await confirmThrough(save, 'Evet, onayla');
      await expect(page.getByTestId('provider-status')).toHaveText('Onaylandı');
      expect((await providerRow(provider.id)).status).toBe('APPROVED');
    } finally {
      await admin.close();
    }
  });

  test('request: into review is direct, publishing and unpublishing ask; a click before hydration writes nothing', async ({
    browser,
  }) => {
    const { request } = await seedRequest('SUBMITTED');
    const admin = await openSuper(browser);
    const page = admin.page;
    const moves = page.getByTestId('request-moderation-actions');

    try {
      // SUBMITTED → IN_REVIEW: the queue's first step, no dialog.
      await admin.gotoAdmin(`/requests/${request.id}`);
      const intoReview = moves.getByRole('button', { name: 'İncelemeye al' });
      await waitForHydration(intoReview);
      await expect(intoReview).not.toHaveAttribute('aria-haspopup', 'dialog');
      await intoReview.click();
      await expect(page.getByTestId('request-status')).toHaveText('İncelemede');

      // IN_REVIEW → APPROVED clicked before hydration: refused, nothing published.
      await clickBeforeHydration(page, `${primaryRuntime.adminUrl}/requests/${request.id}`, page.getByTestId('request-approve'));
      await expect(page.getByTestId('status-error')).toContainText('onay penceresinden onay alınamadı');
      const refused = await requestRow(request.id);
      expect(refused.status).toBe('IN_REVIEW');
      expect(refused.approvedAt).toBeNull();

      await admin.gotoAdmin(`/requests/${request.id}`);
      await openAndCancel(page.getByTestId('request-approve'), [
        'Talep yayına çıkar',
        '14 günlük yayın süresi',
        'Müşteriye talebinin yayına çıktığı bildirimi gider',
        'eşleşen hizmet verenlere yeni talep bildirimi',
      ]);
      await settle(page);
      expect((await requestRow(request.id)).status).toBe('IN_REVIEW');
      await confirmThrough(page.getByTestId('request-approve'), 'Evet, onayla ve yayınla');
      await expect(page.getByTestId('request-status')).toHaveText('Onaylandı');
      const approved = await requestRow(request.id);
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedAt).not.toBeNull();

      // APPROVED → IN_REVIEW: unpublishing asks.
      await openAndCancel(page.getByTestId('request-unpublish'), [
        'geçici olarak yayından kalkar',
        'Açık teklifler kapanmaz',
        'yayın süresi baştan başlar',
        'yeniden yayın e-postası gidebilir',
      ]);
      await settle(page);
      expect((await requestRow(request.id)).status).toBe('APPROVED');
      await confirmThrough(page.getByTestId('request-unpublish'), 'Evet, incelemeye al');
      await expect(page.getByTestId('request-status')).toHaveText('İncelemede');
      expect((await requestRow(request.id)).status).toBe('IN_REVIEW');
      await assertNoErrorScreen(page);
    } finally {
      await admin.close();
    }
  });

  test('request: "Hizmeti tamamlandı işaretle" asks and says it is final', async ({ browser }) => {
    const { request, provider } = await seedRequest('APPROVED');
    const offer = await seedOffer({ requestId: request.id, providerId: provider.id, status: 'ACCEPTED' });
    await prisma().serviceRequest.update({
      where: { id: request.id },
      data: { status: 'MATCHED', matchedOfferId: offer.id, matchedAt: new Date() },
    });
    const admin = await openSuper(browser);
    const page = admin.page;

    try {
      await admin.gotoAdmin(`/requests/${request.id}`);
      await openAndCancel(page.getByTestId('request-complete'), [
        'Tamamlandı',
        'değerlendirme',
        'kapanış durumudur',
        'geri alınamaz',
      ]);
      await settle(page);
      expect((await requestRow(request.id)).status).toBe('MATCHED');

      await confirmThrough(page.getByTestId('request-complete'), 'Evet, tamamlandı işaretle');
      await expect(page.getByTestId('request-status')).toHaveText('Tamamlandı');
      const completed = await requestRow(request.id);
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();
    } finally {
      await admin.close();
    }
  });

  test('reports: "Uygun bulundu" asks and leaves the request alone; "Talebi geri aç" asks and republishes', async ({
    browser,
  }) => {
    // An open report on a live request: dismissed.
    const dismissed = await seedRequest('APPROVED');
    const reporter = await createProvider({
      categoryId: dismissed.category.id,
      location: dismissed.location,
      credits: 0,
    });
    await seedRequestReport({ requestId: dismissed.request.id, reporterProviderId: reporter.id });

    // A request a report removed: reopened.
    const removed = await seedRequest('APPROVED');
    const oldApprovedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const report = await seedRequestReport({ requestId: removed.request.id, reporterProviderId: removed.provider.id });
    await prisma().serviceRequestReport.update({
      where: { id: report.id },
      data: { resolvedAt: new Date(), resolution: 'REQUEST_REMOVED' },
    });
    await prisma().serviceRequest.update({
      where: { id: removed.request.id },
      data: { status: 'REJECTED', rejectionReason: 'Bildirim sonucu kaldırıldı.', approvedAt: oldApprovedAt },
    });

    const admin = await openSuper(browser);
    const page = admin.page;
    const openReports = async (requestId: string) =>
      prisma().serviceRequestReport.count({ where: { requestId, resolvedAt: null } });

    try {
      await admin.gotoAdmin(`/requests/${dismissed.request.id}?tab=sikayet`);
      await openAndCancel(page.getByTestId('report-dismiss'), [
        'Açık bildirim “Uygun bulundu” kararıyla kapanır',
        'yeniden açan bir işlem yok',
        'kimseye e-posta gönderilmez',
      ]);
      await settle(page);
      expect(await openReports(dismissed.request.id)).toBe(1);
      await confirmThrough(page.getByTestId('report-dismiss'), 'Evet, uygun bulundu');
      await expect(page.getByTestId('report-decisions')).toHaveCount(0);
      expect(await openReports(dismissed.request.id)).toBe(0);
      expect((await requestRow(dismissed.request.id)).status).toBe('APPROVED');

      await admin.gotoAdmin(`/requests/${removed.request.id}?tab=sikayet`);
      await openAndCancel(page.getByTestId('report-reopen'), [
        'yeniden yayına çıkar',
        'yayın süresi baştan başlar',
        'kapatılan teklifler geri açılmaz',
        'kredi iadeleri geri alınmaz',
        'yeniden yayına çıktığı bildirimi',
      ]);
      await settle(page);
      expect((await requestRow(removed.request.id)).status).toBe('REJECTED');
      await confirmThrough(page.getByTestId('report-reopen'), 'Evet, geri aç');
      await expect(page.getByTestId('request-status')).toHaveText('Onaylandı');
      const reopened = await requestRow(removed.request.id);
      expect(reopened.status).toBe('APPROVED');
      expect(reopened.rejectionReason).toBeNull();
      expect(reopened.approvedAt!.getTime()).toBeGreaterThan(oldApprovedAt.getTime());
    } finally {
      await admin.close();
    }
  });
});
