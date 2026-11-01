import { expect, test, type Locator, type Page } from '@playwright/test';
import { settleActionRedirect } from '../src/action-redirect';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { confirmThrough, waitForHydration } from '../src/confirm-dialog';
import { createAdmin, createStaffAdmin, prisma } from '../src/fixtures';
import { emailEntriesFor } from '../src/outbox';
import { E2E_OPS_ALERT_EMAIL, primaryRuntime } from '../src/runtime';

/**
 * OBS-ALERT-002 PR-B — Bildirim ayarları (managed operations-alert e-mail
 * recipients), end to end against the real API, database and file outbox.
 *
 * One SUPER_ADMIN walks the whole runbook: import OPS_ALERT_EMAIL (set for the
 * suite in playwright.config.ts), add a second recipient, send it a test
 * e-mail (recorded by the file outbox — the suite's e-mail transport never
 * delivers), reveal its address in its own window, preview and approve the
 * cutover, pause the imported recipient, meet the last-recipient guard, revert
 * (preview and approval) and delete the remaining recipient with a reason
 * through the last-critical second confirmation. The recipient log then holds
 * every one of those events.
 *
 * Why the delete comes after the revert: this runtime declares no
 * APP_ENVIRONMENT (pinned empty in playwright.config.ts, so a developer's
 * exported value cannot change it), which the API treats as production. Under MANAGED routing
 * with no Telegram, taking away the last critical recipient is therefore
 * blocked outright (LAST_CHANNEL_PROTECTED, no confirmation offered) — the
 * spec asserts that dead end — and the confirmable last-critical step is what
 * the same delete meets once alerts go to OPS_ALERT_EMAIL again.
 *
 * A full address is checked never to be in the page (the reveal window aside,
 * and gone once it closes) nor in any URL. Assertions about addresses compare
 * booleans, so a failure message never prints one.
 *
 * Retry-safe: the recipient log is append-only and shared, so its assertions
 * count only the rows this test's own admin wrote (`ownAuditRows`), and the
 * outbox is compared with its count before the test.
 *
 * Global state is restored in `finally` (routing back to ENV_LEGACY, every
 * live recipient shredded), since the suite is one serial worker on one
 * database.
 */

const PATH = '/system-health/notification-settings';
const SECOND_ADDRESS = 'ops-e2e-ikinci@example.test';
const SECOND_LABEL = 'E2E Nöbetçi mühendis';
const IMPORTED_LABEL = 'OPS_ALERT_EMAIL (içe aktarıldı)';
const DELETE_REASON = 'E2E: nöbet listesi değişti, alıcı kaldırıldı.';
const ADDRESSES = [E2E_OPS_ALERT_EMAIL, SECOND_ADDRESS];

/**
 * This run's entries in the recipient log: the rows whose actor is this test's
 * own (uniquely named) admin. The log is append-only and shared by the whole
 * database, so a retry in the same run sees the first attempt's rows too.
 */
function ownAuditRows(page: Page, actorEmail: string, action: string): Locator {
  return page
    .getByTestId('ops-alert-audit')
    .locator(`[data-testid="audit-row"][data-action="${action}"]`)
    .filter({ has: page.getByTestId('audit-actor').filter({ hasText: actorEmail }) });
}

function row(page: Page, label: string): Locator {
  return page.getByTestId('ops-alert-recipient-row').filter({ hasText: label });
}

/** Whether any full address is in the document or the URL; a boolean, so nothing is printed. */
async function addressExposed(page: Page): Promise<boolean> {
  const html = (await page.content()).toLowerCase();
  const url = decodeURIComponent(page.url()).toLowerCase();
  return ADDRESSES.some((address) => html.includes(address) || url.includes(address));
}

async function routingMode(): Promise<string> {
  const settings = await prisma().opsAlertRoutingSettings.findUnique({
    where: { id: 'ops-alert-routing' },
    select: { emailRouting: true },
  });
  return settings?.emailRouting ?? 'ENV_LEGACY';
}

async function recipientByLabel(label: string) {
  return prisma().opsAlertRecipient.findFirst({
    where: { label },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, addressCiphertext: true, addressHmac: true },
  });
}

/** Puts the shared state back: ENV_LEGACY, and no live recipient (crypto-shredded as a delete would). */
async function restoreGlobalState(actorId: string): Promise<void> {
  const db = prisma();
  await db.opsAlertRoutingSettings.upsert({
    where: { id: 'ops-alert-routing' },
    create: { id: 'ops-alert-routing', emailRouting: 'ENV_LEGACY' },
    update: { emailRouting: 'ENV_LEGACY' },
  });
  await db.opsAlertRecipient.updateMany({
    where: { status: { not: 'DELETED' } },
    data: {
      status: 'DELETED',
      addressCiphertext: null,
      addressNonce: null,
      addressTag: null,
      addressKeyId: null,
      addressHmac: null,
      addressHmacVersion: null,
      deletedAt: new Date(),
      deletedById: actorId,
    },
  });
}

test.describe('OBS-ALERT-002 — Bildirim ayarları', () => {
  test('a super admin imports, adds, tests, reveals, cuts over, pauses, reverts and deletes — and the log says so', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const account = await createAdmin();
    const admin = await Actor.open(browser, 'super', primaryRuntime, { viewport: { width: 1440, height: 1100 } });
    const page = admin.page;
    const outboxBefore = emailEntriesFor(SECOND_ADDRESS).filter((entry) => entry.template === 'ops-alert').length;
    const envOutboxBefore = emailEntriesFor(E2E_OPS_ALERT_EMAIL).length;

    try {
      await admin.loginToAdmin(account.email, account.password);

      // ---- reached from Sistem sağlığı; starts in ENV_LEGACY, empty ----------
      await admin.gotoAdmin('/system-health');
      await page.getByTestId('system-health-notification-settings-link').click();
      await expect(page).toHaveURL((url) => url.pathname === PATH);
      await assertNoErrorScreen(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Bildirim ayarları' })).toBeVisible();
      await expect(page.getByTestId('ops-alert-routing-mode')).toHaveAttribute('data-routing', 'ENV_LEGACY');
      await expect(page.getByTestId('ops-alert-recipient-count')).toHaveText('0/10 alıcı');
      await expect(page.getByTestId('ops-alert-env-legacy-notice')).toBeVisible();
      await expect(page.getByTestId('ops-alert-routing-panel')).toBeVisible();

      // ---- ① import OPS_ALERT_EMAIL ---------------------------------------
      const importButton = page.getByTestId('ops-alert-routing-import');
      await waitForHydration(importButton);
      await settleActionRedirect(page, () => importButton.click());
      await expect(page.getByTestId('ops-alert-recipients-ok')).toContainText('OPS_ALERT_EMAIL yönetilen alıcı olarak eklendi');
      await expect(page.getByTestId('ops-alert-routing-imported')).toBeVisible();
      await expect(row(page, IMPORTED_LABEL).locator('code')).toHaveText('o******@example.test');
      await expect(page.getByTestId('ops-alert-recipient-count')).toHaveText('1/10 alıcı');
      expect(await addressExposed(page), 'a full address on the page after the import').toBe(false);

      // ---- a second recipient, typed in the window --------------------------
      await page.getByTestId('ops-alert-recipient-add').click();
      await expect(page).toHaveURL(/\?alici=yeni$/);
      const form = page.getByTestId('ops-alert-recipient-form');
      const addressField = form.getByTestId('ops-alert-form-address');
      await waitForHydration(addressField);
      await addressField.fill(SECOND_ADDRESS);
      await form.getByTestId('ops-alert-form-label').fill(SECOND_LABEL);
      // New recipients start with Kritik and Düzelme on, Uyarı off.
      await expect(form.getByTestId('ops-alert-form-notifyWarning')).toHaveAttribute('aria-checked', 'false');
      await expect(form.getByTestId('ops-alert-form-notifyCritical')).toHaveAttribute('aria-checked', 'true');
      await expect(form.getByTestId('ops-alert-form-notifyRecovery')).toHaveAttribute('aria-checked', 'true');
      await settleActionRedirect(page, () => form.getByTestId('ops-alert-form-submit').click());
      await expect(page.getByTestId('ops-alert-recipients-ok')).toContainText('Alıcı eklendi.');
      await expect(page.getByTestId('ops-alert-recipient-count')).toHaveText('2/10 alıcı');
      const second = row(page, SECOND_LABEL);
      await expect(second.locator('code')).toHaveText('o*************@example.test');
      expect(await addressExposed(page), 'a full address on the page after the add').toBe(false);
      const secondRow = await recipientByLabel(SECOND_LABEL);
      expect(secondRow?.status).toBe('ACTIVE');

      // ---- test send: lands in the file outbox, never on the page -----------
      const testButton = second.getByTestId('ops-alert-recipient-test');
      await waitForHydration(testButton);
      await testButton.click();
      await expect(second.getByTestId('ops-alert-recipient-test-result')).toHaveAttribute('data-result', 'SENT');
      await expect(second.getByTestId('ops-alert-recipient-test-result')).toContainText('Test e-postası gönderildi.');
      await expect
        .poll(() => emailEntriesFor(SECOND_ADDRESS).filter((entry) => entry.template === 'ops-alert').length, {
          message: 'the test e-mail was not recorded by the outbox',
        })
        .toBe(outboxBefore + 1);
      // Only the recipient tested was written to.
      expect(emailEntriesFor(E2E_OPS_ALERT_EMAIL).length).toBe(envOutboxBefore);
      expect(await addressExposed(page), 'a full address on the page after the test send').toBe(false);

      // ---- reveal: only in its own window, gone once it closes --------------
      const reveal = second.getByTestId('ops-alert-recipient-reveal');
      await confirmThrough(reveal, 'Evet, göster', async (dialog) => {
        await expect(dialog).toContainText('Her görüntüleme alıcı geçmişine kaydedilir.');
      });
      const revealed = second.getByTestId('ops-alert-recipient-revealed');
      await expect(revealed).toBeVisible();
      const shownAddress = revealed.getByTestId('ops-alert-recipient-revealed-address');
      await expect(shownAddress).toBeVisible();
      expect((await shownAddress.textContent())?.trim() === SECOND_ADDRESS, 'the window shows the typed address').toBe(true);
      // The address is in the window and nowhere else on the page.
      const outside = await page.evaluate((addresses) => {
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[data-testid="ops-alert-recipient-revealed"]').forEach((node) => node.remove());
        const html = clone.outerHTML.toLowerCase();
        return addresses.some((address) => html.includes(address)) || addresses.some((a) => location.href.toLowerCase().includes(a));
      }, ADDRESSES);
      expect(outside, 'a full address outside the reveal window').toBe(false);
      await revealed.locator('.confirm-dialog-actions').getByRole('button', { name: 'Kapat' }).click();
      await expect(revealed).toBeHidden();
      await expect(page.getByTestId('ops-alert-recipient-revealed-address')).toHaveCount(0);
      // The close refreshes the list, so the REVEALED row shows in the log.
      await expect(ownAuditRows(page, account.email, 'REVEALED')).toHaveCount(1);
      expect(await addressExposed(page), 'a full address left after the reveal window closed').toBe(false);

      // ---- cutover: preview, then the approval bound to it ------------------
      const cutover = page.getByTestId('ops-alert-routing-cutover-form');
      const cutoverPreview = cutover.getByTestId('ops-alert-routing-cutover-preview');
      await waitForHydration(cutoverPreview);
      await cutoverPreview.click();
      await expect(cutover.getByTestId('ops-alert-routing-cutover-preview-result')).toBeVisible();
      for (const status of ['PENDING', 'FAILED', 'SENDING']) {
        await expect(cutover.getByTestId(`ops-alert-routing-count-${status}-rebind`)).toHaveText('0');
        await expect(cutover.getByTestId(`ops-alert-routing-count-${status}-cancel`)).toHaveText('0');
      }
      await expect(cutover.getByTestId('ops-alert-routing-blocker')).toHaveCount(0);
      await settleActionRedirect(page, () =>
        confirmThrough(cutover.getByTestId('ops-alert-routing-cutover-confirm'), 'Evet, yönetilen moda geç'),
      );
      await expect(page.getByTestId('ops-alert-recipients-ok')).toContainText('Yönlendirme yönetilen alıcılara geçirildi.');
      await expect(page.getByTestId('ops-alert-routing-mode')).toHaveAttribute('data-routing', 'MANAGED');
      await expect(page.getByTestId('ops-alert-env-legacy-notice')).toHaveCount(0);
      expect(await routingMode()).toBe('MANAGED');

      // ---- pause the imported recipient: the second is now the last critical one
      const imported = row(page, IMPORTED_LABEL);
      await settleActionRedirect(page, () => confirmThrough(imported.getByTestId('ops-alert-recipient-pause'), 'Evet, duraklat'));
      await expect(page.getByTestId('ops-alert-recipients-ok')).toContainText('Alıcı duraklatıldı.');
      await expect(row(page, IMPORTED_LABEL)).toHaveAttribute('data-status', 'PAUSED');
      expect((await recipientByLabel(IMPORTED_LABEL))?.status).toBe('PAUSED');
      await expect(row(page, SECOND_LABEL).getByTestId('ops-alert-recipient-last-critical')).toBeVisible();

      // ---- MANAGED, no Telegram, undeclared environment: the delete is a dead end
      await row(page, SECOND_LABEL).getByTestId('ops-alert-recipient-delete-link').click();
      await expect(page).toHaveURL(/islem=sil/);
      const blockedForm = page.getByTestId('ops-alert-recipient-delete-form');
      const blockedReason = blockedForm.getByTestId('ops-alert-recipient-reason');
      await waitForHydration(blockedReason);
      await blockedReason.fill(DELETE_REASON);
      await confirmThrough(blockedForm.getByTestId('ops-alert-recipient-delete'), 'Evet, sil');
      await expect(blockedForm.getByTestId('ops-alert-recipient-delete-last-critical-blocked')).toBeVisible();
      await expect(blockedForm.getByTestId('ops-alert-recipient-delete-last-critical-confirm')).toHaveCount(0);
      expect((await recipientByLabel(SECOND_LABEL))?.status).toBe('ACTIVE');
      await blockedForm.getByRole('link', { name: 'Vazgeç' }).click();
      await expect(page).toHaveURL((url) => url.pathname === PATH && url.search === '');

      // ---- revert: preview, then the approval ---------------------------------
      const revert = page.getByTestId('ops-alert-routing-revert-form');
      const revertPreview = revert.getByTestId('ops-alert-routing-revert-preview');
      await waitForHydration(revertPreview);
      await revertPreview.click();
      await expect(revert.getByTestId('ops-alert-routing-revert-preview-result')).toBeVisible();
      await expect(revert.getByTestId('ops-alert-routing-blocker')).toHaveCount(0);
      // Nothing to cancel, nothing in flight: no tick is asked for.
      await expect(revert.getByTestId('ops-alert-routing-cancel-unmatched')).toHaveCount(0);
      await settleActionRedirect(page, () =>
        confirmThrough(revert.getByTestId('ops-alert-routing-revert-confirm'), 'Evet, env moduna dön'),
      );
      await expect(page.getByTestId('ops-alert-recipients-ok')).toContainText('Yönlendirme OPS_ALERT_EMAIL adresine döndürüldü.');
      await expect(page.getByTestId('ops-alert-routing-mode')).toHaveAttribute('data-routing', 'ENV_LEGACY');
      expect(await routingMode()).toBe('ENV_LEGACY');

      // ---- delete with a reason, through the last-critical second step -------
      await row(page, SECOND_LABEL).getByTestId('ops-alert-recipient-delete-link').click();
      await expect(page).toHaveURL(/islem=sil/);
      const deleteForm = page.getByTestId('ops-alert-recipient-delete-form');
      const reason = deleteForm.getByTestId('ops-alert-recipient-reason');
      await waitForHydration(reason);
      await reason.fill(DELETE_REASON);
      await confirmThrough(deleteForm.getByTestId('ops-alert-recipient-delete'), 'Evet, sil');
      const step = deleteForm.getByTestId('ops-alert-recipient-delete-last-critical');
      await expect(step).toBeVisible();
      await expect(step.locator('.notice-warning')).toContainText('kritik');
      // The first answer wrote nothing.
      expect((await recipientByLabel(SECOND_LABEL))?.status).toBe('ACTIVE');
      // The typed reason survived the refusal.
      await expect(reason).toHaveValue(DELETE_REASON);
      await settleActionRedirect(page, () =>
        confirmThrough(deleteForm.getByTestId('ops-alert-recipient-delete-last-critical-confirm'), 'Yine de sil'),
      );
      await expect(page.getByTestId('ops-alert-recipients-ok')).toContainText('Alıcı silindi.');
      await expect(row(page, SECOND_LABEL)).toHaveCount(0);
      const deleted = await recipientByLabel(SECOND_LABEL);
      expect(deleted?.status).toBe('DELETED');
      // Crypto-shredded.
      expect(deleted?.addressCiphertext).toBeNull();
      expect(deleted?.addressHmac).toBeNull();

      // ---- the recipient log holds every step, the reason with the delete ----
      const audit = page.getByTestId('ops-alert-audit');
      for (const action of [
        'IMPORTED_FROM_ENV',
        'CREATED',
        'TEST_SENT',
        'REVEALED',
        'ROUTING_CUTOVER',
        'PAUSED',
        'ROUTING_REVERTED',
        'DELETED',
      ]) {
        await expect(ownAuditRows(page, account.email, action), action).toHaveCount(1);
      }
      await expect(audit).toContainText('OPS_ALERT_EMAIL adresi alıcı olarak içe aktarıldı');
      await expect(audit).toContainText('Test e-postası gönderildi');
      await expect(audit).toContainText('Adres açık görüntülendi');
      await expect(audit).toContainText('Yönlendirme yönetilen alıcılara geçirildi');
      await expect(audit).toContainText('Yönlendirme ortam değişkenine döndürüldü');
      await expect(ownAuditRows(page, account.email, 'DELETED')).toContainText(DELETE_REASON);
      const logged = await prisma().opsAlertRecipientAuditLog.findMany({
        where: { recipientId: secondRow!.id },
        select: { action: true, reason: true },
      });
      expect(logged.find((entry) => entry.action === 'DELETED')?.reason).toBe(DELETE_REASON);
      expect(await addressExposed(page), 'a full address on the page at the end').toBe(false);
    } finally {
      await restoreGlobalState(account.id);
      await admin.close();
    }
  });

  test('a read-only role sees the list without a control; a full ADMIN role gets no routing panel and no reveal', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const account = await createAdmin();
    const root = await Actor.open(browser, 'super', primaryRuntime, { viewport: { width: 1440, height: 1000 } });
    const reader = await createStaffAdmin(['OPERATIONS_SETTINGS_READ', 'OPS_ALERT_RECIPIENTS_READ']);
    const operator = await createStaffAdmin([
      'OPERATIONS_SETTINGS_READ',
      'OPS_ALERT_RECIPIENTS_READ',
      'OPS_ALERT_RECIPIENTS_WRITE',
      'OPS_ALERT_RECIPIENTS_DELETE',
      'OPS_ALERT_RECIPIENTS_TEST',
      // Reserved to SUPER_ADMIN: held through a role, they open nothing.
      'OPS_ALERT_RECIPIENTS_REVEAL',
      'OPS_ALERT_ROUTING_MANAGE',
    ]);
    let readerActor: Actor | null = null;
    let operatorActor: Actor | null = null;

    try {
      readerActor = await Actor.open(browser, 'reader', primaryRuntime, { viewport: { width: 1440, height: 1000 } });
      operatorActor = await Actor.open(browser, 'operator', primaryRuntime, { viewport: { width: 1440, height: 1000 } });
      // A recipient to list, added by the super admin.
      await root.loginToAdmin(account.email, account.password);
      await root.gotoAdmin(`${PATH}?alici=yeni`);
      const form = root.page.getByTestId('ops-alert-recipient-form');
      await waitForHydration(form.getByTestId('ops-alert-form-address'));
      await form.getByTestId('ops-alert-form-address').fill(SECOND_ADDRESS);
      await form.getByTestId('ops-alert-form-label').fill(SECOND_LABEL);
      await settleActionRedirect(root.page, () => form.getByTestId('ops-alert-form-submit').click());
      await expect(root.page.getByTestId('ops-alert-recipient-count')).toHaveText('1/10 alıcı');

      // ---- READ only: the list, and nothing that acts -----------------------
      await readerActor.loginToAdmin(reader.email, reader.password);
      await readerActor.gotoAdmin('/system-health');
      await readerActor.page.getByTestId('system-health-notification-settings-link').click();
      await expect(readerActor.page).toHaveURL((url) => url.pathname === PATH);
      await assertNoErrorScreen(readerActor.page);
      const readerRow = row(readerActor.page, SECOND_LABEL);
      await expect(readerRow.locator('code')).toHaveText('o*************@example.test');
      await expect(readerRow.getByTestId('ops-alert-recipient-actions').locator('a, button')).toHaveCount(0);
      await expect(readerActor.page.getByTestId('ops-alert-recipient-add')).toHaveCount(0);
      await expect(readerActor.page.getByTestId('ops-alert-routing-panel')).toHaveCount(0);
      await expect(readerActor.page.locator('main form')).toHaveCount(0);
      expect(await addressExposed(readerActor.page), 'a full address on the reader page').toBe(false);
      // A typed window URL draws no window either.
      await readerActor.gotoAdmin(`${PATH}?alici=yeni`);
      await expect(readerActor.page.getByTestId('ops-alert-recipient-dialog')).toHaveCount(0);
      await expect(readerActor.page.locator('main form')).toHaveCount(0);

      // ---- every grantable permission: the row actions, still no panel or reveal
      await operatorActor.loginToAdmin(operator.email, operator.password);
      await operatorActor.gotoAdmin(PATH);
      await assertNoErrorScreen(operatorActor.page);
      const operatorRow = row(operatorActor.page, SECOND_LABEL);
      await expect(operatorRow.getByTestId('ops-alert-recipient-edit')).toBeVisible();
      await expect(operatorRow.getByTestId('ops-alert-recipient-test')).toBeVisible();
      await expect(operatorRow.getByTestId('ops-alert-recipient-pause')).toBeVisible();
      await expect(operatorRow.getByTestId('ops-alert-recipient-replace-link')).toBeVisible();
      await expect(operatorRow.getByTestId('ops-alert-recipient-delete-link')).toBeVisible();
      await expect(operatorRow.getByTestId('ops-alert-recipient-reveal')).toHaveCount(0);
      await expect(operatorActor.page.getByTestId('ops-alert-routing-panel')).toHaveCount(0);
      await expect(operatorActor.page.getByTestId('ops-alert-routing-import')).toHaveCount(0);
    } finally {
      await restoreGlobalState(account.id);
      await Promise.all([root.close(), readerActor?.close(), operatorActor?.close()]);
    }
  });

  test('without OPS_ALERT_RECIPIENTS_READ the section is not offered and the page is refused', async ({ browser }) => {
    const staff = await createStaffAdmin(['OPERATIONS_SETTINGS_READ']);
    const admin = await Actor.open(browser, 'staff', primaryRuntime);
    try {
      await admin.loginToAdmin(staff.email, staff.password);
      await admin.gotoAdmin('/system-health');
      await expect(admin.page.getByTestId('system-health-alerts')).toBeVisible();
      await expect(admin.page.getByTestId('system-health-notification-settings-link')).toHaveCount(0);
      await admin.gotoAdmin(PATH);
      await expect(admin.page).toHaveURL(/\/yetkisiz$/);
    } finally {
      await admin.close();
    }
  });
});
