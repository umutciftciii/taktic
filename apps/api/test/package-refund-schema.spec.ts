import {
  PackageRefundRequestOrigin,
  PaymentWebhookEventStatus,
  Prisma,
  SupportTicketRequesterRole,
  SupportTicketTopic,
  UserRole,
} from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, resetDatabase, uniqueSuffix, type TestContext } from './harness';
import { gateSwitch, paidPurchase, providerAccount } from './package-refund-fixtures';

/**
 * CMP-006 PR-B — Migration J holds on its own, against writes that skip the
 * service entirely. Each case is a statement the service would never issue;
 * the database must refuse it anyway.
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

const ELIGIBILITY = { recommendation: 'REFUNDABLE' } as Prisma.InputJsonValue;

async function base() {
  const account = await providerAccount(ctx);
  const purchase = await paidPurchase(ctx.prisma, { providerId: account.provider.id, userId: account.owner.id });
  const ticket = await ctx.prisma.supportTicket.create({
    data: {
      requesterId: account.owner.id,
      requesterRole: SupportTicketRequesterRole.PROVIDER,
      topic: SupportTicketTopic.PACKAGE_AND_CREDIT_REFUND,
      subject: 'İade',
    },
  });
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const second = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return { ...account, purchase, ticket, admin, second };
}

function insert(fixture: Awaited<ReturnType<typeof base>>, overrides: Record<string, unknown> = {}) {
  return ctx.prisma.packageRefundRequest.create({
    data: {
      supportTicketId: fixture.ticket.id,
      purchaseId: fixture.purchase.id,
      providerId: fixture.provider.id,
      origin: PackageRefundRequestOrigin.PROVIDER,
      createdById: fixture.owner.id,
      submittedEligibility: ELIGIBILITY,
      submittedRecommendation: 'REFUNDABLE',
      ...overrides,
    } as Prisma.PackageRefundRequestUncheckedCreateInput,
  });
}

async function underReview(fixture: Awaited<ReturnType<typeof base>>) {
  const row = await insert(fixture);
  return ctx.prisma.packageRefundRequest.update({
    where: { id: row.id },
    data: { status: 'UNDER_REVIEW', reviewStartedById: fixture.admin.id, reviewStartedAt: new Date() },
  });
}

async function webhookEvent() {
  return ctx.prisma.paymentWebhookEvent.create({
    data: {
      provider: 'lemon-squeezy-test',
      eventKey: `order_refunded:orders:${uniqueSuffix()}`,
      eventName: 'order_refunded',
      status: PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED,
    },
  });
}

describe('birth', () => {
  it('a request is born SUBMITTED and undecided', async () => {
    const fixture = await base();
    await expect(insert(fixture, { status: 'UNDER_REVIEW', reviewStartedById: fixture.admin.id, reviewStartedAt: new Date() })).rejects.toThrow(/SUBMITTED/);
    await expect(insert(fixture, { status: 'SETTLED' })).rejects.toThrow();
  });

  it('a request cannot link another provider’s purchase, or a customer’s ticket', async () => {
    const fixture = await base();
    const other = await providerAccount(ctx);
    const theirs = await paidPurchase(ctx.prisma, { providerId: other.provider.id, userId: other.owner.id });
    await expect(insert(fixture, { purchaseId: theirs.id })).rejects.toThrow(/own purchase/);

    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerTicket = await ctx.prisma.supportTicket.create({
      data: { requesterId: customer.id, requesterRole: SupportTicketRequesterRole.CUSTOMER, subject: 'x' },
    });
    await expect(insert(fixture, { supportTicketId: customerTicket.id })).rejects.toThrow(/own purchase/);
  });

  it('a purchase without purchase-terms evidence can never enter the flow', async () => {
    const fixture = await base();
    const legacy = await paidPurchase(ctx.prisma, {
      providerId: fixture.provider.id,
      userId: fixture.owner.id,
      evidence: false,
    });
    await expect(insert(fixture, { purchaseId: legacy.id })).rejects.toThrow(/purchase-terms evidence/);
  });

  it('a customer ticket cannot carry the refund topic', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await expect(
      ctx.prisma.supportTicket.create({
        data: {
          requesterId: customer.id,
          requesterRole: SupportTicketRequesterRole.CUSTOMER,
          topic: SupportTicketTopic.PACKAGE_AND_CREDIT_REFUND,
          subject: 'x',
        },
      }),
    ).rejects.toThrow(/SupportTicket_refund_topic_provider_only/);
  });

  it('one open request per purchase, whatever ticket it is on', async () => {
    const fixture = await base();
    await insert(fixture);
    const otherTicket = await ctx.prisma.supportTicket.create({
      data: { requesterId: fixture.owner.id, requesterRole: SupportTicketRequesterRole.PROVIDER, subject: 'y' },
    });
    await expect(insert(fixture, { supportTicketId: otherTicket.id })).rejects.toThrow(/Unique constraint|one_open_per_purchase/);
  });

  it('no clawback in this slice', async () => {
    const fixture = await base();
    await expect(insert(fixture, { creditClawbackCredits: 1 })).rejects.toThrow(/PackageRefundRequest_no_clawback/);
  });
});

describe('the state machine, in the database', () => {
  it('SUBMITTED cannot jump to SETTLED or to an approval', async () => {
    const fixture = await base();
    const row = await insert(fixture);
    const event = await webhookEvent();
    await expect(
      ctx.prisma.packageRefundRequest.update({
        where: { id: row.id },
        data: { status: 'SETTLED', settledAt: new Date(), settledByWebhookEventId: event.id },
      }),
    ).rejects.toThrow(/cannot move from SUBMITTED to SETTLED/);
  });

  it('SETTLED needs the webhook event; an admin-shaped "settled" with none is refused', async () => {
    const fixture = await base();
    const row = await underReview(fixture);
    await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: {
        status: 'APPROVED_PENDING_SETTLEMENT',
        approvalKind: 'NORMAL',
        approvalEligibility: ELIGIBILITY,
        approvedById: fixture.admin.id,
        approvedAt: new Date(),
      },
    });
    await expect(
      ctx.prisma.packageRefundRequest.update({
        where: { id: row.id },
        data: { status: 'SETTLED', settledAt: new Date() },
      }),
    ).rejects.toThrow(/PackageRefundRequest_settled_by_webhook/);
  });

  it('one webhook event settles at most one request', async () => {
    const first = await base();
    const second = await base();
    const event = await webhookEvent();
    for (const fixture of [first, second]) {
      const row = await underReview(fixture);
      await ctx.prisma.packageRefundRequest.update({
        where: { id: row.id },
        data: {
          status: 'APPROVED_PENDING_SETTLEMENT',
          approvalKind: 'NORMAL',
          approvalEligibility: ELIGIBILITY,
          approvedById: fixture.admin.id,
          approvedAt: new Date(),
        },
      });
    }
    const rows = await ctx.prisma.packageRefundRequest.findMany({ orderBy: { createdAt: 'asc' } });
    await ctx.prisma.packageRefundRequest.update({
      where: { id: rows[0]!.id },
      data: { status: 'SETTLED', settledAt: new Date(), settledByWebhookEventId: event.id },
    });
    await expect(
      ctx.prisma.packageRefundRequest.update({
        where: { id: rows[1]!.id },
        data: { status: 'SETTLED', settledAt: new Date(), settledByWebhookEventId: event.id },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('maker-checker: an exception approver equal to the reviewer or opener, or NULL, is refused', async () => {
    const fixture = await base();
    const row = await underReview(fixture);
    const exception = {
      status: 'APPROVED_PENDING_SETTLEMENT' as const,
      approvalKind: 'EXCEPTION' as const,
      exceptionGround: 'DUPLICATE_CHARGE' as const,
      exceptionReason: 'Aynı tutar iki kez çekildi.',
      approvalEligibility: ELIGIBILITY,
      approvedAt: new Date(),
    };
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { ...exception, approvedById: fixture.admin.id } }),
    ).rejects.toThrow(/maker_checker/);
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { ...exception, approvedById: fixture.owner.id } }),
    ).rejects.toThrow(/maker_checker/);
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { ...exception, approvedById: null } }),
    ).rejects.toThrow(/PackageRefundRequest_(approval_shape|exception_maker_checker)/);

    // Raw SQL, to be sure nothing in the client is doing the refusing.
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE "PackageRefundRequest" SET "reviewStartedById" = NULL, "reviewStartedAt" = NULL WHERE "id" = $1`,
        row.id,
      ),
    ).rejects.toThrow(/reviewed_states/);

    await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: { ...exception, approvedById: fixture.second.id },
    });
  });

  it('an exception without a ground or a real reason is refused', async () => {
    const fixture = await base();
    const row = await underReview(fixture);
    await expect(
      ctx.prisma.packageRefundRequest.update({
        where: { id: row.id },
        data: {
          status: 'APPROVED_PENDING_SETTLEMENT',
          approvalKind: 'EXCEPTION',
          exceptionReason: '   kısa   ',
          exceptionGround: 'STATUTORY_RIGHT',
          approvalEligibility: ELIGIBILITY,
          approvedById: fixture.second.id,
          approvedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/exception_shape/);
  });

  it('a terminal row is frozen whole, and nothing is ever deleted', async () => {
    const fixture = await base();
    const row = await insert(fixture);
    await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { status: 'SUBMITTED', withdrawnAt: null } }),
    ).rejects.toThrow(/terminal/);
    await expect(ctx.prisma.packageRefundRequest.delete({ where: { id: row.id } })).rejects.toThrow(/terminal|never deleted/);

    const open = await base();
    const live = await insert(open);
    await expect(ctx.prisma.packageRefundRequest.delete({ where: { id: live.id } })).rejects.toThrow(/never deleted/);
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: live.id }, data: { purchaseId: open.purchase.id + 'x' } }),
    ).rejects.toThrow();
  });

  it('an approved request cannot be withdrawn', async () => {
    const fixture = await base();
    const row = await underReview(fixture);
    await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: {
        status: 'APPROVED_PENDING_SETTLEMENT',
        approvalKind: 'NORMAL',
        approvalEligibility: ELIGIBILITY,
        approvedById: fixture.admin.id,
        approvedAt: new Date(),
      },
    });
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { status: 'WITHDRAWN', withdrawnAt: new Date() } }),
    ).rejects.toThrow(/cannot move from APPROVED_PENDING_SETTLEMENT to WITHDRAWN/);
  });
});

describe('the audit trail', () => {
  it('is append-only, and a webhook row names no person while a person’s row names no event', async () => {
    const fixture = await base();
    const row = await insert(fixture);
    const entry = await ctx.prisma.packageRefundRequestEvent.create({
      data: { requestId: row.id, action: 'SUBMITTED', toStatus: 'SUBMITTED', actorKind: 'PROVIDER', actorId: fixture.owner.id },
    });
    await expect(
      ctx.prisma.packageRefundRequestEvent.update({ where: { id: entry.id }, data: { note: 'değiştirildi' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.packageRefundRequestEvent.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);

    const event = await webhookEvent();
    await expect(
      ctx.prisma.packageRefundRequestEvent.create({
        data: {
          requestId: row.id,
          action: 'SETTLED',
          toStatus: 'SETTLED',
          actorKind: 'PAYMENT_WEBHOOK',
          actorId: fixture.admin.id,
          webhookEventId: event.id,
        },
      }),
    ).rejects.toThrow(/actor_shape/);
    await expect(
      ctx.prisma.packageRefundRequestEvent.create({
        data: { requestId: row.id, action: 'SETTLED', toStatus: 'SETTLED', actorKind: 'ADMIN', actorId: fixture.admin.id },
      }),
    ).rejects.toThrow(/actor_shape/);
  });
});

describe('webhook-recorded failures and the provider order total', () => {
  async function approved(fixture: Awaited<ReturnType<typeof base>>) {
    const row = await underReview(fixture);
    return ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: {
        status: 'APPROVED_PENDING_SETTLEMENT',
        approvalKind: 'NORMAL',
        approvalEligibility: ELIGIBILITY,
        approvedById: fixture.admin.id,
        approvedAt: new Date(),
      },
    });
  }

  it('a SETTLEMENT_FAILED names exactly one cause: the operator or the webhook', async () => {
    const fixture = await base();
    const row = await approved(fixture);
    const event = await webhookEvent();
    const failure = {
      status: 'SETTLEMENT_FAILED' as const,
      settlementFailedAt: new Date(),
      settlementFailureReason: 'Dış iade tutarı paketin tamamıyla uyuşmadı.',
    };
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: failure }),
    ).rejects.toThrow(/settlement_failed_shape/);
    await expect(
      ctx.prisma.packageRefundRequest.update({
        where: { id: row.id },
        data: { ...failure, settlementFailedById: fixture.admin.id, settlementFailedByWebhookEventId: event.id },
      }),
    ).rejects.toThrow(/settlement_failed_shape/);
    await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: { ...failure, settlementFailedByWebhookEventId: event.id },
    });
  });

  it('SETTLEMENT_FAILED is unfinished: it may become SETTLED (keeping its failure record) and nothing else', async () => {
    const fixture = await base();
    const row = await approved(fixture);
    const failedBy = await webhookEvent();
    await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: {
        status: 'SETTLEMENT_FAILED',
        settlementFailedAt: new Date(),
        settlementFailureReason: 'Dış iade tutarı paketin tamamıyla uyuşmadı.',
        settlementFailedByWebhookEventId: failedBy.id,
      },
    });
    for (const status of ['REJECTED', 'WITHDRAWN', 'APPROVED_PENDING_SETTLEMENT'] as const) {
      await expect(
        ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { status } }),
      ).rejects.toThrow(/may only become SETTLED/);
    }
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { settlementFailureReason: 'Sonradan değiştirilmiş gerekçe.' } }),
    ).rejects.toThrow(/may only become SETTLED/);
    // Still open: no second request may compete for the payment.
    const otherTicket = await ctx.prisma.supportTicket.create({
      data: { requesterId: fixture.owner.id, requesterRole: SupportTicketRequesterRole.PROVIDER, subject: 'z' },
    });
    await expect(insert(fixture, { supportTicketId: otherTicket.id })).rejects.toThrow(/Unique constraint/);

    const settledBy = await webhookEvent();
    const settled = await ctx.prisma.packageRefundRequest.update({
      where: { id: row.id },
      data: { status: 'SETTLED', settledAt: new Date(), settledByWebhookEventId: settledBy.id },
    });
    expect(settled.settlementFailedByWebhookEventId).toBe(failedBy.id);
    await expect(
      ctx.prisma.packageRefundRequest.update({ where: { id: row.id }, data: { status: 'SETTLEMENT_FAILED' } }),
    ).rejects.toThrow(/terminal/);
  });

  it('a webhook audit row may record SETTLED or SETTLEMENT_FAILED and nothing else', async () => {
    const fixture = await base();
    const row = await insert(fixture);
    const first = await webhookEvent();
    await ctx.prisma.packageRefundRequestEvent.create({
      data: { requestId: row.id, action: 'SETTLEMENT_FAILED', toStatus: 'SETTLEMENT_FAILED', actorKind: 'PAYMENT_WEBHOOK', webhookEventId: first.id },
    });
    const second = await webhookEvent();
    await expect(
      ctx.prisma.packageRefundRequestEvent.create({
        data: { requestId: row.id, action: 'REJECTED', toStatus: 'REJECTED', actorKind: 'PAYMENT_WEBHOOK', webhookEventId: second.id },
      }),
    ).rejects.toThrow(/actor_shape/);
  });

  it('the provider order total is both-or-neither, a real amount and an ISO code', async () => {
    const fixture = await base();
    const id = fixture.purchase.id;
    await expect(
      ctx.prisma.packagePurchase.update({ where: { id }, data: { providerOrderTotalAmount: 100 } }),
    ).rejects.toThrow(/provider_order_total_pair/);
    await expect(
      ctx.prisma.packagePurchase.update({ where: { id }, data: { providerOrderTotalAmount: -1, providerOrderCurrency: 'TRY' } }),
    ).rejects.toThrow(/provider_order_total_shape/);
    await expect(
      ctx.prisma.packagePurchase.update({ where: { id }, data: { providerOrderTotalAmount: 100, providerOrderCurrency: 'try' } }),
    ).rejects.toThrow(/provider_order_total_shape/);
    await ctx.prisma.packagePurchase.update({ where: { id }, data: { providerOrderTotalAmount: 100, providerOrderCurrency: 'TRY' } });
    await expect(
      ctx.prisma.packagePurchase.update({ where: { id }, data: { providerOrderTotalAmount: 101 } }),
    ).rejects.toThrow(/immutable/);
  });
});
