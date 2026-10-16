import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { settleActionRedirect } from '../src/action-redirect';
import { confirmThrough, waitForHydration } from '../src/confirm-dialog';
import {
  createAdmin,
  createCategory,
  createProvider,
  createStaffAdmin,
  creditBalance,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
  type SeededCategory,
  type SeededProvider,
} from '../src/fixtures';
import { fillOfferSchedule } from '../src/journeys';
import { retireShowcasePlacements, seedApprovedShowcaseCard, seedLiveShowcasePlacement } from '../src/showcase-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * SHOWCASE-ALLOWANCE-004 — a super admin voids what is left of a vitrin run's
 * free offers, through the real placement screen and its confirmation; the
 * provider's lead screen and card screen then say so.
 *
 *   A. the dialog states the three figures and what does not happen; the void
 *      lands, the screen shows VOID with who/why/note and the history, and a
 *      provider whose form still showed "0 kredi" is refused with the void's
 *      own 409 sentence — nothing charged — then pays on an explicit retry.
 *   B. the figures moved between the page and the confirm (a lead arrived):
 *      refused, nothing voided; an ADMIN with every vitrin permission never
 *      sees the form at all.
 */

const CATEGORY_COST = 2;
const NOTE = 'E2E iç inceleme: kurgu talep şüphesi.';

type Run = Awaited<ReturnType<typeof seedRun>>;

async function seedRun(owner: SeededProvider, category: SeededCategory, location: ReturnType<typeof uniqueLocation>) {
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: owner.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: `E2E İptal Kartı ${uniqueSuffix()}`,
  });
  const { placement } = await seedLiveShowcasePlacement({
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });
  return { card, version, placement };
}

/** The rows the lead endpoint writes: a gated SUBMITTED request on a DIRECT_SHOWCASE round, and its lead. */
async function seedLead(options: { owner: SeededProvider; category: SeededCategory; location: ReturnType<typeof uniqueLocation>; run: Run }) {
  const db = prisma();
  const now = new Date();
  const request = await db.serviceRequest.create({
    data: {
      categoryId: options.category.id,
      requestNumber: `TR-E2E-${uniqueSuffix()}`,
      customerName: 'E2E Vitrin Müşterisi',
      customerPhone: uniquePhone(),
      customerEmail: `vitrin-iptal-${uniqueSuffix()}@example.test`,
      city: options.location.city,
      district: options.location.district,
      description: 'Vitrin kartından gelen talep.',
      status: 'SUBMITTED',
      directShowcaseProviderId: options.owner.id,
      phoneVerifiedAt: now,
    },
    select: { id: true },
  });
  await db.serviceRequestMatchRound.updateMany({
    where: { requestId: request.id, roundNumber: 1 },
    data: { source: 'DIRECT_SHOWCASE' },
  });
  const lead = await db.showcaseLead.create({
    data: {
      requestId: request.id,
      placementId: options.run.placement.id,
      cardId: options.run.card.id,
      cardVersionId: options.run.version.id,
      kindSnapshot: 'SERVICE',
      listedPriceSnapshot: 150_000,
      providerId: options.owner.id,
      urgencyBucket: 'NORMAL',
      slaHoursSnapshot: 24,
      slaDueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: 'OPEN',
    },
    select: { id: true },
  });
  await db.serviceRequest.update({ where: { id: request.id }, data: { showcaseLeadId: lead.id } });
  return { leadId: lead.id, requestId: request.id };
}

async function grant(placementId: string) {
  return prisma().offerAllowanceGrant.findUniqueOrThrow({
    where: { showcasePlacementId: placementId },
    select: { status: true, quotaTotal: true, quotaUsed: true, voidReason: true, voidNote: true, voidedById: true },
  });
}

async function staff(browser: Parameters<typeof Actor.open>[0], permissions: string[] | 'super') {
  const account = permissions === 'super' ? await createAdmin() : await createStaffAdmin(permissions);
  const actor = await Actor.open(browser, 'staff', primaryRuntime);
  await actor.page.setViewportSize({ width: 1440, height: 1200 });
  await actor.loginToAdmin(account.email, account.password);
  return { actor, account };
}

async function fillVoidForm(actor: Actor) {
  const form = actor.page.getByTestId('placement-allowance-void-form');
  await form.getByTestId('placement-allowance-void-reason-input').selectOption('FRAUD');
  await form.getByTestId('placement-allowance-void-note-input').fill(NOTE);
}

test.describe('vitrin free-offer void (SHOWCASE-ALLOWANCE-004)', () => {
  test('A: the super admin voids through the dialog; the screens say so and a stale free answer is refused, never charged', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 10 });
    const run = await seedRun(owner, category, location);
    const lead = await seedLead({ owner, category, location, run });

    const provider = await Actor.open(browser, 'provider', primaryRuntime);
    const { actor: root, account } = await staff(browser, 'super');
    try {
      // The provider opens the lead while the slot is still free.
      await provider.loginToWeb(owner.email, owner.password);
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/talepler/${lead.leadId}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('lead-offer-cost')).toHaveAttribute('data-credit-cost', '0');

      // ---- the void, through the dialog --------------------------------
      await root.gotoAdmin(`/showcase/placements/${run.placement.id}`);
      await assertNoErrorScreen(root.page);
      await expect(root.page.getByTestId('placement-allowance-open-leads')).toHaveText('1');
      const trigger = root.page.getByTestId('placement-allowance-void');
      await waitForHydration(trigger);
      // No reason and no note: the browser refuses, the dialog never opens.
      await trigger.click();
      await expect(root.page.getByTestId('placement-allowance-void-dialog')).toBeHidden();
      expect((await grant(run.placement.id)).status).toBe('ACTIVE');

      await fillVoidForm(root);
      await settleActionRedirect(root.page, () =>
        confirmThrough(trigger, 'Evet, kalan hakları iptal et', async (dialog) => {
          const impact = dialog.getByTestId('placement-allowance-void-impact');
          await expect(impact).toContainText('Kalan 3 ücretsiz teklif hakkı iptal edilir.');
          await expect(impact).toContainText('Kullanılmış 0 / 3 hak');
          await expect(impact).toContainText('Ücretsiz yanıt bekleyen 1 talep kapanmaz');
          await expect(impact).toContainText('Para iadesi, kredi hareketi veya yerleşim iptali yapılmaz.');
          await expect(impact).toContainText('geri alınamaz');
        }),
      );
      await expect.poll(async () => (await grant(run.placement.id)).status).toBe('VOID');
      expect(await grant(run.placement.id)).toMatchObject({
        quotaTotal: 3,
        quotaUsed: 0,
        voidReason: 'FRAUD',
        voidNote: NOTE,
        voidedById: account.id,
      });
      await assertNoErrorScreen(root.page);
      await expect(root.page.getByTestId('placement-allowance-voided-notice')).toBeVisible();
      await expect(root.page.getByTestId('placement-allowance-status')).toHaveText('İptal edildi');
      await expect(root.page.getByTestId('placement-allowance-void-reason')).toHaveText('Sahte veya kurgu talep');
      await expect(root.page.getByTestId('placement-allowance-void-note')).toContainText(NOTE);
      await expect(root.page.getByTestId('placement-allowance-history-voided')).toContainText('Kalan 3 hak iptal edildi');
      await expect(root.page.getByTestId('placement-allowance-void-form')).toHaveCount(0);
      expect(
        (await prisma().showcasePlacement.findUniqueOrThrow({ where: { id: run.placement.id }, select: { status: true } }))
          .status,
      ).toBe('ACTIVE');
      // One notice owed (and sent by the outbox), whatever the mailbox does.
      await expect
        .poll(() => prisma().notificationLog.count({ where: { template: 'showcase-allowance-voided', providerId: owner.id } }))
        .toBe(1);

      // ---- the provider's stale free answer -----------------------------
      const form = provider.page.locator('form.pdash-form');
      await form.locator('input[name="priceAmount"]').fill('1500,00');
      await fillOfferSchedule(form);
      await form.locator('textarea[name="message"]').fill('Kartta yazan kapsamda, bu hafta.');
      await settleActionRedirect(provider.page, () => provider.page.getByRole('button', { name: /Teklifi gönder/ }).click());
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('lead-offer-cost-changed')).toContainText('ücretsiz teklif hakkı iptal edildi');
      expect(await creditBalance(owner.id)).toBe(10);
      expect(await prisma().offer.count({ where: { requestId: lead.requestId } })).toBe(0);

      const cost = provider.page.getByTestId('lead-offer-cost');
      await expect(cost).toHaveAttribute('data-cost-kind', 'CREDITS');
      await expect(cost).toContainText(`ücretsiz teklif hakkı iptal edildi; bu teklif ${CATEGORY_COST} kredi`);
      await expect(provider.page.getByTestId('lead-offer-allowance-hint')).toContainText('platform tarafından iptal edildi');

      // The explicit paid retry is the consent.
      await form.locator('input[name="priceAmount"]').fill('1500,00');
      await fillOfferSchedule(form);
      await form.locator('textarea[name="message"]').fill('Kartta yazan kapsamda, bu hafta.');
      await settleActionRedirect(provider.page, () => provider.page.getByRole('button', { name: /Teklifi gönder/ }).click());
      await expect(provider.page.getByTestId('lead-offer-sent')).toBeVisible();
      expect(await creditBalance(owner.id)).toBe(10 - CATEGORY_COST);
      expect(await prisma().offerAllowanceUsage.count({ where: { showcaseLeadId: lead.leadId } })).toBe(0);

      // ---- the card screen ---------------------------------------------
      await provider.gotoWeb(`/providers/${owner.id}/vitrin/${run.card.id}`);
      await assertNoErrorScreen(provider.page);
      await expect(provider.page.getByTestId('showcase-free-offers-voided')).toContainText('Ücretsiz teklif hakkınız iptal edildi.');
      await expect(provider.page.getByTestId('showcase-free-offers-remaining')).toHaveCount(0);
      await expect(provider.page.locator('body')).not.toContainText(NOTE);
    } finally {
      await provider.close();
      await root.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });

  test('B: figures that moved since the page are refused, nothing voided; an ADMIN never sees the form', async ({ browser }) => {
    test.setTimeout(150_000);
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const run = await seedRun(owner, category, location);

    const { actor: root } = await staff(browser, 'super');
    const { actor: admin } = await staff(browser, [
      'SHOWCASE_PLACEMENTS_READ',
      'SHOWCASE_PLACEMENTS_MODERATE',
      'SHOWCASE_PLACEMENT_CANCEL',
      'OFFERS_READ',
    ]);
    try {
      await admin.gotoAdmin(`/showcase/placements/${run.placement.id}`);
      await assertNoErrorScreen(admin.page);
      await expect(admin.page.getByTestId('placement-allowance-status')).toHaveText('Geçerli');
      await expect(admin.page.getByTestId('placement-allowance-void-form')).toHaveCount(0);

      await root.gotoAdmin(`/showcase/placements/${run.placement.id}`);
      await expect(root.page.getByTestId('placement-allowance-open-leads')).toHaveText('0');
      // A lead arrives after the page was drawn.
      await seedLead({ owner, category, location, run });

      await fillVoidForm(root);
      const trigger = root.page.getByTestId('placement-allowance-void');
      await settleActionRedirect(root.page, () => confirmThrough(trigger, 'Evet, kalan hakları iptal et'));
      await assertNoErrorScreen(root.page);
      await expect(root.page.getByTestId('placement-error')).toContainText('onaydan sonra değişti');
      expect((await grant(run.placement.id)).status).toBe('ACTIVE');
      expect(await prisma().notificationLog.count({ where: { template: 'showcase-allowance-voided', providerId: owner.id } })).toBe(0);
      // The page now shows the figure the next confirmation will post.
      await expect(root.page.getByTestId('placement-allowance-open-leads')).toHaveText('1');
    } finally {
      await root.close();
      await admin.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });
});
