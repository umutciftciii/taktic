import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createAdmin,
  createCategory,
  createClaimableCustomer,
  createCustomer,
  createProvider,
  createStaffAdmin,
  createSupportTicket,
  creditBalance,
  prisma,
  recordCreditTransaction,
  uniqueLocation,
} from '../src/fixtures';
import { seedCustomerRequest } from '../src/request-fixtures';
import { artifactsDir, primaryRuntime } from '../src/runtime';

/**
 * ADMIN-DESIGN-001 Faz 3B — Kişiler ve destek: /customers, /customers/[id],
 * /support, /support/[id], /providers, /providers/[id],
 * /providers/[id]/credits, through the real Next screens.
 *
 * What these pin, beyond the per-flow specs that already cover the same
 * screens (admin-customer-verification, customer-activation-proof,
 * support-tickets, provider-support-tickets, provider-claim,
 * provider-business-registration, provider-draft-category-binding,
 * package-refund-request, admin-action-visibility):
 *
 * - F4 end to end: a staff account (role ADMIN, not SUPER_ADMIN) holding
 *   FINANCE_LEDGER_READ reads a provider's credits on the credits screen and
 *   on the provider's Kredi hareketleri tab, and with CREDITS_GRANT /
 *   CREDITS_DEDUCT really moves credit — recorded under its own name — while
 *   a cancelled deduction writes nothing and a refused one keeps the form.
 * - Each section and action behind its own permission, for a restricted
 *   account and a super admin.
 * - Every destructive action asks first; cancelling writes nothing.
 * - The tabs are URLs: direct links, Back and Forward.
 * - Empty and filled records, 404s, and no page wider than the window at
 *   320, 390 and 1440px.
 *
 * StickyActionBar is not used by any of these screens, so its integration
 * criterion (Faz 2) does not apply to this slice.
 */

const SCREENS_DIR = resolve(artifactsDir, 'faz-3b-screens');

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  // The design package's width, so the captures compare one to one.
  await actor.page.setViewportSize({ width: 1440, height: 1617 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

async function expectOpen(page: Page, path: RegExp) {
  await expect(page).toHaveURL(path);
  await assertNoErrorScreen(page);
  await expect(page.getByRole('heading', { name: /yetkiniz yok/i })).toHaveCount(0);
}

/** The page is never wider than the window; a table scrolls inside its own box. */
async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: page overflow`).toBeLessThanOrEqual(1);
}

async function capture(page: Page, name: string) {
  const project = test.info().project.name;
  mkdirSync(SCREENS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  // The window only, as the design package's own 1440×1617 captures are: a
  // full-page capture redraws the sticky sidebar at the top only.
  await page.screenshot({ path: resolve(SCREENS_DIR, `${project}-${name}-${width}.png`) });
}

async function staffUserId(email: string) {
  const user = await prisma().user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return user.id;
}

async function seedProvider(credits = 40) {
  const category = await createCategory(3);
  const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits });
  return { category, provider };
}

test.describe('ADMIN-DESIGN-001 Faz 3B — kişiler ve destek', () => {
  test('F4: a staff account with ledger and credit permissions reads and moves a provider’s credits', async ({
    browser,
  }) => {
    const { provider } = await seedProvider(40);
    const { actor: staff, account } = await openAs(browser, [
      'FINANCE_LEDGER_READ',
      'CREDITS_GRANT',
      'CREDITS_DEDUCT',
      'PROVIDERS_READ_DETAIL',
    ]);
    const staffId = await staffUserId(account.email);
    const page = staff.page;

    try {
      // The provider screen's Kredi hareketleri tab reads the staff route.
      await staff.gotoAdmin(`/providers/${provider.id}?tab=kredi`);
      await expectOpen(page, new RegExp(`/providers/${provider.id}\\?tab=kredi$`));
      await expect(page.getByTestId('provider-panel-kredi')).toBeVisible();
      await expect(page.getByTestId('provider-credit-balance')).toContainText('40 kredi');
      await expect(page.getByTestId('credit-transaction-row')).toHaveCount(1);

      await page.getByRole('link', { name: 'Krediler', exact: true }).click();
      await expectOpen(page, new RegExp(`/providers/${provider.id}/credits$`));
      await expect(page.getByRole('heading', { name: 'İşlem geçmişi' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Manuel kredi işlemi' })).toBeVisible();

      const form = page.getByTestId('credit-operation-form');
      const amountInput = form.getByTestId('credit-operation-amount');
      const previewTotal = form.locator('.balance-preview-row.is-total .balance-preview-value');
      const staffRows = () =>
        prisma().providerCreditTransaction.count({ where: { providerId: provider.id, createdById: staffId } });

      // One reading of the amount (PR #122 review): "1e2" and "2.5" are not
      // amounts — not in the preview, not in the confirmation, not on submit.
      await form.getByTestId('credit-operation-reason').fill('Faz 3B E2E: geçersiz tutar');
      for (const typed of ['1e2', '2.5', '2,5']) {
        await amountInput.fill(typed);
        await expect(form.getByTestId('credit-operation-amount-invalid'), typed).toContainText('üslü gösterim');
        await expect(previewTotal, typed).toHaveText('40');
        await expect(form.getByTestId('credit-operation-grant'), typed).toBeDisabled();
      }
      // The server action reads the value the same way when the form's own
      // checks are bypassed: "1e2" reaches it and is refused, nothing recorded.
      await page.evaluate(() => {
        const formEl = document.querySelector<HTMLFormElement>('[data-testid="credit-operation-form"]')!;
        const input = formEl.querySelector<HTMLInputElement>('input[name="amount"]')!;
        input.value = '1e2';
        formEl.noValidate = true;
        formEl.requestSubmit();
      });
      await expect(page.getByTestId('credit-operation-error')).toContainText('İşlem yapılmadı: Tutar yalnız rakamlardan');
      expect(await creditBalance(provider.id)).toBe(40);
      expect(await staffRows()).toBe(0);

      // Grant: preview → recorded movement → new balance, one number throughout.
      await amountInput.fill('12');
      await expect(form.getByTestId('credit-operation-amount-invalid')).toHaveCount(0);
      await form.getByTestId('credit-operation-reason').fill('Faz 3B E2E: ekleme');
      await expect(previewTotal).toHaveText('52');
      await form.getByTestId('credit-operation-grant').click();
      await expect(page.getByTestId('credit-operation-done')).toHaveText('12 kredi eklendi. Yeni bakiye 52.');
      expect(await creditBalance(provider.id)).toBe(52);
      await expect(page.getByTestId('credits-fact-balance')).toContainText('52');
      await expect(form.getByTestId('credit-operation-amount')).toHaveValue('');

      // Deduct: the confirmation says the balance before and after; cancel sends nothing.
      await form.getByRole('tab', { name: 'Kredi düş' }).click();
      await form.getByTestId('credit-operation-amount').fill('5');
      await form.getByTestId('credit-operation-reason').fill('Faz 3B E2E: düşme');
      await expect(previewTotal).toHaveText('47');
      await form.getByTestId('credit-operation-deduct').click();
      const dialog = page.getByTestId('credit-operation-deduct-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('bakiye 52 → 47');
      await capture(page, 'credits-deduct-dialog');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      expect(await creditBalance(provider.id)).toBe(52);

      await form.getByTestId('credit-operation-deduct').click();
      await dialog.getByRole('button', { name: 'Evet, düş' }).click();
      await expect(page.getByTestId('credit-operation-done')).toHaveText('5 kredi düşüldü. Yeni bakiye 47.');
      expect(await creditBalance(provider.id)).toBe(47);

      const rows = await prisma().providerCreditTransaction.findMany({
        where: { providerId: provider.id, createdById: staffId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true, amount: true, balanceAfter: true, reason: true },
      });
      // The recorded movements are the previewed and confirmed amounts, and
      // their balances the previewed balances.
      expect(rows).toEqual([
        { type: 'ADMIN_GRANT', amount: 12, balanceAfter: 52, reason: 'Faz 3B E2E: ekleme' },
        { type: 'ADMIN_DEDUCT', amount: -5, balanceAfter: 47, reason: 'Faz 3B E2E: düşme' },
      ]);

      // A refusal: the balance moved underneath the open screen. The server
      // refuses, nothing is written, and what was typed stays.
      await recordCreditTransaction({ providerId: provider.id, type: 'ADMIN_DEDUCT', amount: -40 });
      await form.getByRole('tab', { name: 'Kredi düş' }).click();
      await form.getByTestId('credit-operation-amount').fill('20');
      await form.getByTestId('credit-operation-reason').fill('Faz 3B E2E: bayat bakiye');
      await form.getByTestId('credit-operation-deduct').click();
      await dialog.getByRole('button', { name: 'Evet, düş' }).click();
      await expect(page.getByTestId('credit-operation-error')).toContainText('eksiye düşürürdü');
      await expect(form.getByTestId('credit-operation-amount')).toHaveValue('20');
      await expect(form.getByTestId('credit-operation-reason')).toHaveValue('Faz 3B E2E: bayat bakiye');
      expect(await creditBalance(provider.id)).toBe(7);
      expect(
        await prisma().providerCreditTransaction.count({ where: { providerId: provider.id, createdById: staffId } }),
      ).toBe(2);
    } finally {
      await staff.close();
    }
  });

  test('F4 boundaries: without the ledger permission there is no credit tab, link or screen', async ({ browser }) => {
    const { provider } = await seedProvider(10);
    const { actor: staff } = await openAs(browser, ['PROVIDERS_READ_DETAIL']);
    const page = staff.page;

    try {
      await staff.gotoAdmin(`/providers/${provider.id}`);
      await expectOpen(page, new RegExp(`/providers/${provider.id}$`));
      const tabs = page.getByRole('navigation', { name: 'Hizmet veren sekmeleri' });
      await expect(tabs.getByRole('link')).toHaveText(['İşletme bilgileri', /Teklifler ve paketler/]);
      await expect(page.getByRole('link', { name: 'Krediler', exact: true })).toHaveCount(0);
      // PROVIDERS_READ is not held: no way back to a list that would refuse.
      await expect(page.locator('.detail-back')).toHaveCount(0);
      // No write surface without its permission.
      for (const name of ['İş almasını durdur', 'Durumu kaydet', 'Claim daveti gönder', 'Kaldır']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
      // Bindings are PROVIDERS_READ: the card is absent, not empty.
      await expect(page.locator('#hizmet-kategorileri')).toHaveCount(0);

      // A hand-written tab it may not open falls back to the first tab.
      await staff.gotoAdmin(`/providers/${provider.id}?tab=kredi`);
      await expect(page.getByTestId('provider-panel-bilgiler')).toBeVisible();
      await expect(page.getByTestId('provider-panel-kredi')).toHaveCount(0);

      await staff.gotoAdmin(`/providers/${provider.id}/credits`);
      await expect(page).toHaveURL(/\/yetkisiz$/);
    } finally {
      await staff.close();
    }
  });

  test('customer detail: notes are their own permission, and nothing else goes with them (F7)', async ({ browser }) => {
    const customer = await createClaimableCustomer('E2E 3B Sınırlı');
    const reader = await openAs(browser, ['CUSTOMERS_READ']);
    const noteReader = await openAs(browser, ['CUSTOMERS_READ', 'CUSTOMER_NOTES_READ']);

    try {
      const page = reader.actor.page;
      await reader.actor.gotoAdmin(`/customers/${customer.id}`);
      await expectOpen(page, new RegExp(`/customers/${customer.id}$`));
      const tabs = page.getByRole('navigation', { name: 'Müşteri sekmeleri' });
      await expect(tabs.getByRole('link')).toHaveText(['Profil ve iletişim', /Talep geçmişi/, /Aldığı teklifler/]);
      await expect(page.getByTestId('customer-email-verification')).toBeVisible();
      for (const name of ['Hesabı pasife al', 'Şifre belirleme bağlantısı oluştur']) {
        await expect(page.getByRole('button', { name })).toHaveCount(0);
      }
      await expect(page.getByRole('link', { name: 'Not ekle' })).toHaveCount(0);
      await reader.actor.gotoAdmin(`/customers/${customer.id}?tab=notlar`);
      await expect(page.getByTestId('customer-panel-profil')).toBeVisible();
      await expect(page.getByTestId('customer-panel-notlar')).toHaveCount(0);

      const notesPage = noteReader.actor.page;
      await noteReader.actor.gotoAdmin(`/customers/${customer.id}?tab=notlar`);
      await expect(notesPage.getByTestId('customer-panel-notlar')).toBeVisible();
      await expect(notesPage.getByText('Henüz müşteri notu yok.')).toBeVisible();
      await expect(notesPage.locator('#not-ekle')).toHaveCount(0);
    } finally {
      await reader.actor.close();
      await noteReader.actor.close();
    }
  });

  test('customer detail as super admin: tabs as URLs, a note, passivation behind a confirmation', async ({
    browser,
  }) => {
    const category = await createCategory(3);
    const filled = await createCustomer('E2E 3B Dolu');
    await seedCustomerRequest({ customerId: filled.id, categoryId: category.id, location: uniqueLocation(), content: 'full' });
    const empty = await createCustomer('E2E 3B Boş');
    const { actor: admin } = await openAs(browser, 'super');
    const page = admin.page;

    try {
      // Empty and filled records.
      await admin.gotoAdmin(`/customers/${empty.id}?tab=talepler`);
      await expect(page.getByTestId('customer-panel-talepler')).toContainText('Henüz talep yok.');
      await admin.gotoAdmin(`/customers/${filled.id}`);
      await expect(page.getByTestId('customer-fact-requests')).toContainText('1');
      await capture(page, 'customer-detail-profil');

      // Tabs are links: each is a URL, and Back/Forward walk them.
      await page.getByTestId('customer-tab-talepler').click();
      await expect(page).toHaveURL(new RegExp(`/customers/${filled.id}\\?tab=talepler$`));
      await expect(page.getByTestId('customer-request-row')).toHaveCount(1);
      await capture(page, 'customer-detail-talepler');
      await page.getByTestId('customer-tab-notlar').click();
      await expect(page).toHaveURL(/\?tab=notlar$/);
      await page.goBack();
      await expect(page).toHaveURL(/\?tab=talepler$/);
      await expect(page.getByTestId('customer-panel-talepler')).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(/\?tab=notlar$/);
      await expect(page.getByTestId('customer-panel-notlar')).toBeVisible();

      await page.locator('#customer-note').fill('Faz 3B E2E notu: telefonla görüşüldü.');
      await page.getByRole('button', { name: 'Notu ekle' }).click();
      await expect(page.getByTestId('customer-note').first()).toContainText('Faz 3B E2E notu');
      await capture(page, 'customer-detail-notlar');

      // Passivation asks; cancelling writes nothing.
      await page.getByTestId('customer-passivate').click();
      const dialog = page.getByTestId('customer-passivate-dialog');
      await expect(dialog).toContainText('bir daha giriş yapamaz');
      await capture(page, 'customer-passivate-dialog');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      const stillActive = await prisma().user.findUniqueOrThrow({ where: { id: filled.id }, select: { isActive: true } });
      expect(stillActive.isActive).toBe(true);

      await page.getByTestId('customer-passivate').click();
      await dialog.getByRole('button', { name: 'Evet, pasife al' }).click();
      await expect(page.getByTestId('customer-status')).toHaveText('Pasif hesap');
      await expect
        .poll(async () => (await prisma().user.findUniqueOrThrow({ where: { id: filled.id } })).isActive)
        .toBe(false);

      // Turning it back on gives, and goes straight through.
      await page.getByTestId('customer-activate').click();
      await expect(page.getByTestId('customer-status')).toHaveText('Aktif hesap');
      await expect
        .poll(async () => (await prisma().user.findUniqueOrThrow({ where: { id: filled.id } })).isActive)
        .toBe(true);

      await admin.gotoAdmin('/customers/no-such-customer');
      await expect(page.getByRole('heading', { name: 'Kayıt bulunamadı' })).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('customer access link: issued once, never in the address, copyable', async ({ browser }) => {
    const customer = await createClaimableCustomer('E2E 3B Aktivasyon');
    const { actor: admin } = await openAs(browser, ['CUSTOMERS_READ', 'CUSTOMER_ACTIVATION_LINK_ISSUE']);
    const page = admin.page;

    try {
      await admin.gotoAdmin(`/customers/${customer.id}`);
      await page.getByRole('button', { name: 'Şifre belirleme bağlantısı oluştur' }).click();
      const url = page.getByTestId('customer-activation-url');
      await expect(url).toContainText('token=');
      expect(page.url()).not.toContain('token');
      await expect(page.getByTestId('customer-activation-copy')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Yeni bağlantı oluştur' })).toBeVisible();
      await capture(page, 'customer-access-issued');
    } finally {
      await admin.close();
    }
  });

  test('provider detail as super admin: suspend, reject and unbind each ask first', async ({ browser }) => {
    const { provider, category } = await seedProvider(15);
    await prisma().providerServiceCategory.upsert({
      where: { providerId_categoryId: { providerId: provider.id, categoryId: category.id } },
      create: { providerId: provider.id, categoryId: category.id },
      update: {},
    });
    const slug = (await prisma().serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).slug;
    const { actor: admin } = await openAs(browser, 'super');
    const page = admin.page;
    const statusOf = async () =>
      (await prisma().providerProfile.findUniqueOrThrow({ where: { id: provider.id } })).status;

    try {
      await admin.gotoAdmin(`/providers/${provider.id}`);
      await expectOpen(page, new RegExp(`/providers/${provider.id}$`));
      await capture(page, 'provider-detail-bilgiler');

      // Suspend from the header: cancel, then confirm.
      await page.getByTestId('provider-suspend').click();
      const suspend = page.getByTestId('provider-suspend-dialog');
      await expect(suspend).toContainText('vitrin kartları hemen yayından kalkar');
      await capture(page, 'provider-suspend-dialog');
      await suspend.getByRole('button', { name: 'Vazgeç' }).click();
      expect(await statusOf()).toBe('APPROVED');
      await page.getByTestId('provider-suspend').click();
      await suspend.getByRole('button', { name: 'Evet, askıya al' }).click();
      await expect(page.getByTestId('provider-status-saved')).toBeVisible();
      expect(await statusOf()).toBe('SUSPENDED');

      await page.getByTestId('provider-approve').click();
      await expect(page.getByTestId('provider-status')).toHaveText('Onaylandı');
      expect(await statusOf()).toBe('APPROVED');

      // Reject from the status form: the reason is required, the move confirmed.
      await page.locator('#provider-status-select').selectOption('REJECTED');
      await page.locator('#provider-rejection-reason').fill('Faz 3B E2E: belgeler eksik.');
      await page.getByTestId('provider-status-save').click();
      const reject = page.getByTestId('provider-status-save-dialog');
      await expect(reject).toContainText('ret gerekçesi kayda geçer');
      await reject.getByRole('button', { name: 'Vazgeç' }).click();
      expect(await statusOf()).toBe('APPROVED');
      await page.getByTestId('provider-status-save').click();
      await reject.getByRole('button', { name: 'Evet, reddet' }).click();
      await expect(page.getByTestId('provider-status')).toHaveText('Reddedildi');
      const rejected = await prisma().providerProfile.findUniqueOrThrow({ where: { id: provider.id } });
      expect(rejected.rejectionReason).toBe('Faz 3B E2E: belgeler eksik.');

      // Unbinding a category asks; cancelling keeps the binding.
      const bound = () =>
        prisma().providerServiceCategory.count({ where: { providerId: provider.id, categoryId: category.id } });
      await page.getByTestId(`provider-category-remove-${slug}`).click();
      const unbind = page.getByTestId(`provider-category-remove-${slug}-dialog`);
      await expect(unbind).toContainText('artık gösterilmez');
      await unbind.getByRole('button', { name: 'Vazgeç' }).click();
      expect(await bound()).toBe(1);
      await page.getByTestId(`provider-category-remove-${slug}`).click();
      await unbind.getByRole('button', { name: 'Evet, kaldır' }).click();
      await expect(page.getByTestId('provider-category-notice')).toContainText('Kategori bağı kaldırıldı.');
      expect(await bound()).toBe(0);

      // Tabs as URLs, Back and Forward.
      await page.getByTestId('provider-tab-kredi').click();
      await expect(page).toHaveURL(/\?tab=kredi$/);
      await expect(page.getByTestId('provider-credit-balance')).toContainText('15 kredi');
      await capture(page, 'provider-detail-kredi');
      await page.getByTestId('provider-tab-degerlendirmeler').click();
      await expect(page).toHaveURL(/\?tab=degerlendirmeler$/);
      await expect(page.getByText('Henüz değerlendirme yok.')).toBeVisible();
      await capture(page, 'provider-detail-degerlendirmeler');
      await page.goBack();
      await expect(page.getByTestId('provider-panel-kredi')).toBeVisible();
      await page.goForward();
      await expect(page.getByTestId('provider-panel-degerlendirmeler')).toBeVisible();

      await admin.gotoAdmin('/providers/no-such-provider');
      await expect(page.getByRole('heading', { name: 'Kayıt bulunamadı' })).toBeVisible();
    } finally {
      await admin.close();
    }
  });

  test('support: closing asks first, a read-only account gets no controls, the account link works', async ({
    browser,
  }) => {
    const customer = await createCustomer('E2E 3B Destek');
    const ticket = await createSupportTicket({ requesterId: customer.id, status: 'RESOLVED', subject: 'Faz 3B kapanış' });
    const reader = await openAs(browser, ['SUPPORT_READ']);
    const { actor: admin } = await openAs(browser, 'super');
    const statusOf = async () => (await prisma().supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status;

    try {
      const readPage = reader.actor.page;
      await reader.actor.gotoAdmin(`/support/${ticket.id}`);
      await expectOpen(readPage, new RegExp(`/support/${ticket.id}$`));
      await expect(readPage.getByTestId('support-timeline-message')).toHaveCount(1);
      await expect(readPage.getByTestId('support-transitions')).toHaveCount(0);
      await expect(readPage.getByTestId('support-reply-form')).toHaveCount(0);
      // CUSTOMERS_READ is not held: no link to a screen that would refuse.
      await expect(readPage.getByTestId('support-account-link')).toHaveCount(0);

      const page = admin.page;
      await admin.gotoAdmin(`/support/${ticket.id}`);
      await capture(page, 'support-detail');
      await page.getByTestId('support-transition-CLOSED').click();
      const dialog = page.getByTestId('support-transition-CLOSED-dialog');
      await expect(dialog).toContainText('yeniden açılamaz');
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      expect(await statusOf()).toBe('RESOLVED');
      await page.getByTestId('support-transition-CLOSED').click();
      await dialog.getByRole('button', { name: 'Evet, kapat' }).click();
      await expect(page.getByTestId('support-detail-status')).toHaveText('Kapatıldı');
      expect(await statusOf()).toBe('CLOSED');

      // N2: a hizmet alan's account opens their customer screen, not /users.
      await page.getByTestId('support-account-link').click();
      await expectOpen(page, new RegExp(`/customers/${customer.id}$`));

      await admin.gotoAdmin('/support/no-such-ticket');
      await expect(page.getByRole('heading', { name: 'Kayıt bulunamadı' })).toBeVisible();
    } finally {
      await reader.actor.close();
      await admin.close();
    }
  });

  test('lists: saved views and filters are URLs, rows open their record', async ({ browser }) => {
    const { provider } = await seedProvider(5);
    const customer = await createCustomer('E2E 3B Liste');
    await createSupportTicket({ requesterId: customer.id, status: 'OPEN', subject: 'Faz 3B liste talebi' });
    const { actor: admin } = await openAs(browser, 'super');
    const page = admin.page;

    try {
      await admin.gotoAdmin('/providers');
      await capture(page, 'providers-list');
      await page.getByTestId('provider-view-approved').click();
      await expect(page).toHaveURL(/\/providers\?status=APPROVED$/);
      await expect(page.getByTestId('provider-view-approved')).toHaveAttribute('aria-current', 'page');
      await page.locator('#provider-search').fill(provider.businessName);
      await page.getByRole('button', { name: 'Filtrele' }).click();
      await expect(page).toHaveURL(/q=/);
      await expect(page.getByTestId('provider-row')).toHaveCount(1);
      await page.getByTestId('provider-row').getByRole('link', { name: `Aç: ${provider.businessName}` }).click();
      await expectOpen(page, new RegExp(`/providers/${provider.id}$`));

      await admin.gotoAdmin(`/customers?q=${encodeURIComponent(customer.email)}`);
      await capture(page, 'customers-list');
      await expect(page.getByTestId('customer-row')).toHaveCount(1);
      await expect(page.getByTestId('customer-count')).toHaveText('1 müşteri');
      await page.getByTestId('customer-row').getByRole('link', { name: /^Aç:/ }).click();
      await expectOpen(page, new RegExp(`/customers/${customer.id}$`));

      await admin.gotoAdmin('/support');
      await capture(page, 'support-list');
      await page.getByTestId('support-view-backlog').click();
      await expect(page).toHaveURL(/\/support\?status=OPEN(,|%2C)IN_PROGRESS$/);
      await expect(page.locator('#support-status')).toHaveValue('OPEN,IN_PROGRESS');
      const row = page.getByTestId('support-ticket-row').filter({ hasText: 'Faz 3B liste talebi' });
      await expect(row).toHaveCount(1);
      await row.getByRole('link', { name: /^Aç:/ }).click();
      await expect(page.getByTestId('support-detail-status')).toHaveText('Açık');
    } finally {
      await admin.close();
    }
  });

  test('no page is wider than the window at 320, 390 and 1440px, on every tab', async ({ browser }) => {
    const { provider } = await seedProvider(20);
    const customer = await createCustomer('E2E 3B Taşma Uzun İsimli Müşteri Hesabı');
    const ticket = await createSupportTicket({
      requesterId: customer.id,
      status: 'OPEN',
      subject: 'Cok-uzun-ve-bosluksuz-bir-destek-konusu-tasma-denetimi-icin-yazildi',
    });
    const { actor: admin } = await openAs(browser, 'super');
    const page = admin.page;
    const paths = [
      '/customers',
      `/customers/${customer.id}`,
      `/customers/${customer.id}?tab=talepler`,
      `/customers/${customer.id}?tab=teklifler`,
      `/customers/${customer.id}?tab=notlar`,
      '/support',
      `/support/${ticket.id}`,
      '/providers',
      `/providers/${provider.id}`,
      `/providers/${provider.id}?tab=kredi`,
      `/providers/${provider.id}?tab=degerlendirmeler`,
      `/providers/${provider.id}?tab=teklifler`,
      `/providers/${provider.id}/credits`,
    ];

    try {
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of paths) {
          await admin.gotoAdmin(path);
          await assertNoErrorScreen(page);
          await expectNoPageOverflow(page, `${path} @ ${width}px`);
        }
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await admin.gotoAdmin(`/providers/${provider.id}`);
      await capture(page, 'provider-detail-bilgiler');
      await admin.gotoAdmin(`/support/${ticket.id}`);
      await capture(page, 'support-detail');
    } finally {
      await admin.close();
    }
  });
});
