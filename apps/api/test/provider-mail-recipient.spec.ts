import { CreditTransactionType, OfferStatus, ProviderStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DISPLAY_TIME_ZONE } from '../src/modules/notifications/templates/format';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * Which address a provider-targeted message is sent to.
 *
 * This is the recipient matrix behind a production failure no log could show:
 * every one of these messages was recorded SENT with a provider message id, and
 * the provider never saw one of them. The transport had accepted them and
 * addressed them to the contact field of the *application form* — a value the
 * provider typed once, never confirmed, and cannot correct by fixing their
 * account — instead of the address their account signs in with.
 *
 * The rule these cases pin: a profile that belongs to an account is reached at
 * that account's address. The form field is the recipient only for a guest
 * application, which has no account behind it yet.
 */

let ctx: TestContext;
let mail: TransactionalMailService;

beforeAll(async () => {
  ctx = await createTestApp();
  mail = ctx.app.get(TransactionalMailService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  // These cases are about addressing, not about disclosure.
  process.env.CONTACT_SHARING_ENABLED = 'false';
});

const CATEGORY_COST = 2;

/**
 * A provider whose account address and application-form address deliberately
 * differ — the shape every self-registered provider has, and the shape the old
 * rule got wrong.
 */
async function providerWithDistinctAddresses(categoryId: string) {
  const account = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: account.id,
    categoryId,
  });
  const formEmail = `basvuru-formu-${uniqueSuffix()}@example.test`;
  await ctx.prisma.providerProfile.update({
    where: { id: provider.id },
    data: { email: formEmail },
  });

  expect(account.email).not.toBe(formEmail);
  return { account, provider, formEmail };
}

function recipientsOf(template: string): string[] {
  return ctx.notifications.sent
    .filter((message) => message.template === template)
    .map((message) => message.to);
}

async function scenario() {
  const category = await createCategory(ctx.prisma, `Klima ${uniqueSuffix()}`, {
    offerCreditCost: CATEGORY_COST,
  });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  const { account, provider, formEmail } = await providerWithDistinctAddresses(category.id);

  return { category, customer, serviceRequest, account, provider, formEmail };
}

function addOffer(providerId: string, requestId: string, status: OfferStatus) {
  return ctx.prisma.offer.create({
    data: {
      requestId,
      providerId,
      status,
      priceAmount: 250000,
      message: 'Teklifim',
      creditCost: CATEGORY_COST,
      ...(status === OfferStatus.ACCEPTED ? { acceptedAt: new Date() } : {}),
      ...(status === OfferStatus.REJECTED ? { rejectedAt: new Date() } : {}),
    },
  });
}

describe('provider-targeted mail — which address it reaches', () => {
  it('sends request-available to the account address, never the form field', async () => {
    const { serviceRequest, account, formEmail, customer } = await scenario();

    await mail.fanOutApprovedRequest(serviceRequest.id, new Date());

    expect(recipientsOf('request-available')).toEqual([account.email]);
    expect(recipientsOf('request-available')).not.toContain(formEmail);
    // And never the customer's, which is the other way this can go wrong.
    expect(recipientsOf('request-available')).not.toContain(serviceRequest.customerEmail);
    expect(recipientsOf('request-available')).not.toContain(customer.email);
  });

  it('sends offer-accepted to the account address, never the form field', async () => {
    const { serviceRequest, account, formEmail, provider } = await scenario();
    const offer = await addOffer(provider.id, serviceRequest.id, OfferStatus.ACCEPTED);
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.MATCHED, matchedOfferId: offer.id },
    });
    ctx.notifications.clear();

    await mail.sendMatchNotifications(offer.id);

    expect(recipientsOf('offer-accepted')).toEqual([account.email]);
    expect(recipientsOf('offer-accepted')).not.toContain(formEmail);
    // The customer's own half of the match goes to the customer, and only there.
    expect(recipientsOf('match-customer')).toEqual([serviceRequest.customerEmail]);
    expect(recipientsOf('match-customer')).not.toContain(account.email);
  });

  it('sends offer-not-selected to the account address, never the form field', async () => {
    const { serviceRequest, account, formEmail, provider } = await scenario();
    const offer = await addOffer(provider.id, serviceRequest.id, OfferStatus.REJECTED);
    ctx.notifications.clear();

    await mail.sendOfferNotSelected([offer.id]);

    expect(recipientsOf('offer-not-selected')).toEqual([account.email]);
    expect(recipientsOf('offer-not-selected')).not.toContain(formEmail);
    expect(recipientsOf('offer-not-selected')).not.toContain(serviceRequest.customerEmail);
  });

  it('sends credit-refunded to the account address, never the form field', async () => {
    const { account, formEmail, provider } = await scenario();
    await grantCredits(ctx.prisma, provider.id, 10);
    const refund = await ctx.prisma.providerCreditTransaction.create({
      data: {
        providerId: provider.id,
        type: CreditTransactionType.OFFER_REFUND,
        amount: CATEGORY_COST,
        balanceAfter: 10 + CATEGORY_COST,
        reason: 'INVALID_REQUEST: dahili not',
      },
    });
    ctx.notifications.clear();

    await mail.sendCreditRefunded(refund.id);

    expect(recipientsOf('credit-refunded')).toEqual([account.email]);
    expect(recipientsOf('credit-refunded')).not.toContain(formEmail);
  });

  it('sends the application receipt and approval to the account address', async () => {
    const { account, formEmail, provider } = await scenario();
    ctx.notifications.clear();

    await mail.sendProviderApplicationReceived(provider.id);
    await mail.sendProviderApplicationApproved(provider.id, new Date());

    expect(recipientsOf('provider-application-received')).toEqual([account.email]);
    expect(recipientsOf('provider-application-approved')).toEqual([account.email]);
    expect(ctx.notifications.sent.map((message) => message.to)).not.toContain(formEmail);
  });

  it('falls back to the form field only for a guest application with no account', async () => {
    // The one case the form address is the right answer, and the case the claim
    // invitation is for: nobody owns this application yet, so there is no
    // account address to prefer.
    const guestEmail = `guest-${uniqueSuffix()}@example.test`;
    const guest = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.PENDING_REVIEW,
      email: guestEmail,
    });
    expect(guest.userId).toBeNull();
    ctx.notifications.clear();

    await mail.sendProviderApplicationReceived(guest.id);

    expect(recipientsOf('provider-application-received')).toEqual([guestEmail]);
  });

  it('sends nothing when the profile holds no usable address at all', async () => {
    const orphan = await createProviderProfile(ctx.prisma, {
      status: ProviderStatus.PENDING_REVIEW,
      email: null,
    });
    ctx.notifications.clear();

    await mail.sendProviderApplicationReceived(orphan.id);

    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await ctx.prisma.notificationLog.count()).toBe(0);
  });
});

describe('mail and web agree about when something happened', () => {
  it('renders e-mail timestamps in the same zone the screens do', () => {
    // The web and admin surfaces format through @taktic/shared, which pins
    // TAKTIC_TIME_ZONE to this same value. A link in a message and the page it
    // opens must not disagree about the hour — that disagreement is what broke
    // hydration on the offer detail screen.
    expect(DISPLAY_TIME_ZONE).toBe('Europe/Istanbul');
  });
});
