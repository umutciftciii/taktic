import { expect, test, type Browser } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { createCategory, createProvider, createStaffAdmin, prisma, uniqueLocation } from '../src/fixtures';
import { primaryRuntime, purchaseTermsRuntime, type Runtime } from '../src/runtime';

/**
 * CMP-006 PR-B — a package refund request, from the provider's support form
 * to the operator's decision, on real screens.
 *
 * The purchase-terms runtime has the release gate open, so a package bought
 * there carries acceptance evidence — bought through the real consent box and
 * the in-app mock checkout, never a payment provider. Its payment is then
 * marked settled in the database: the settlement webhook itself is covered by
 * the API suite, and nothing here talks to Lemon Squeezy. The primary runtime
 * keeps the gate closed and shows the form exactly as it was.
 *
 * What the screens must never show — the acceptance's address, user agent or
 * text — is asserted on the operator's pages, which are the only ones that
 * could have carried it.
 */

const REFUND_PERMISSIONS = [
  'SUPPORT_READ',
  'PACKAGE_REFUND_READ',
  'PACKAGE_REFUND_REQUEST_CREATE',
  'PACKAGE_REFUND_APPROVE',
];

/*
 * The topic radios are visually hidden inside their labels (`.radio`), so the
 * label text is what a person — and this suite — clicks.
 */

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
  test('provider opens it from support; an operator takes and approves it; nobody can mark it refunded', async ({
    browser,
    browserName,
  }) => {
    const { provider, seeded, purchase, packageName } = await providerWithPaidPurchase(
      browser,
      purchaseTermsRuntime,
      browserName,
    );
    const staff = await createStaffAdmin(REFUND_PERMISSIONS);
    const admin = await Actor.open(browser, 'staff', purchaseTermsRuntime);

    try {
      expect(purchase.termsAcceptanceRequired).toBe(true);

      // The provider's form: the topic, then the picker with their package.
      await provider.gotoWeb('/destek/yeni');
      await assertNoErrorScreen(provider.page);
      await provider.page.getByTestId('support-topic').getByText('Paket ve kredi iadesi', { exact: true }).click();
      const option = provider.page.getByTestId('refund-purchase-option').filter({ hasText: packageName });
      await expect(option).toHaveAttribute('data-selectable', 'true');
      await option.click();
      await provider.page.getByTestId('support-message-input').fill('Paketi yanlışlıkla aldım, kullanmadım.');
      await provider.page.getByRole('button', { name: 'İade talebini gönder' }).click();

      await expect(provider.page).toHaveURL(/\/destek\/[^/?]+\?created=refund$/);
      await expect(provider.page.getByTestId('refund-created-notice')).toHaveText(
        'Talep gönderildi; ödeme iadesi onaylanırsa ödeme sağlayıcısı üzerinden işlenir.',
      );
      await expect(provider.page.getByTestId('refund-status')).toHaveAttribute('data-status', 'SUBMITTED');
      await expect(provider.page.getByTestId('refund-withdraw')).toBeVisible();

      const refund = await prisma().packageRefundRequest.findFirstOrThrow({ where: { purchaseId: purchase.id } });
      const acceptance = await prisma().purchaseTermsAcceptance.findUniqueOrThrow({ where: { purchaseId: purchase.id } });

      // The operator's queue and detail.
      await admin.loginToAdmin(staff.email, staff.password);
      await admin.gotoAdmin('/package-refunds');
      await expect(admin.page.locator('#admin-sidebar').getByRole('link', { name: 'Paket İadeleri' })).toBeVisible();
      const row = admin.page.getByTestId('package-refund-row').filter({ hasText: seeded.businessName });
      await expect(row).toHaveAttribute('data-status', 'SUBMITTED');
      await row.getByRole('link', { name: 'Detay' }).click();
      await expect(admin.page).toHaveURL(new RegExp(`/package-refunds/${refund.id}$`));
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('package-refund-current-eligibility')).toHaveAttribute(
        'data-recommendation',
        'REFUNDABLE',
      );
      await expect(admin.page.getByTestId('package-refund-evidence')).toContainText(acceptance.documentVersion);

      await admin.page.getByTestId('package-refund-take').click();
      await expect(admin.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'UNDER_REVIEW');
      await admin.page.getByTestId('package-refund-approve-normal').click();
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
    }
  });

  test('provider withdraws before review', async ({ browser, browserName }) => {
    const { provider, purchase, packageName } = await providerWithPaidPurchase(
      browser,
      purchaseTermsRuntime,
      `geri-${browserName}`,
    );
    try {
      await provider.gotoWeb('/destek/yeni');
      await provider.page.getByTestId('support-topic').getByText('Paket ve kredi iadesi', { exact: true }).click();
      await provider.page.getByTestId('refund-purchase-option').filter({ hasText: packageName }).click();
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
      // The provider cannot pick it, and says why on the general topic instead.
      await provider.gotoWeb('/destek/yeni');
      await provider.page.getByTestId('support-topic').getByText('Paket ve kredi iadesi', { exact: true }).click();
      await expect(provider.page.getByTestId('refund-purchase-option')).toHaveAttribute('data-selectable', 'false');
      await expect(provider.page.getByTestId('refund-purchase-note')).toContainText('teklif kredisi kullanıldı');
      await provider.page.getByTestId('support-topic').getByText('Genel', { exact: true }).click();
      await provider.page.getByTestId('support-subject-input').fill('Çift çekim');
      await provider.page.getByTestId('support-message-input').fill('Kartımdan iki kez çekildi, bir teklif de gönderdim.');
      await provider.page.getByRole('button', { name: 'Destek talebi oluştur' }).click();
      await expect(provider.page).toHaveURL(/\/destek\/[^/?]+\?created=1$/);
      const ticketId = new URL(provider.page.url()).pathname.split('/').pop()!;

      // The maker opens and takes the request from the ticket screen.
      await makerActor.loginToAdmin(maker.email, maker.password);
      await makerActor.gotoAdmin(`/support/${ticketId}`);
      await makerActor.page.locator('#support-refund-purchase').selectOption(purchase.id);
      await makerActor.page.getByTestId('support-refund-open').click();
      await expect(makerActor.page).toHaveURL(/\/package-refunds\/[^/?]+\?done=created$/);
      await makerActor.page.getByTestId('package-refund-take').click();
      await expect(makerActor.page.getByTestId('package-refund-status')).toHaveAttribute('data-status', 'UNDER_REVIEW');
      await expect(makerActor.page.getByTestId('package-refund-maker-checker')).toBeVisible();
      await expect(makerActor.page.getByTestId('package-refund-exception-form')).toHaveCount(0);
      await expect(makerActor.page.getByTestId('package-refund-approve-normal')).toHaveCount(0);
      const detailPath = new URL(makerActor.page.url()).pathname;

      // The checker approves it as an exception, with a ground and a reason.
      await checkerActor.loginToAdmin(checker.email, checker.password);
      await checkerActor.gotoAdmin(detailPath);
      const form = checkerActor.page.getByTestId('package-refund-exception-form');
      await form.locator('select[name="exceptionGround"]').selectOption('DUPLICATE_CHARGE');
      await form.locator('textarea[name="exceptionReason"]').fill('Aynı sipariş iki kez tahsil edilmiş.');
      await checkerActor.page.getByTestId('package-refund-approve-exception').click();
      await expect(checkerActor.page.getByTestId('package-refund-status')).toHaveAttribute(
        'data-status',
        'APPROVED_PENDING_SETTLEMENT',
      );
      await expect(checkerActor.page.getByTestId('package-refund-approval')).toContainText('İstisna');

      const refund = await prisma().packageRefundRequest.findFirstOrThrow({ where: { purchaseId: purchase.id } });
      expect(refund).toMatchObject({ approvalKind: 'EXCEPTION', exceptionGround: 'DUPLICATE_CHARGE', origin: 'ADMIN' });
      expect(refund.approvedById).not.toBe(refund.reviewStartedById);
    } finally {
      await provider.close();
      await makerActor.close();
      await checkerActor.close();
    }
  });

  test('gate closed: the support form is the general one, with no refund topic', async ({ browser, browserName }) => {
    const { provider } = await providerWithPaidPurchase(browser, primaryRuntime, `kapali-${browserName}`);
    try {
      await provider.gotoWeb('/destek/yeni');
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('support-new-form')).toBeVisible();
      await expect(provider.page.getByTestId('support-topic')).toHaveCount(0);
      await expect(provider.page.getByText('Paket ve kredi iadesi')).toHaveCount(0);
      await expect(provider.page.getByTestId('support-subject-input')).toBeVisible();
    } finally {
      await provider.close();
    }
  });
});
