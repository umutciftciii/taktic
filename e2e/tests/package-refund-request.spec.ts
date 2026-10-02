import { expect, test, type Browser } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { clickBeforeHydration, confirmThrough } from '../src/confirm-dialog';
import { createCategory, createProvider, createStaffAdmin, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime, purchaseTermsRuntime, type Runtime } from '../src/runtime';

/**
 * CMP-006 PR-B — a package refund request, from the provider's support form
 * to the operator's decision, on real screens.
 *
 * The purchase-terms runtime has the release gate open (PURCHASE_TERMS_GATE=
 * test since PR-B.1: the TEST document set), so a package bought there
 * carries acceptance evidence — bought through the real consent box and
 * the in-app mock checkout, never a payment provider. Its payment is then
 * marked settled in the database: the settlement webhook itself is covered by
 * the API suite, and nothing here talks to Lemon Squeezy. The primary runtime
 * keeps the gate closed and shows the form exactly as it was.
 *
 * What the screens must never show — the acceptance's address, user agent or
 * text — is asserted on the operator's pages, which are the only ones that
 * could have carried it.
 */

/*
 * DASHBOARD_READ so the panel's landing page after sign-in is the dashboard
 * itself: without it, `/` redirects to `/yetkisiz`, and on WebKit that second
 * navigation races the test's own next `goto` (seen in CI).
 */
const REFUND_PERMISSIONS = [
  'DASHBOARD_READ',
  'SUPPORT_READ',
  'PACKAGE_REFUND_READ',
  'PACKAGE_REFUND_REQUEST_CREATE',
  'PACKAGE_REFUND_APPROVE',
];

/*
 * The topic radios are visually hidden inside their labels (`.radio`), so the
 * label text is what a person — and this suite — clicks.
 */

/** Signs in and waits until the panel has settled on its landing page. */
async function signInStaff(actor: Actor, staff: { email: string; password: string }) {
  await actor.loginToAdmin(staff.email, staff.password);
  await expect(actor.page.locator('#admin-sidebar')).toBeVisible();
  await actor.page.waitForLoadState('load');
}

/** A provider who bought one package with the consent box ticked, now paid. */
async function providerWithPaidPurchase(browser: Browser, runtime: Runtime, label: string) {
  const category = await createCategory(3);
  const seeded = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
  const name = `E2E İade Paketi ${label} ${Date.now()}`;
  await prisma().offerCreditPackage.create({
    data: {
      name,
      slug: `e2e-iade-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      creditAmount: 15,
      priceAmount: 29900,
      currency: 'TRY',
      isActive: true,
      sortOrder: 99,
    },
  });

  const provider = await Actor.open(browser, 'provider', runtime);
  await provider.loginToWeb(seeded.email, seeded.password);
  await provider.gotoWeb(`/providers/${seeded.id}/credits`);
  const card = provider.page.locator('article.pkg-card').filter({ hasText: name });
  const box = card.getByRole('checkbox');
  if ((await box.count()) > 0) {
    await box.check();
  }
  await card.getByRole('button', { name: 'Test Ödemesiyle Paket Al' }).click();
  await expect(provider.page).toHaveURL(/\/package-purchases\/[^/]+\/checkout$/);

  const pending = await prisma().packagePurchase.findFirstOrThrow({ where: { providerId: seeded.id } });
  const purchase = await prisma().packagePurchase.update({
    where: { id: pending.id },
    data: { status: 'PAID', paidAt: new Date(Date.now() - 60_000) },
  });
  return { provider, seeded, purchase, packageName: name };
}

test.describe('package refund request', () => {
  test('provider opens it from the purchase page; an operator takes and approves it; nobody can mark it refunded', async ({
    browser,
    browserName,
  }) => {
    const { provider, seeded, purchase, packageName } = await providerWithPaidPurchase(
      browser,
      purchaseTermsRuntime,
      browserName,
    );
    const staff = await createStaffAdmin(REFUND_PERMISSIONS);
    const second = await createStaffAdmin(REFUND_PERMISSIONS);
    const admin = await Actor.open(browser, 'staff', purchaseTermsRuntime);
    const checker = await Actor.open(browser, 'staff', purchaseTermsRuntime);

    try {
      expect(purchase.termsAcceptanceRequired).toBe(true);

      // PR-B.1: Paket geçmişi → the purchase's page → "İade talebi oluştur".
      await provider.gotoWeb(`/providers/${seeded.id}/package-purchases`);
      await assertNoErrorScreen(provider.page);
      await provider.gotoWeb(`/providers/${seeded.id}/package-purchases/${purchase.id}`);
      await assertNoErrorScreen(provider.page);
      const cta = provider.page.getByTestId('purchase-refund-cta');
      await expect(cta).toHaveText('İade talebi oluştur');
      await cta.click();
      await expect(provider.page).toHaveURL(
        new RegExp(`/destek/yeni\\?type=PACKAGE_REFUND&purchaseId=${purchase.id}$`),
      );

      // The support form arrives on the refund type with this package chosen,
      // the subject fixed by the server, and the test-environment warning.
      await expect(provider.page.getByTestId('support-topic-refund')).toBeChecked();
      await expect(provider.page.getByTestId('refund-test-environment')).toContainText(
        'Test ortamı — üretim sözleşmesi değildir.',
      );
      const option = provider.page.getByTestId('refund-purchase-option').filter({ hasText: packageName });
      await expect(option.locator('input[type="radio"]')).toBeChecked();
      await expect(provider.page.getByTestId('refund-fixed-subject-text')).toContainText(
        `Paket ve kredi iadesi: ${packageName}`,
      );
      await expect(provider.page.getByTestId('support-subject-input')).toHaveCount(0);
      await provider.page.getByTestId('support-message-input').fill('Paketi yanlışlıkla aldım, kullanmadım.');
      await provider.page.getByRole('button', { name: 'İade talebini gönder' }).click();

      await expect(provider.page).toHaveURL(/\/destek\/[^/?]+\?created=refund$/);
      await expect(provider.page.getByTestId('refund-created-notice')).toHaveText(
        'Talep gönderildi; ödeme iadesi onaylanırsa ödeme sağlayıcısı üzerinden işlenir.',
      );
      await expect(provider.page.getByTestId('refund-status')).toHaveAttribute('data-status', 'SUBMITTED');
      await expect(provider.page.getByTestId('refund-withdraw')).toBeVisible();
      const ticketPath = new URL(provider.page.url()).pathname;

      const refund = await prisma().packageRefundRequest.findFirstOrThrow({ where: { purchaseId: purchase.id } });
      const ticket = await prisma().supportTicket.findUniqueOrThrow({ where: { id: refund.supportTicketId } });
      expect(ticket.subject).toContain(packageName);

      // With a request open, the purchase page no longer offers another one.
      await provider.gotoWeb(`/providers/${seeded.id}/package-purchases/${purchase.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('purchase-status')).toBeVisible();
      await expect(provider.page.getByTestId('purchase-refund-cta')).toHaveCount(0);
      await provider.gotoWeb(ticketPath);
      const acceptance = await prisma().purchaseTermsAcceptance.findUniqueOrThrow({ where: { purchaseId: purchase.id } });

      // The operator's queue and detail.
      await signInStaff(admin, staff);
      await admin.gotoAdmin('/package-refunds');
      await expect(admin.page.locator('#admin-sidebar').getByRole('link', { name: 'Paket iadeleri' })).toBeVisible();
      const row = admin.page.getByTestId('package-refund-row').filter({ hasText: seeded.businessName });
      await expect(row).toHaveAttribute('data-status', 'SUBMITTED');
      await row.getByRole('link', { name: /^Aç:/ }).click();
      await expect(admin.page).toHaveURL(new RegExp(`/package-refunds/${refund.id}$`));
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('package-refund-current-eligibility')).toHaveAttribute(
        'data-recommendation',
        'REFUNDABLE',
      );
      await expect(admin.page.getByTestId('package-refund-evidence')).toContainText(acceptance.documentVersion);

      // Paket A: taking it into review asks first — a click before hydration
      // carries no proof and changes nothing; the dialog says a mail goes out
      // and no money moves.
      const detailUrl = admin.page.url();
      await clickBeforeHydration(admin.page, detailUrl, admin.page.getByTestId('package-refund-take'));
      await expect(admin.page).toHaveURL(/error=/);
      expect((await prisma().packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('SUBMITTED');
      await admin.gotoAdmin(`/package-refunds/${refund.id}`);
      await confirmThrough(admin.page.getByTestId('package-refund-take'), 'Evet, işleme al', async (takeDialog) => {
        await expect(takeDialog).toContainText('e-posta gider');
        await expect(takeDialog).toContainText('Para ya da kredi hareket etmez');
      });
      await expect(admin.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'UNDER_REVIEW');
      // Maker ≠ checker for a normal approval too: the taker has no approve
      // button and is told why; a reject is still theirs.
      await expect(admin.page.getByTestId('package-refund-maker-checker')).toBeVisible();
      await expect(admin.page.getByTestId('package-refund-approve-normal')).toHaveCount(0);
      await expect(admin.page.getByTestId('package-refund-reject-form')).toBeVisible();

      // A second operator approves. Faz 3D: the approval asks first. Closing
      // the dialog writes nothing; confirming sends the approval exactly once.
      await signInStaff(checker, second);
      await checker.gotoAdmin(`/package-refunds/${refund.id}`);
      await assertNoErrorScreen(checker.page);
      await expect(checker.page.getByTestId('package-refund-maker-checker')).toHaveCount(0);
      await checker.page.getByTestId('package-refund-approve-normal').click();
      const approveDialog = checker.page.getByTestId('package-refund-approve-normal-dialog');
      await expect(approveDialog).toBeVisible();
      await expect(approveDialog).toContainText('para ya da kredi hareket etmez');
      await approveDialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(approveDialog).toBeHidden();
      await checker.page.getByTestId('package-refund-approve-normal').click();
      await checker.page.keyboard.press('Escape');
      await expect(approveDialog).toBeHidden();
      expect((await prisma().packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'UNDER_REVIEW',
      );
      await checker.page.getByTestId('package-refund-approve-normal').click();
      await approveDialog.getByRole('button', { name: 'Evet, iadeyi onayla' }).click();
      await expect(checker.page.getByTestId('package-refund-status')).toHaveAttribute(
        'data-status',
        'APPROVED_PENDING_SETTLEMENT',
      );
      await admin.gotoAdmin(`/package-refunds/${refund.id}`);
      await expect(admin.page.getByTestId('package-refund-status')).toHaveAttribute(
        'data-status',
        'APPROVED_PENDING_SETTLEMENT',
      );
      await expect(admin.page.getByTestId('package-refund-settlement-hint')).toBeVisible();
      // No "refund completed" control exists, for anyone.
      await expect(admin.page.getByRole('button', { name: /tamamlandı olarak|iade tamamlandı|ödendi/i })).toHaveCount(0);
      await expect(admin.page.getByTestId('package-refund-audit-entry')).toHaveCount(3);

      const html = await admin.page.content();
      expect(html).not.toContain(acceptance.userAgent ?? '∅');
      expect(html).not.toContain(acceptance.documentSha256);
      // The loopback address of a local stack also appears in ordinary URLs; a
      // routable one would be a leak.
      if (acceptance.clientIp && !/^(127\.|::1|::ffff:127\.)/.test(acceptance.clientIp)) {
        expect(html).not.toContain(acceptance.clientIp);
      }

      // The ticket links both ways.
      await admin.page.getByTestId('package-refund-ticket-link').click();
      await expect(admin.page.getByTestId('support-refund-link')).toBeVisible();
      await expect(admin.page.getByTestId('support-refund-event')).toHaveCount(3);

      // The provider sees the decision, and can no longer withdraw.
      await provider.page.reload();
      await expect(provider.page.getByTestId('refund-status')).toHaveAttribute(
        'data-status',
        'APPROVED_PENDING_SETTLEMENT',
      );
      await expect(provider.page.getByTestId('refund-withdraw')).toHaveCount(0);
      await expect(provider.page.getByTestId('support-refund-event')).toHaveCount(3);
    } finally {
      await provider.close();
      await admin.close();
      await checker.close();
    }
  });

  test('provider chooses the refund type and the package on the plain support form, then withdraws', async ({
    browser,
    browserName,
  }) => {
    const { provider, purchase, packageName } = await providerWithPaidPurchase(
      browser,
      purchaseTermsRuntime,
      `geri-${browserName}`,
    );
    try {
      await provider.gotoWeb('/destek/yeni');
      await expect(provider.page.getByTestId('support-topic-general')).toBeChecked();
      await provider.page.getByTestId('support-topic').getByText('Paket ve kredi iadesi', { exact: true }).click();
      // Only the provider's own requestable purchases are listed, none chosen yet.
      await expect(provider.page.getByTestId('refund-purchase-option')).toHaveCount(1);
      await expect(provider.page.getByTestId('refund-fixed-subject-text')).toContainText('Paket seçtiğinizde');
      await provider.page.getByTestId('refund-purchase-option').filter({ hasText: packageName }).click();
      await expect(provider.page.getByTestId('refund-fixed-subject-text')).toContainText(packageName);
      await provider.page.getByTestId('support-message-input').fill('Vazgeçmeden önce açıyorum.');
      await provider.page.getByRole('button', { name: 'İade talebini gönder' }).click();
      await expect(provider.page).toHaveURL(/\?created=refund$/);

      await provider.page.getByTestId('refund-withdraw').click();
      await expect(provider.page.getByTestId('refund-withdrawn-notice')).toBeVisible();
      await expect(provider.page.getByTestId('refund-status')).toHaveAttribute('data-status', 'WITHDRAWN');
      const refund = await prisma().packageRefundRequest.findFirstOrThrow({ where: { purchaseId: purchase.id } });
      expect(refund.status).toBe('WITHDRAWN');
    } finally {
      await provider.close();
    }
  });

  test('an exception is opened on the provider’s general ticket and needs a second operator', async ({
    browser,
    browserName,
  }) => {
    const { provider, seeded, purchase } = await providerWithPaidPurchase(
      browser,
      purchaseTermsRuntime,
      `istisna-${browserName}`,
    );
    // A spend after payment: the normal rule no longer holds.
    await prisma().providerCreditTransaction.create({
      data: { providerId: seeded.id, type: 'OFFER_SPEND', amount: -1, balanceAfter: 0 },
    });

    const maker = await createStaffAdmin(REFUND_PERMISSIONS);
    const checker = await createStaffAdmin(REFUND_PERMISSIONS);
    const makerActor = await Actor.open(browser, 'staff', purchaseTermsRuntime);
    const checkerActor = await Actor.open(browser, 'staff', purchaseTermsRuntime);

    try {
      // Nothing is requestable any more: no button on the purchase, no refund
      // type on the form — the provider writes on general support instead.
      await provider.gotoWeb(`/providers/${seeded.id}/package-purchases/${purchase.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('purchase-status')).toBeVisible();
      await expect(provider.page.getByTestId('purchase-refund-cta')).toHaveCount(0);
      await provider.gotoWeb(`/destek/yeni?type=PACKAGE_REFUND&purchaseId=${purchase.id}`);
      await expect(provider.page.getByTestId('support-new-form')).toBeVisible();
      await expect(provider.page.getByTestId('support-topic')).toHaveCount(0);
      await provider.page.getByTestId('support-subject-input').fill('Çift çekim');
      await provider.page.getByTestId('support-message-input').fill('Kartımdan iki kez çekildi, bir teklif de gönderdim.');
      await provider.page.getByRole('button', { name: 'Destek talebi oluştur' }).click();
      await expect(provider.page).toHaveURL(/\/destek\/[^/?]+\?created=1$/);
      const ticketId = new URL(provider.page.url()).pathname.split('/').pop()!;

      // The maker opens and takes the request from the ticket screen.
      await signInStaff(makerActor, maker);
      await makerActor.gotoAdmin(`/support/${ticketId}`);
      await makerActor.page.locator('#support-refund-purchase').selectOption(purchase.id);
      await makerActor.page.getByTestId('support-refund-open').click();
      await expect(makerActor.page).toHaveURL(/\/package-refunds\/[^/?]+\?done=created$/);
      await confirmThrough(makerActor.page.getByTestId('package-refund-take'), 'Evet, işleme al');
      await expect(makerActor.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'UNDER_REVIEW');
      await expect(makerActor.page.getByTestId('package-refund-maker-checker')).toBeVisible();
      await expect(makerActor.page.getByTestId('package-refund-exception-form')).toHaveCount(0);
      await expect(makerActor.page.getByTestId('package-refund-approve-normal')).toHaveCount(0);
      // allowedActions still lets the maker refuse it — the rule is about approving.
      await expect(makerActor.page.getByTestId('package-refund-reject-form')).toBeVisible();
      const detailPath = new URL(makerActor.page.url()).pathname;

      // The checker approves it as an exception, with a ground and a reason.
      await signInStaff(checkerActor, checker);
      await checkerActor.gotoAdmin(detailPath);
      const form = checkerActor.page.getByTestId('package-refund-exception-form');
      await form.locator('select[name="exceptionGround"]').selectOption('DUPLICATE_CHARGE');
      await form.locator('textarea[name="exceptionReason"]').fill('Aynı sipariş iki kez tahsil edilmiş.');
      await checkerActor.page.getByTestId('package-refund-approve-exception').click();
      await checkerActor.page
        .getByTestId('package-refund-approve-exception-dialog')
        .getByRole('button', { name: 'Evet, istisna olarak onayla' })
        .click();
      await expect(checkerActor.page.getByTestId('package-refund-status')).toHaveAttribute(
        'data-status',
        'APPROVED_PENDING_SETTLEMENT',
      );
      await expect(checkerActor.page.getByTestId('package-refund-approval')).toContainText('İstisna');

      const refund = await prisma().packageRefundRequest.findFirstOrThrow({ where: { purchaseId: purchase.id } });
      expect(refund).toMatchObject({ approvalKind: 'EXCEPTION', exceptionGround: 'DUPLICATE_CHARGE', origin: 'ADMIN' });
      expect(refund.approvedById).not.toBe(refund.reviewStartedById);

      // Faz 3D: recording that the external refund did not happen asks first.
      // × writes nothing; confirming writes SETTLEMENT_FAILED once, and there
      // is still no way to mark the refund completed.
      const failed = checkerActor.page.getByTestId('package-refund-failed-form');
      await failed.locator('textarea[name="reason"]').fill('Sağlayıcı panelinde iade başarısız oldu.');
      const failedDialog = checkerActor.page.getByTestId('package-refund-mark-failed-dialog');
      await checkerActor.page.getByTestId('package-refund-mark-failed').click();
      await expect(failedDialog).toContainText('Para ve kredi hareket etmez');
      await failedDialog.getByRole('button', { name: 'Kapat' }).click();
      await expect(failedDialog).toBeHidden();
      expect((await prisma().packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'APPROVED_PENDING_SETTLEMENT',
      );
      await checkerActor.page.getByTestId('package-refund-mark-failed').click();
      await failedDialog.getByRole('button', { name: 'Evet, tamamlanamadı olarak kaydet' }).click();
      await expect(checkerActor.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'SETTLEMENT_FAILED');
      await expect(checkerActor.page.getByTestId('package-refund-failed-hint')).toBeVisible();
      await expect(checkerActor.page.getByTestId('package-refund-no-actions')).toBeVisible();
      expect(
        await prisma().packageRefundRequestEvent.count({ where: { requestId: refund.id, action: 'SETTLEMENT_FAILED' } }),
      ).toBe(1);
    } finally {
      await provider.close();
      await makerActor.close();
      await checkerActor.close();
    }
  });

  test('an operator rejects a request only after the dialog; a read-only operator sees no control', async ({
    browser,
    browserName,
  }) => {
    const { provider, purchase, packageName } = await providerWithPaidPurchase(
      browser,
      purchaseTermsRuntime,
      `ret-${browserName}`,
    );
    const operator = await createStaffAdmin(REFUND_PERMISSIONS);
    const viewer = await createStaffAdmin(['DASHBOARD_READ', 'PACKAGE_REFUND_READ']);
    const operatorActor = await Actor.open(browser, 'staff', purchaseTermsRuntime);
    const viewerActor = await Actor.open(browser, 'staff', purchaseTermsRuntime);

    try {
      await provider.gotoWeb('/destek/yeni');
      await provider.page.getByTestId('support-topic').getByText('Paket ve kredi iadesi', { exact: true }).click();
      await provider.page.getByTestId('refund-purchase-option').filter({ hasText: packageName }).click();
      await provider.page.getByTestId('support-message-input').fill('Paketi kullanmadım, iade istiyorum.');
      await provider.page.getByRole('button', { name: 'İade talebini gönder' }).click();
      await expect(provider.page).toHaveURL(/\?created=refund$/);
      const refund = await prisma().packageRefundRequest.findFirstOrThrow({ where: { purchaseId: purchase.id } });
      const detailPath = `/package-refunds/${refund.id}`;

      // A read-only viewer: the request, and not one control — allowedActions is all false for them.
      await signInStaff(viewerActor, viewer);
      await viewerActor.gotoAdmin(detailPath);
      await assertNoErrorScreen(viewerActor.page);
      await expect(viewerActor.page.getByTestId('package-refund-no-actions')).toBeVisible();
      for (const testId of [
        'package-refund-take',
        'package-refund-approve-normal',
        'package-refund-approve-exception',
        'package-refund-reject',
        'package-refund-mark-failed',
      ]) {
        await expect(viewerActor.page.getByTestId(testId), testId).toHaveCount(0);
      }

      await signInStaff(operatorActor, operator);
      await operatorActor.gotoAdmin(detailPath);
      await confirmThrough(operatorActor.page.getByTestId('package-refund-take'), 'Evet, işleme al');
      await expect(operatorActor.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'UNDER_REVIEW');

      // The dialog opens only once the form is valid: an empty reason is the
      // browser's to report, and nothing is asked or sent.
      const dialog = operatorActor.page.getByTestId('package-refund-reject-dialog');
      await operatorActor.page.getByTestId('package-refund-reject').click();
      await expect(dialog).toBeHidden();

      await operatorActor.page.locator('#reject-reason').fill('Paket kullanıldı; iade koşulları sağlanmıyor.');
      await operatorActor.page.getByTestId('package-refund-reject').click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('hizmet verene gösterilmez');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      expect((await prisma().packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'UNDER_REVIEW',
      );

      await operatorActor.page.getByTestId('package-refund-reject').click();
      await dialog.getByRole('button', { name: 'Evet, isteği reddet' }).click();
      await expect(operatorActor.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'REJECTED');
      await expect(operatorActor.page.getByTestId('package-refund-done')).toHaveText('İstek reddedildi.');
      await expect(operatorActor.page.getByTestId('package-refund-no-actions')).toBeVisible();
      const rejected = await prisma().packageRefundRequest.findUniqueOrThrow({ where: { id: refund.id } });
      expect(rejected.rejectionReason).toBe('Paket kullanıldı; iade koşulları sağlanmıyor.');
      expect(
        await prisma().packageRefundRequestEvent.count({ where: { requestId: refund.id, action: 'REJECTED' } }),
      ).toBe(1);

      // The queue and the request at every width the panel supports: the page
      // itself never scrolls sideways; the queue's table does, in its own box.
      for (const width of [1440, 1280, 1024, 768, 390, 320]) {
        await operatorActor.page.setViewportSize({ width, height: 900 });
        for (const path of ['/package-refunds', detailPath]) {
          await operatorActor.gotoAdmin(path);
          await assertNoErrorScreen(operatorActor.page);
          const overflow = await operatorActor.page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${path} @${width}`).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      await provider.close();
      await operatorActor.close();
      await viewerActor.close();
    }
  });

  test('gate closed: no button on the purchase, and the support form is the general one', async ({
    browser,
    browserName,
  }) => {
    const { provider, seeded, purchase } = await providerWithPaidPurchase(browser, primaryRuntime, `kapali-${browserName}`);
    try {
      await provider.gotoWeb(`/providers/${seeded.id}/package-purchases/${purchase.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('purchase-status')).toBeVisible();
      await expect(provider.page.getByTestId('purchase-refund-card')).toHaveCount(0);
      await expect(provider.page.getByText('İade talebi oluştur')).toHaveCount(0);

      await provider.gotoWeb(`/destek/yeni?type=PACKAGE_REFUND&purchaseId=${purchase.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('support-new-form')).toBeVisible();
      await expect(provider.page.getByTestId('support-topic')).toHaveCount(0);
      await expect(provider.page.getByText('Paket ve kredi iadesi')).toHaveCount(0);
      await expect(provider.page.getByTestId('support-subject-input')).toBeVisible();
    } finally {
      await provider.close();
    }
  });

  test('a spoofed purchase id in the query neither leaks the purchase nor opens anything', async ({
    browser,
    browserName,
  }) => {
    const victim = await providerWithPaidPurchase(browser, purchaseTermsRuntime, `kurban-${browserName}`);
    const attacker = await providerWithPaidPurchase(browser, purchaseTermsRuntime, `saldirgan-${browserName}`);
    try {
      const before = {
        tickets: await prisma().supportTicket.count(),
        requests: await prisma().packageRefundRequest.count(),
      };

      // The attacker's own form, with the victim's purchase in the query.
      await attacker.provider.gotoWeb(`/destek/yeni?type=PACKAGE_REFUND&purchaseId=${victim.purchase.id}`);
      await assertNoErrorScreen(attacker.provider.page);
      await expect(attacker.provider.page.getByTestId('support-topic-refund')).toBeChecked();
      await expect(attacker.provider.page.getByTestId('refund-purchase-option')).toHaveCount(1);
      await expect(
        attacker.provider.page.getByTestId('refund-purchase-option').locator('input[type="radio"]'),
      ).not.toBeChecked();
      // The id itself is echoed by Next's router state (it is the attacker's own
      // URL); what must not appear is anything the attacker did not already know.
      const html = await attacker.provider.page.content();
      expect(html).not.toContain(victim.packageName);
      expect(html).not.toContain(victim.purchase.purchaseNumber ?? '∅');
      await expect(attacker.provider.page.locator(`input[value="${victim.purchase.id}"]`)).toHaveCount(0);
      expect(await attacker.provider.page.locator('body').innerText()).not.toContain(victim.purchase.id);
      await expect(attacker.provider.page.getByTestId('support-submit')).toBeDisabled();

      // Nor does the victim's purchase page open for them.
      await attacker.provider.gotoWeb(`/providers/${victim.seeded.id}/package-purchases/${victim.purchase.id}`);
      expect(await attacker.provider.page.content()).not.toContain(victim.packageName);
      await expect(attacker.provider.page.getByTestId('purchase-refund-cta')).toHaveCount(0);

      expect(await prisma().supportTicket.count()).toBe(before.tickets);
      expect(await prisma().packageRefundRequest.count()).toBe(before.requests);
    } finally {
      await victim.provider.close();
      await attacker.provider.close();
    }
  });
});
