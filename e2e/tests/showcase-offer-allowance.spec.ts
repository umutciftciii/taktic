import { expect, test } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import { settleActionRedirect } from '../src/action-redirect';
import {
  createAdmin,
  createCategory,
  createCustomer,
  createProvider,
  creditBalance,
  prisma,
  uniqueLocation,
  uniquePhone,
  uniqueSuffix,
  type SeededCategory,
  type SeededCustomer,
  type SeededProvider,
} from '../src/fixtures';
import { acceptOffer, approveRequest, fillOfferSchedule, matchingRequestIds, submitOffer } from '../src/journeys';
import { retireShowcasePlacements, seedApprovedShowcaseCard, seedLiveShowcasePlacement } from '../src/showcase-fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the bounded vitrin offer allowance, on the
 * provider's real lead screen.
 *
 *   A. a fresh run: "3 / 3", the cost is 0, the answer spends one slot.
 *   B. the slots are spent: the category price is shown and charged, and the
 *      paid answer still marks the lead ANSWERED.
 *   C. the last slot goes to another answer while the form is open: the
 *      submit is refused with the changed price, the screen shows the new one,
 *      and only an explicit second submit charges it.
 *   D. no slots and no credits: the screen says so before the submit, and the
 *      402 lands back as a sentence.
 *   E. REL-002: the failed direct match's slot stays spent; Round 2 is the
 *      marketplace and a market provider pays the ordinary price.
 *   F. SHOWCASE-ALLOWANCE-001: a package sold with 5 free offers — the shop,
 *      the lead screen and the card screen all say 5, never a fixed 3.
 *
 * Leads are seeded straight into the tables (the phone-verified lead journey
 * is showcase-placement-lead.spec.ts's subject); the cost line, the submit and
 * what the API did with it are this file's.
 */

const CATEGORY_COST = 2;

type Run = Awaited<ReturnType<typeof seedRun>>;

async function seedRun(
  owner: SeededProvider,
  category: SeededCategory,
  location: ReturnType<typeof uniqueLocation>,
  freeOfferCount?: number,
) {
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: owner.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: `E2E Hak Kartı ${uniqueSuffix()}`,
  });
  const { placement } = await seedLiveShowcasePlacement({
    providerId: owner.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    freeOfferCount,
  });
  return { card, version, placement };
}

/** The rows the lead endpoint writes: a gated SUBMITTED request on a DIRECT_SHOWCASE round, and its lead. */
async function seedLead(options: {
  owner: SeededProvider;
  category: SeededCategory;
  location: ReturnType<typeof uniqueLocation>;
  run: Run;
  customer?: SeededCustomer;
}) {
  const db = prisma();
  const now = new Date();
  const request = await db.serviceRequest.create({
    data: {
      categoryId: options.category.id,
      customerId: options.customer?.id ?? null,
      requestNumber: `TR-E2E-${uniqueSuffix()}`,
      customerName: options.customer?.name ?? 'E2E Vitrin Müşterisi',
      customerPhone: uniquePhone(),
      customerEmail: options.customer?.email ?? `vitrin-hak-${uniqueSuffix()}@example.test`,
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

async function setQuotaUsed(placementId: string, quotaUsed: number) {
  await prisma().offerAllowanceGrant.update({ where: { showcasePlacementId: placementId }, data: { quotaUsed } });
}

async function grant(placementId: string) {
  return prisma().offerAllowanceGrant.findUniqueOrThrow({
    where: { showcasePlacementId: placementId },
    select: { quotaTotal: true, quotaUsed: true },
  });
}

async function openLead(actor: Actor, owner: SeededProvider, leadId: string) {
  await actor.gotoWeb(`/providers/${owner.id}/vitrin/talepler/${leadId}`);
  await assertNoErrorScreen(actor.page);
  await expect(actor.page.getByTestId('lead-offer-cost')).toBeVisible();
}

async function fillLeadOffer(actor: Actor) {
  const form = actor.page.locator('form.pdash-form');
  await form.locator('input[name="priceAmount"]').fill('1500,00');
  await fillOfferSchedule(form);
  await form.locator('textarea[name="message"]').fill('Kartta yazan kapsamda, bu hafta.');
}

async function submitLeadOffer(actor: Actor) {
  await settleActionRedirect(actor.page, () =>
    actor.page.getByRole('button', { name: /Teklifi gönder/ }).click(),
  );
  await assertNoErrorScreen(actor.page);
}

test.describe('vitrin free-offer allowance (CAMPAIGN-ENTITLEMENT-001)', () => {
  test('A: a fresh run shows 3 free offers; the first answer costs 0 and leaves 2', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const run = await seedRun(owner, category, location);
    const first = await seedLead({ owner, category, location, run });
    const second = await seedLead({ owner, category, location, run });

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await actor.loginToWeb(owner.email, owner.password);
      await openLead(actor, owner, first.leadId);
      const cost = actor.page.getByTestId('lead-offer-cost');
      await expect(cost).toHaveAttribute('data-cost-kind', 'SHOWCASE_ALLOWANCE');
      await expect(cost).toContainText('Bu teklif vitrin hakkınızdan düşecek — 0 kredi');
      await expect(actor.page.getByTestId('lead-offer-allowance')).toContainText('3 / 3');
      await expect(actor.page.getByText('3 ücretsiz teklif hakkınız bulunur', { exact: false })).toBeVisible();

      // The cost line on a phone: no horizontal overflow at 320px.
      const viewport = actor.page.viewportSize();
      await actor.page.setViewportSize({ width: 320, height: 800 });
      await expect(cost).toBeVisible();
      const overflow = await actor.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'lead page wider than a 320px phone').toBeLessThanOrEqual(0);
      if (viewport) await actor.page.setViewportSize(viewport);

      await fillLeadOffer(actor);
      await submitLeadOffer(actor);
      await expect(actor.page.getByTestId('lead-offer-sent')).toContainText('Vitrin ücretsiz teklif hakkınızdan karşılandı');

      expect(await grant(run.placement.id)).toEqual({ quotaTotal: 3, quotaUsed: 1 });
      expect(await prisma().offerAllowanceUsage.count({ where: { showcaseLeadId: first.leadId } })).toBe(1);
      expect(await creditBalance(owner.id)).toBe(0);

      await openLead(actor, owner, second.leadId);
      await expect(actor.page.getByTestId('lead-offer-allowance')).toContainText('2 / 3');
    } finally {
      await actor.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });

  test('B: with the slots spent the category price is shown and charged, and the lead is ANSWERED', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 10 });
    const run = await seedRun(owner, category, location);
    await setQuotaUsed(run.placement.id, 3);
    const lead = await seedLead({ owner, category, location, run });

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await actor.loginToWeb(owner.email, owner.password);
      await openLead(actor, owner, lead.leadId);
      const cost = actor.page.getByTestId('lead-offer-cost');
      await expect(cost).toHaveAttribute('data-cost-kind', 'CREDITS');
      await expect(cost).toContainText(`bu teklif ${CATEGORY_COST} kredi`);
      await expect(actor.page.getByTestId('lead-offer-allowance')).toContainText('0 / 3');
      await expect(actor.page.getByRole('button', { name: `Teklifi gönder (${CATEGORY_COST} kredi)` })).toBeVisible();

      await fillLeadOffer(actor);
      await submitLeadOffer(actor);
      await expect(actor.page.getByTestId('lead-offer-sent')).toBeVisible();

      expect(await creditBalance(owner.id)).toBe(10 - CATEGORY_COST);
      const row = await prisma().showcaseLead.findUniqueOrThrow({ where: { id: lead.leadId }, select: { status: true } });
      expect(row.status).toBe('ANSWERED');
      expect(await grant(run.placement.id)).toEqual({ quotaTotal: 3, quotaUsed: 3 });
    } finally {
      await actor.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });

  test('C: the last slot goes elsewhere while the form is open — 409 with the new price, then an explicit paid submit', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 10 });
    const run = await seedRun(owner, category, location);
    await setQuotaUsed(run.placement.id, 2);
    const lead = await seedLead({ owner, category, location, run });

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await actor.loginToWeb(owner.email, owner.password);
      await openLead(actor, owner, lead.leadId);
      await expect(actor.page.getByTestId('lead-offer-cost')).toHaveAttribute('data-credit-cost', '0');
      await expect(actor.page.getByTestId('lead-offer-allowance')).toContainText('1 / 3');

      // Another answer takes the last slot while this form is open.
      await setQuotaUsed(run.placement.id, 3);

      await fillLeadOffer(actor);
      await submitLeadOffer(actor);
      const alert = actor.page.getByTestId('lead-offer-cost-changed');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('bu teklifin maliyeti değişti');
      await expect(actor.page.getByRole('button', { name: /Teklifi gönder/ })).toHaveAttribute(
        'aria-describedby',
        'lead-offer-error',
      );
      // Nothing was charged and nothing was offered.
      expect(await creditBalance(owner.id)).toBe(10);
      expect(await prisma().offer.count({ where: { requestId: lead.requestId } })).toBe(0);

      // The re-rendered form carries the new price; submitting it again is the consent.
      const cost = actor.page.getByTestId('lead-offer-cost');
      await expect(cost).toHaveAttribute('data-cost-kind', 'CREDITS');
      await expect(cost).toHaveAttribute('data-credit-cost', String(CATEGORY_COST));
      await fillLeadOffer(actor);
      await submitLeadOffer(actor);
      await expect(actor.page.getByTestId('lead-offer-sent')).toBeVisible();
      expect(await creditBalance(owner.id)).toBe(10 - CATEGORY_COST);
    } finally {
      await actor.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });

  test('D: no slots and no credits — said before the submit, and the 402 lands as a sentence', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const run = await seedRun(owner, category, location);
    await setQuotaUsed(run.placement.id, 3);
    const lead = await seedLead({ owner, category, location, run });

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await actor.loginToWeb(owner.email, owner.password);
      await openLead(actor, owner, lead.leadId);
      const cost = actor.page.getByTestId('lead-offer-cost');
      await expect(cost).toHaveAttribute('data-cost-kind', 'INSUFFICIENT_CREDITS');
      await expect(cost).toContainText('bakiyeniz yetersiz');

      await fillLeadOffer(actor);
      await submitLeadOffer(actor);
      await expect(actor.page.getByTestId('lead-offer-insufficient')).toBeVisible();
      await expect(actor.page.getByTestId('lead-offer-insufficient').getByRole('link', { name: 'Kredi yükleyin' })).toBeVisible();
      expect(await prisma().offer.count({ where: { requestId: lead.requestId } })).toBe(0);
      const row = await prisma().showcaseLead.findUniqueOrThrow({ where: { id: lead.leadId }, select: { status: true } });
      expect(row.status).toBe('OPEN');
    } finally {
      await actor.close();
      await retireShowcasePlacements([run.placement.id]);
    }
  });

  test('E: REL-002 — the failed direct match keeps its slot spent; Round 2 is the marketplace at the ordinary price', async ({ browser }) => {
    await prisma().operationsSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        unviewedOfferRefundWindowHours: 48,
        serviceIssueReportingEnabled: true,
        marketplaceAutoPublishEnabled: false,
      },
      update: { serviceIssueReportingEnabled: true, marketplaceAutoPublishEnabled: false },
    });
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const customerAccount = await createCustomer();
    const adminAccount = await createAdmin();
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const market = await createProvider({ categoryId: category.id, location, credits: 10 });
    const run = await seedRun(owner, category, location);
    const lead = await seedLead({ owner, category, location, run, customer: customerAccount });

    const ownerActor = await Actor.open(browser, 'provider', primaryRuntime);
    const customer = await Actor.open(browser, 'customer', primaryRuntime);
    const admin = await Actor.open(browser, 'admin', primaryRuntime);
    const marketActor = await Actor.open(browser, 'provider-b', primaryRuntime);
    try {
      // R1: the owner answers for free.
      await ownerActor.loginToWeb(owner.email, owner.password);
      await openLead(ownerActor, owner, lead.leadId);
      await fillLeadOffer(ownerActor);
      await submitLeadOffer(ownerActor);
      await expect(ownerActor.page.getByTestId('lead-offer-sent')).toBeVisible();
      const offer = await prisma().offer.findFirstOrThrow({ where: { requestId: lead.requestId }, select: { id: true } });

      // The customer accepts; the promised start passes; the customer reports a no-show.
      await customer.loginToWeb(customerAccount.email, customerAccount.password);
      await acceptOffer(customer, lead.requestId, offer.id);
      const day = (offset: number) => {
        const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
        return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
      };
      await prisma().offer.update({
        where: { id: offer.id },
        data: { estimatedStartDate: day(-2), estimatedCompletionDate: day(3) },
      });
      await customer.gotoWeb(`/requests/${lead.requestId}/offers`);
      await customer.page.getByTestId('service-issue-open').click();
      const dialog = customer.page.getByTestId('service-issue-dialog');
      await dialog.getByTestId('service-issue-reason-PROVIDER_NO_SHOW').click();
      await dialog.getByTestId('service-issue-submit').click();
      await expect(customer.page.getByTestId('service-issue-outcome')).toBeVisible();

      // The slot stays spent and nothing was refunded.
      expect(await grant(run.placement.id)).toEqual({ quotaTotal: 3, quotaUsed: 1 });
      expect(await prisma().providerCreditTransaction.count({ where: { providerId: owner.id, type: 'OFFER_REFUND' } })).toBe(0);
      const row = await prisma().serviceRequest.findUniqueOrThrow({
        where: { id: lead.requestId },
        select: { directShowcaseProviderId: true, currentRound: { select: { roundNumber: true, source: true } } },
      });
      expect(row).toEqual({ directShowcaseProviderId: null, currentRound: { roundNumber: 2, source: 'MARKETPLACE' } });

      // R2: moderation approves it; a market provider pays the ordinary price.
      await admin.loginToAdmin(adminAccount.email, adminAccount.password);
      await approveRequest(admin, lead.requestId);
      await marketActor.loginToWeb(market.email, market.password);
      expect(await matchingRequestIds(marketActor, market.id)).toContain(lead.requestId);
      await submitOffer(marketActor, {
        providerId: market.id,
        requestId: lead.requestId,
        expectedCreditCost: CATEGORY_COST,
        priceAmount: '1.800,00',
        message: 'İkinci turda teklifimiz.',
      });
      expect(await creditBalance(market.id)).toBe(10 - CATEGORY_COST);
      expect(await prisma().offerAllowanceUsage.count({ where: { requestId: lead.requestId } })).toBe(1);
      expect(await grant(run.placement.id)).toEqual({ quotaTotal: 3, quotaUsed: 1 });
    } finally {
      await Promise.all([ownerActor.close(), customer.close(), admin.close(), marketActor.close()]);
      await retireShowcasePlacements([run.placement.id]);
      await prisma().operationsSettings.update({
        where: { id: 'singleton' },
        data: { serviceIssueReportingEnabled: false },
      });
    }
  });

  test('F: a package with 5 free offers says 5 in the shop, on the lead and on the card', async ({ browser }) => {
    const location = uniqueLocation();
    const category = await createCategory(CATEGORY_COST);
    const owner = await createProvider({ categoryId: category.id, location, credits: 0 });
    const run = await seedRun(owner, category, location, 5);
    const lead = await seedLead({ owner, category, location, run });
    const shopPackage = await prisma().showcasePackage.create({
      data: {
        name: `E2E Yedi Haklı ${uniqueSuffix()}`,
        slug: `vitrin-e2e-yedi-${uniqueSuffix()}`.toLowerCase(),
        priceAmount: 59_900,
        currency: 'TRY',
        durationDays: 30,
        freeOfferCount: 7,
      },
    });

    const actor = await Actor.open(browser, 'provider', primaryRuntime);
    try {
      await actor.loginToWeb(owner.email, owner.password);

      // The shop: each package states its own count.
      await actor.gotoWeb(`/providers/${owner.id}/vitrin/paketler`);
      await assertNoErrorScreen(actor.page);
      const option = actor.page.getByTestId('showcase-package-option').filter({ hasText: shopPackage.name });
      await expect(option.getByTestId('showcase-package-free-offers')).toContainText('7 ücretsiz teklif hakkı');
      await expect(actor.page.getByTestId('showcase-package-offer-allowance')).not.toContainText('3 ücretsiz');

      // The lead: the run's own count.
      await openLead(actor, owner, lead.leadId);
      await expect(actor.page.getByTestId('lead-offer-allowance')).toContainText('5 / 5');
      await expect(actor.page.getByTestId('lead-offer-allowance-hint')).toContainText('5 ücretsiz teklif hakkınız bulunur');

      await fillLeadOffer(actor);
      await submitLeadOffer(actor);
      await expect(actor.page.getByTestId('lead-offer-sent')).toContainText('Vitrin ücretsiz teklif hakkınızdan karşılandı');
      expect(await grant(run.placement.id)).toEqual({ quotaTotal: 5, quotaUsed: 1 });
      expect(await creditBalance(owner.id)).toBe(0);

      // The card: what is left of this run's count.
      await actor.gotoWeb(`/providers/${owner.id}/vitrin/${run.card.id}`);
      await assertNoErrorScreen(actor.page);
      await expect(actor.page.getByTestId('showcase-free-offers-remaining')).toContainText('4 / 5');
    } finally {
      await actor.close();
      await retireShowcasePlacements([run.placement.id]);
      await prisma().showcasePackage.update({ where: { id: shopPackage.id }, data: { isActive: false } });
    }
  });
});
