import {
  AdminPermission,
  CancelWinnerRefundDecision,
  CreditTransactionType,
  ServiceRequestCancelActor,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCampaignFixture, createPromoLotFixture } from './campaign-fixtures';
import {
  createAdminWithPermissions,
  createApprovedRequest,
  createApprovedShowcaseCard,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';
import { gateSwitch, openRefundTicket, paidPurchase, providerAccount, requestOfTicket } from './package-refund-fixtures';

/**
 * API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-002 — the three gaps -001 left open.
 *
 * 1. A campaign redemption's promotion lot balance is the ledger's
 *    (FINANCE_LEDGER_READ), not the campaign desk's.
 * 2. A package refund's linked ticket content (subject, status, topic) is the
 *    support desk's (SUPPORT_READ); the link itself (`supportTicketId`) stays.
 * 3. A staff actor's e-mail — who wrote a note, granted a credit, decided a
 *    review, cancelled a request — is the staff directory's (ADMIN_USERS_READ).
 *    The actor's id and name stay; the audit row is not changed.
 *
 * Absent means absent: the key is not in the body, and the value is nowhere in
 * the serialised JSON. SUPER_ADMIN keeps the whole view.
 */

let ctx: TestContext;
const gate = gateSwitch();

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  gate.remember();
  gate.open();
});

afterEach(() => {
  gate.restore();
});

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

async function superAdminSession() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, user.id);
}

const get = (path: string, cookie: string) => request(ctx.server).get(path).set('Cookie', cookie);

/** A staff member with an address no other fixture uses, so its absence from a body is checkable as a string. */
async function staffActor() {
  const email = `personel-${uniqueSuffix()}@staff.example.test`;
  const actor = await createUser(ctx.prisma, { role: UserRole.ADMIN, email, name: 'Personel Kişi' });
  return { actor, email };
}

// ─────────────────────────── 1. campaign redemptions ───────────────────────────

describe('GET /admin/campaigns/:id/redemptions — promoLot.remainingCredits', () => {
  async function redemptionWorld() {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const lot = await createPromoLotFixture(ctx.prisma, provider.id, { credits: 13 });
    return lot;
  }

  it('leaves the balance out for CAMPAIGNS_READ alone, keeping the lot id, state and expiry', async () => {
    const lot = await redemptionWorld();
    const response = await get(
      `/admin/campaigns/${lot.campaign.id}/redemptions`,
      await sessionWith([AdminPermission.CAMPAIGNS_READ]),
    );

    expect(response.status).toBe(200);
    const row = response.body.items[0];
    expect(row.lot).toBeTruthy();
    expect(row.lot).not.toHaveProperty('remainingCredits');
    expect(Object.keys(row.lot).sort()).toEqual(['expiresAt', 'id', 'status']);
    expect(JSON.stringify(response.body)).not.toContain('remainingCredits');
    // The grant itself is the campaign's own figure.
    expect(row.grantedCredits).toBe(13);
  });

  it('adds the balance for CAMPAIGNS_READ + FINANCE_LEDGER_READ', async () => {
    const lot = await redemptionWorld();
    const response = await get(
      `/admin/campaigns/${lot.campaign.id}/redemptions`,
      await sessionWith([AdminPermission.CAMPAIGNS_READ, AdminPermission.FINANCE_LEDGER_READ]),
    );

    expect(response.status).toBe(200);
    expect(response.body.items[0].lot.remainingCredits).toBe(13);
  });

  it('does not open the balance with FINANCE_READ (the in-finance split is not this change’s)', async () => {
    const lot = await redemptionWorld();
    const response = await get(
      `/admin/campaigns/${lot.campaign.id}/redemptions`,
      await sessionWith([AdminPermission.CAMPAIGNS_READ, AdminPermission.FINANCE_READ]),
    );

    expect(response.body.items[0].lot).not.toHaveProperty('remainingCredits');
  });

  it('refuses FINANCE_LEDGER_READ alone — the route is still the campaign desk’s', async () => {
    const lot = await redemptionWorld();
    const response = await get(
      `/admin/campaigns/${lot.campaign.id}/redemptions`,
      await sessionWith([AdminPermission.FINANCE_LEDGER_READ]),
    );
    expect(response.status).toBe(403);
  });

  it('gives SUPER_ADMIN the balance', async () => {
    const lot = await redemptionWorld();
    const response = await get(`/admin/campaigns/${lot.campaign.id}/redemptions`, await superAdminSession());
    expect(response.body.items[0].lot.remainingCredits).toBe(13);
  });

  it('keeps a lot-less redemption `lot: null` for every viewer', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const { campaign, version } = await createCampaignFixture(ctx.prisma);
    const key = `PROVIDER_APPROVED:${provider.id}:${uniqueSuffix()}`;
    const event = await ctx.prisma.campaignTriggerEvent.create({
      data: { triggerEventKey: key, trigger: 'PROVIDER_APPROVED', providerId: provider.id },
    });
    await ctx.prisma.campaignRedemption.create({
      data: {
        campaignId: campaign.id,
        campaignVersionId: version.id,
        providerId: provider.id,
        trigger: 'PROVIDER_APPROVED',
        triggerEventId: event.id,
        triggerEventKey: key,
        rulesSnapshot: {},
        grantedCredits: 4,
      },
    });

    for (const cookie of [await sessionWith([AdminPermission.CAMPAIGNS_READ]), await superAdminSession()]) {
      const response = await get(`/admin/campaigns/${campaign.id}/redemptions`, cookie);
      expect(response.body.items[0].lot).toBeNull();
    }
  });
});

// ─────────────────────────── 2. package refund detail ───────────────────────────

describe('GET /admin/package-refund-requests/:id — supportTicket', () => {
  async function refundWorld() {
    const account = await providerAccount(ctx);
    const purchase = await paidPurchase(ctx.prisma, { providerId: account.provider.id, userId: account.owner.id });
    const opened = await openRefundTicket(ctx, account.cookie, purchase.id).expect(201);
    const refund = await requestOfTicket(ctx.prisma, opened.body.id);
    const ticket = await ctx.prisma.supportTicket.findUniqueOrThrow({ where: { id: opened.body.id } });
    return { refund, ticket };
  }

  it('keeps the ticket id but leaves its subject, status and topic out for PACKAGE_REFUND_READ alone', async () => {
    const { refund, ticket } = await refundWorld();
    const response = await get(
      `/admin/package-refund-requests/${refund.id}`,
      await sessionWith([AdminPermission.PACKAGE_REFUND_READ]),
    );

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('supportTicket');
    expect(response.body.supportTicketId).toBe(ticket.id);
    expect(JSON.stringify(response.body)).not.toContain(ticket.subject);
  });

  it('adds the ticket block for PACKAGE_REFUND_READ + SUPPORT_READ', async () => {
    const { refund, ticket } = await refundWorld();
    const response = await get(
      `/admin/package-refund-requests/${refund.id}`,
      await sessionWith([AdminPermission.PACKAGE_REFUND_READ, AdminPermission.SUPPORT_READ]),
    );

    expect(response.body.supportTicket).toEqual({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      topic: ticket.topic,
    });
  });

  it('leaves the block out of a write’s response too (take answers with the detail)', async () => {
    const { refund, ticket } = await refundWorld();
    const cookie = await sessionWith([AdminPermission.PACKAGE_REFUND_READ, AdminPermission.PACKAGE_REFUND_REQUEST_CREATE]);
    const response = await request(ctx.server).post(`/admin/package-refund-requests/${refund.id}/take`).set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('supportTicket');
    expect(response.body.supportTicketId).toBe(ticket.id);
    expect(JSON.stringify(response.body)).not.toContain(ticket.subject);
  });

  it('gives SUPER_ADMIN the ticket block', async () => {
    const { refund, ticket } = await refundWorld();
    const response = await get(`/admin/package-refund-requests/${refund.id}`, await superAdminSession());
    expect(response.body.supportTicket.subject).toBe(ticket.subject);
  });
});

// ─────────────────────────── 3. staff actor e-mails ───────────────────────────

describe('staff actor e-mail — ADMIN_USERS_READ', () => {
  /** Asserts the actor block names the person by id and name, and carries the e-mail exactly when `withEmail`. */
  function expectActor(block: Record<string, unknown> | null | undefined, actor: { id: string; name: string | null }, email: string, withEmail: boolean) {
    expect(block).toBeTruthy();
    expect(block!.id).toBe(actor.id);
    expect(block!.name).toBe(actor.name);
    if (withEmail) expect(block!.email).toBe(email);
    else expect(block).not.toHaveProperty('email');
  }

  describe('customer notes', () => {
    async function noteWorld() {
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      const { actor, email } = await staffActor();
      await ctx.prisma.customerNote.create({ data: { customerId: customer.id, note: 'Arandı', createdById: actor.id } });
      return { customer, actor, email };
    }

    it.each([
      ['CUSTOMER_NOTES_READ alone', [AdminPermission.CUSTOMER_NOTES_READ], false],
      ['CUSTOMER_NOTES_READ + ADMIN_USERS_READ', [AdminPermission.CUSTOMER_NOTES_READ, AdminPermission.ADMIN_USERS_READ], true],
    ] as const)('GET /customers/:id/notes — %s', async (_label, permissions, withEmail) => {
      const { customer, actor, email } = await noteWorld();
      const response = await get(`/customers/${customer.id}/notes`, await sessionWith([...permissions]));

      expect(response.status).toBe(200);
      expectActor(response.body.items[0].createdBy, actor, email, withEmail);
      expect(JSON.stringify(response.body).includes(email)).toBe(withEmail);
    });

    it('GET /customers/:id/notes — SUPER_ADMIN sees the e-mail', async () => {
      const { customer, actor, email } = await noteWorld();
      const response = await get(`/customers/${customer.id}/notes`, await superAdminSession());
      expectActor(response.body.items[0].createdBy, actor, email, true);
    });

    it('POST /customers/:id/notes answers with the author by id and name only, without ADMIN_USERS_READ', async () => {
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.CUSTOMER_NOTES_WRITE]);
      const response = await request(ctx.server)
        .post(`/customers/${customer.id}/notes`)
        .set('Cookie', await loginAs(ctx.prisma, admin.id))
        .send({ note: 'Yeni not' });

      expect(response.status).toBe(201);
      expectActor(response.body.createdBy, admin, admin.email!, false);
      // The audit row still names the author.
      const stored = await ctx.prisma.customerNote.findFirstOrThrow({ where: { customerId: customer.id } });
      expect(stored.createdById).toBe(admin.id);
    });
  });

  describe('credit ledger, finance summary and one provider’s credits', () => {
    async function ledgerWorld() {
      const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
      const { actor, email } = await staffActor();
      await ctx.prisma.providerCreditTransaction.create({
        data: {
          providerId: provider.id,
          type: CreditTransactionType.ADMIN_GRANT,
          amount: 5,
          balanceAfter: 5,
          reason: 'Telafi',
          createdById: actor.id,
        },
      });
      return { owner, provider, actor, email };
    }

    it.each([
      ['/finance/credit-ledger', AdminPermission.FINANCE_LEDGER_READ, (body: any) => body.items[0].createdBy],
      ['/finance/summary', AdminPermission.FINANCE_READ, (body: any) => body.recentTransactions[0].createdBy],
    ] as const)('%s leaves the operator e-mail out without ADMIN_USERS_READ and adds it with', async (path, permission, pick) => {
      const { actor, email } = await ledgerWorld();

      const narrow = await get(path, await sessionWith([permission]));
      expect(narrow.status).toBe(200);
      expectActor(pick(narrow.body), actor, email, false);
      expect(JSON.stringify(narrow.body)).not.toContain(email);

      const wide = await get(path, await sessionWith([permission, AdminPermission.ADMIN_USERS_READ]));
      expectActor(pick(wide.body), actor, email, true);

      const root = await get(path, await superAdminSession());
      expectActor(pick(root.body), actor, email, true);
    });

    it('/admin/providers/:id/credits follows the same rule', async () => {
      const { provider, actor, email } = await ledgerWorld();
      const path = `/admin/providers/${provider.id}/credits`;

      const narrow = await get(path, await sessionWith([AdminPermission.FINANCE_LEDGER_READ]));
      expect(narrow.status).toBe(200);
      expectActor(narrow.body.transactions[0].createdBy, actor, email, false);
      expect(JSON.stringify(narrow.body)).not.toContain(email);

      const wide = await get(path, await sessionWith([AdminPermission.FINANCE_LEDGER_READ, AdminPermission.ADMIN_USERS_READ]));
      expectActor(wide.body.transactions[0].createdBy, actor, email, true);
    });

    it('the provider’s own credit routes carry no actor at all; SUPER_ADMIN’s read of them keeps the e-mail', async () => {
      const { owner, provider, actor, email } = await ledgerWorld();
      const own = await loginAs(ctx.prisma, owner.id);
      for (const path of [`/providers/${provider.id}/credits`, `/providers/${provider.id}/credits/transactions`]) {
        const response = await get(path, own);
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain(email);
        expect(JSON.stringify(response.body)).not.toContain('createdBy"');
      }
      const root = await get(`/providers/${provider.id}/credits/transactions`, await superAdminSession());
      expectActor(root.body[0].createdBy, actor, email, true);
    });
  });

  describe('promotion eligibility reviews', () => {
    async function decidedHold() {
      const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
      const { actor, email } = await staffActor();
      const event = await ctx.prisma.campaignTriggerEvent.create({
        data: {
          triggerEventKey: `PROVIDER_APPROVED:${provider.id}`,
          trigger: 'PROVIDER_APPROVED',
          providerId: provider.id,
          status: 'EVALUATED',
        },
      });
      const hold = await ctx.prisma.promotionEligibilityHold.create({
        data: { triggerEventId: event.id, providerId: provider.id, signals: { signals: [] }, snapshotVersion: 1 },
      });
      await ctx.prisma.promotionEligibilityReview.create({
        data: {
          triggerEventId: event.id,
          holdId: hold.id,
          providerId: provider.id,
          decision: 'INELIGIBLE',
          reason: 'Aynı işletmenin ikinci şubesi.',
          decidedById: actor.id,
        },
      });
      return { event, actor, email };
    }

    it.each([
      ['PROMOTION_ELIGIBILITY_REVIEW alone', [AdminPermission.PROMOTION_ELIGIBILITY_REVIEW], false],
      ['+ ADMIN_USERS_READ', [AdminPermission.PROMOTION_ELIGIBILITY_REVIEW, AdminPermission.ADMIN_USERS_READ], true],
    ] as const)('list and detail — %s', async (_label, permissions, withEmail) => {
      const { event, actor, email } = await decidedHold();
      const cookie = await sessionWith([...permissions]);

      const list = await get('/admin/promotion-eligibility/holds?filter=decided', cookie);
      expect(list.status).toBe(200);
      expectActor(list.body.items[0].review.decidedBy, actor, email, withEmail);
      expect(JSON.stringify(list.body).includes(email)).toBe(withEmail);

      const detail = await get(`/admin/promotion-eligibility/holds/${event.id}`, cookie);
      expect(detail.status).toBe(200);
      expectActor(detail.body.review.decidedBy, actor, email, withEmail);
      expect(JSON.stringify(detail.body).includes(email)).toBe(withEmail);
    });

    it('SUPER_ADMIN sees the e-mail', async () => {
      const { event, actor, email } = await decidedHold();
      const detail = await get(`/admin/promotion-eligibility/holds/${event.id}`, await superAdminSession());
      expectActor(detail.body.review.decidedBy, actor, email, true);
    });
  });

  describe('showcase reviews', () => {
    async function reviewedCard() {
      const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
      const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
      const category = await createCategory(ctx.prisma, `Vitrin ${uniqueSuffix()}`);
      const { card, version } = await createApprovedShowcaseCard(ctx.prisma, { providerId: provider.id, categoryId: category.id });
      const { actor, email } = await staffActor();
      await ctx.prisma.showcaseCardReview.create({
        data: { cardVersionId: version.id, decision: 'APPROVED', reviewedById: actor.id },
      });
      return { owner, provider, card, version, actor, email };
    }

    it.each([
      ['SHOWCASE_REVIEW_READ + SHOWCASE_CARDS_READ', [AdminPermission.SHOWCASE_REVIEW_READ, AdminPermission.SHOWCASE_CARDS_READ], false],
      [
        '+ ADMIN_USERS_READ',
        [AdminPermission.SHOWCASE_REVIEW_READ, AdminPermission.SHOWCASE_CARDS_READ, AdminPermission.ADMIN_USERS_READ],
        true,
      ],
    ] as const)('version and card reads — %s', async (_label, permissions, withEmail) => {
      const { card, version, actor, email } = await reviewedCard();
      const cookie = await sessionWith([...permissions]);

      const versions = await get('/admin/showcase/versions?reviewStatus=APPROVED', cookie);
      expect(versions.status).toBe(200);
      expectActor(versions.body[0].review.reviewedBy, actor, email, withEmail);

      const one = await get(`/admin/showcase/versions/${version.id}`, cookie);
      expect(one.status).toBe(200);
      expectActor(one.body.review.reviewedBy, actor, email, withEmail);
      expectActor(one.body.card.liveVersion.review.reviewedBy, actor, email, withEmail);

      const cards = await get('/admin/showcase/cards', cookie);
      expect(cards.status).toBe(200);
      const cardDetail = await get(`/admin/showcase/cards/${card.id}`, cookie);
      expect(cardDetail.status).toBe(200);
      expectActor(cardDetail.body.versions[0].review.reviewedBy, actor, email, withEmail);

      for (const body of [versions.body, one.body, cards.body, cardDetail.body]) {
        expect(JSON.stringify(body).includes(email)).toBe(withEmail);
      }
    });

    it('SUPER_ADMIN sees the e-mail', async () => {
      const { version, actor, email } = await reviewedCard();
      const one = await get(`/admin/showcase/versions/${version.id}`, await superAdminSession());
      expectActor(one.body.review.reviewedBy, actor, email, true);
    });

    it('never carries the reviewer’s e-mail to the provider’s own panel', async () => {
      const { owner, provider, card, actor, email } = await reviewedCard();
      const cookie = await loginAs(ctx.prisma, owner.id);

      const list = await get(`/providers/${provider.id}/showcase/cards`, cookie);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(email);
      expectActor(list.body[0].liveVersion.review.reviewedBy, actor, email, false);

      const one = await get(`/providers/${provider.id}/showcase/cards/${card.id}`, cookie);
      expect(one.status).toBe(200);
      expect(JSON.stringify(one.body)).not.toContain(email);
    });
  });

  describe('request cancellation actor', () => {
    async function cancelledRequest(kind: ServiceRequestCancelActor) {
      const category = await createCategory(ctx.prisma, `İptal ${uniqueSuffix()}`);
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: `musteri-${uniqueSuffix()}@customer.example.test` });
      const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id, customerEmail: null });
      const staff = await staffActor();
      const actor = kind === ServiceRequestCancelActor.STAFF ? staff.actor : customer;
      await ctx.prisma.serviceRequest.update({
        where: { id: serviceRequest.id },
        data: { status: ServiceRequestStatus.CANCELLED, cancelledAt: new Date() },
      });
      await ctx.prisma.serviceRequestCancellation.create({
        data: {
          requestId: serviceRequest.id,
          actorKind: kind,
          actorUserId: actor.id,
          previousStatus: ServiceRequestStatus.APPROVED,
          winnerRefundDecision: CancelWinnerRefundDecision.NOT_MATCHED,
          closedOfferIds: [],
          refundedOfferIds: [],
        },
      });
      return { serviceRequest, actor, email: actor.email! };
    }

    it.each([
      ['REQUESTS_READ alone', [AdminPermission.REQUESTS_READ], false],
      ['REQUESTS_READ + ADMIN_USERS_READ', [AdminPermission.REQUESTS_READ, AdminPermission.ADMIN_USERS_READ], true],
      // The customer's account is not the staff directory: CUSTOMERS_READ opens a customer actor's address, not a staff one's.
      ['REQUESTS_READ + CUSTOMERS_READ', [AdminPermission.REQUESTS_READ, AdminPermission.CUSTOMERS_READ], false],
    ] as const)('staff actor — %s', async (_label, permissions, withEmail) => {
      const { serviceRequest, actor, email } = await cancelledRequest(ServiceRequestCancelActor.STAFF);
      const response = await get(`/service-requests/${serviceRequest.id}`, await sessionWith([...permissions]));

      expect(response.status).toBe(200);
      expectActor(response.body.cancellation.actor, actor, email, withEmail);
      expect(response.body.cancellation.actor.role).toBe(UserRole.ADMIN);
      expect(JSON.stringify(response.body).includes(email)).toBe(withEmail);
    });

    it.each([
      ['REQUESTS_READ alone', [AdminPermission.REQUESTS_READ], false],
      ['REQUESTS_READ + ADMIN_USERS_READ', [AdminPermission.REQUESTS_READ, AdminPermission.ADMIN_USERS_READ], false],
      ['REQUESTS_READ + CUSTOMERS_READ', [AdminPermission.REQUESTS_READ, AdminPermission.CUSTOMERS_READ], true],
    ] as const)('customer actor — %s (the account block’s rule)', async (_label, permissions, withEmail) => {
      const { serviceRequest, actor, email } = await cancelledRequest(ServiceRequestCancelActor.CUSTOMER);
      const response = await get(`/service-requests/${serviceRequest.id}`, await sessionWith([...permissions]));

      expect(response.status).toBe(200);
      expectActor(response.body.cancellation.actor, actor, email, withEmail);
      expect(JSON.stringify(response.body).includes(email)).toBe(withEmail);
    });

    it('SUPER_ADMIN sees either actor’s e-mail', async () => {
      for (const kind of [ServiceRequestCancelActor.STAFF, ServiceRequestCancelActor.CUSTOMER]) {
        const { serviceRequest, actor, email } = await cancelledRequest(kind);
        const response = await get(`/service-requests/${serviceRequest.id}`, await superAdminSession());
        expectActor(response.body.cancellation.actor, actor, email, true);
      }
    });
  });
});
