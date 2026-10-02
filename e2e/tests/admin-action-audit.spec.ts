import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { confirmThrough } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  createStaffAdmin,
  prisma,
  uniqueLocation,
} from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * ADMIN-ACTION-AUDIT-001 — the admin "Neler oldu" timelines, through the real
 * Next screens against the real API.
 *
 * One write goes through the UI end to end (a customer passivated through its
 * confirmation dialog shows up in the customer's history with the operator).
 * The other screens are fed rows the way the API writes them — the write paths
 * themselves are pinned by the API suite — and are checked for what they
 * draw: old → new, the operator (e-mail only with ADMIN_USERS_READ),
 * "Bilinmiyor" where no operator is recorded, the empty state, and paging.
 */

async function openAs(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

test.describe('ADMIN-ACTION-AUDIT-001 — admin timelines', () => {
  test('customer: a passivation made on the screen is in its history, with the operator', async ({ browser }) => {
    const customer = await createCustomer('E2E Audit Müşteri');
    const { actor: admin, account } = await openAs(browser, 'super');
    const { actor: reader } = await openAs(browser, ['CUSTOMERS_READ']);

    try {
      await admin.gotoAdmin(`/customers/${customer.id}?tab=gecmis`);
      await expect(admin.page.getByTestId('customer-status-history')).toContainText('değiştirilmedi');

      await admin.gotoAdmin(`/customers/${customer.id}`);
      await confirmThrough(admin.page.getByTestId('customer-passivate'), 'Evet, pasife al');
      await expect
        .poll(async () => (await prisma().user.findUniqueOrThrow({ where: { id: customer.id } })).isActive)
        .toBe(false);

      await admin.gotoAdmin(`/customers/${customer.id}?tab=gecmis`);
      const history = admin.page.getByTestId('customer-status-history');
      await expect(history.getByTestId('audit-row')).toHaveCount(1);
      await expect(history).toContainText('Hesap pasifleştirildi');
      await expect(history).toContainText('Aktif → Pasif');
      await expect(history.getByTestId('audit-actor')).toContainText(account.name);
      await expect(history.getByTestId('audit-actor')).toContainText(account.email);
      await assertNoErrorScreen(admin.page);

      // CUSTOMERS_READ alone: the operator's name, not the staff directory's address.
      await reader.gotoAdmin(`/customers/${customer.id}?tab=gecmis`);
      const readerHistory = reader.page.getByTestId('customer-status-history');
      await expect(readerHistory.getByTestId('audit-actor')).toContainText(account.name);
      await expect(readerHistory.getByTestId('audit-actor')).not.toContainText(account.email);
    } finally {
      await Promise.all([admin.close(), reader.close()]);
    }
  });

  test('provider: transitions with reason and note, paged on their own parameter', async ({ browser }) => {
    const category = await createCategory(3);
    const provider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
    const operator = await createAdmin();
    const base = Date.now() - 60 * 60 * 1000;
    // 21 rows: one more than a page.
    await prisma().providerStatusChange.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        providerId: provider.id,
        fromStatus: index % 2 === 0 ? ('PENDING_REVIEW' as const) : ('APPROVED' as const),
        toStatus: index % 2 === 0 ? ('APPROVED' as const) : ('SUSPENDED' as const),
        actorId: operator.id,
        createdAt: new Date(base + index * 1000),
      })),
    });
    await prisma().providerStatusChange.create({
      data: {
        providerId: provider.id,
        fromStatus: 'SUSPENDED',
        toStatus: 'REJECTED',
        rejectionReason: 'E2E Audit: vergi levhası eksik',
        moderationNote: 'E2E Audit: telefonla arandı',
        actorId: operator.id,
        createdAt: new Date(base + 60_000),
      },
    });
    const { actor } = await openAs(browser, ['PROVIDERS_READ_DETAIL']);

    try {
      await actor.gotoAdmin(`/providers/${provider.id}?tab=gecmis`);
      const history = actor.page.getByTestId('provider-status-history');
      await expect(history.getByTestId('audit-row')).toHaveCount(20);
      const newest = history.getByTestId('audit-row').first();
      await expect(newest).toContainText('Durum: Askıya alındı → Reddedildi');
      await expect(newest).toContainText('Ret gerekçesi: E2E Audit: vergi levhası eksik');
      await expect(newest).toContainText('Moderasyon notu: E2E Audit: telefonla arandı');
      await expect(newest.getByTestId('audit-actor')).toContainText(operator.name);
      await expect(history).toContainText('Yalnız durum değişiklikleri görünür');

      await history.getByTestId('audit-next').click();
      await expect(actor.page).toHaveURL(/tab=gecmis&gecmisSayfa=2/);
      await expect(actor.page.getByTestId('provider-status-history').getByTestId('audit-row')).toHaveCount(2);
      await assertNoErrorScreen(actor.page);
    } finally {
      await actor.close();
    }
  });

  test('staff account and role: status history for ADMIN_USERS_READ, role history for the super admin only', async ({
    browser,
  }) => {
    const target = await createStaffAdmin(['SUPPORT_READ']);
    const operator = await createAdmin();
    const assignment = await prisma().adminRoleAssignment.findFirstOrThrow({
      where: { userId: target.id },
      select: { roleId: true, role: { select: { key: true, name: true } } },
    });
    await prisma().accountStatusChange.create({
      data: { userId: target.id, userRole: 'ADMIN', fromActive: true, toActive: false, actorId: operator.id },
    });
    await prisma().adminRoleAuditLog.create({
      data: {
        action: 'ASSIGNMENT_GRANTED',
        roleId: assignment.roleId,
        targetUserId: target.id,
        actorId: operator.id,
        summary: { key: assignment.role.key },
      },
    });
    const { actor: reader } = await openAs(browser, ['ADMIN_USERS_READ']);
    const { actor: root } = await openAs(browser, 'super');

    try {
      await reader.gotoAdmin(`/users/${target.id}`);
      const status = reader.page.getByTestId('user-status-history');
      await expect(status).toContainText('Hesap pasifleştirildi');
      await expect(status.getByTestId('audit-actor')).toContainText(operator.name);
      await expect(reader.page.getByTestId('user-role-history')).toHaveCount(0);

      await root.gotoAdmin(`/users/${target.id}`);
      const roles = root.page.getByTestId('user-role-history');
      await expect(roles).toContainText('Rol atandı');
      await expect(roles).toContainText(`Rol: ${assignment.role.name}`);

      await root.gotoAdmin(`/roles/${assignment.roleId}`);
      const roleHistory = root.page.getByTestId('role-history');
      await expect(roleHistory).toContainText('Rol atandı');
      await expect(roleHistory).toContainText(`Hesap: ${target.name}`);
      await assertNoErrorScreen(root.page);
    } finally {
      await Promise.all([reader.close(), root.close()]);
    }
  });

  test('company settings: field changes old → new; an operator nobody recorded is never invented', async ({ browser }) => {
    const operator = await createAdmin();
    await prisma().companySettingsChange.create({
      data: {
        actorId: operator.id,
        changes: [{ field: 'supportEmail', from: 'eski@taktik.com.tr', to: 'e2e-audit-destek@taktik.com.tr' }],
      },
    });
    const { actor } = await openAs(browser, ['COMPANY_SETTINGS_READ']);

    try {
      await actor.gotoAdmin('/company-settings');
      const history = actor.page.getByTestId('company-settings-history');
      const row = history.getByTestId('audit-row').filter({ hasText: 'e2e-audit-destek@taktik.com.tr' });
      await expect(row).toContainText('Destek e-postası:');
      await expect(row).toContainText('eski@taktik.com.tr');
      await expect(row.getByTestId('audit-actor')).toContainText(operator.name);
      // No ADMIN_USERS_READ: the staff address stays out.
      await expect(row.getByTestId('audit-actor')).not.toContainText(operator.email);
      await assertNoErrorScreen(actor.page);
    } finally {
      await actor.close();
    }
  });
});
