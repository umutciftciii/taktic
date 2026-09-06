import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import {
  CreditTransactionType,
  CustomerOrigin,
  OfferPackageType,
  PrismaClient,
  ProviderServiceAreaScope,
  ProviderStatus,
  ProviderEntitlementStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module';
import { applyHttpSecurity } from '../src/common/http-security';
import { SmsTransportUnavailableError } from '../src/modules/notifications/console-sms.adapter';
import {
  NotificationMessage,
  NotificationPort,
  NotificationSendResult,
} from '../src/modules/notifications/notification.port';
import { SmsMessage, SmsPort, SmsSendResult } from '../src/modules/notifications/sms.port';
import { PaymentProviderPort } from '../src/modules/payments/payment-provider.port';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Stands in for the outbound transport so tests can read what the application
 * would have sent — including the single-use activation URL, which is
 * deliberately never returned over HTTP.
 */
export class RecordingNotificationPort extends NotificationPort {
  readonly sent: NotificationMessage[] = [];
  /** Makes the next send throw, to exercise the FAILED audit branch. */
  failNextSend = false;

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new EmailTransportUnavailableError();
    }

    this.sent.push(message);

    // Mirrors the delivering adapter: an accepted message reports the
    // provider's own id, which is what the dispatcher stores.
    return { providerMessageId: `test-email-${this.sent.length}` };
  }

  clear() {
    this.sent.length = 0;
    this.failNextSend = false;
  }

  lastOfTemplate(template: NotificationMessage['template']): NotificationMessage | undefined {
    return [...this.sent].reverse().find((message) => message.template === template);
  }

  ofTemplate(template: NotificationMessage['template']): NotificationMessage[] {
    return this.sent.filter((message) => message.template === template);
  }
}

/**
 * Mirrors {@link SmsTransportUnavailableError} for the e-mail port: carries a
 * known errorCode and nothing about the recipient or the message.
 */
export class EmailTransportUnavailableError extends Error {
  readonly errorCode = 'TRANSPORT_UNAVAILABLE';

  constructor() {
    super('No e-mail transport is configured');
    this.name = 'EmailTransportUnavailableError';
  }
}

/**
 * Stands in for the SMS transport. Tests read the one-time code from here —
 * the production path never returns or logs it — and can make a send fail to
 * exercise the FAILED audit branch.
 */
export class RecordingSmsPort extends SmsPort {
  readonly sent: SmsMessage[] = [];
  failNextSend = false;

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new SmsTransportUnavailableError();
    }

    this.sent.push(message);
    return { providerMessageId: `test-${this.sent.length}` };
  }

  clear() {
    this.sent.length = 0;
    this.failNextSend = false;
  }

  lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) {
      throw new Error('no SMS was sent');
    }
    return last.code;
  }
}

export type TestContext = {
  app: INestApplication;
  prisma: PrismaService;
  server: Server;
  notifications: RecordingNotificationPort;
  sms: RecordingSmsPort;
};

/**
 * Boots the real application graph — same modules, same global ValidationPipe
 * as main.ts — so guards, roles and DTO validation behave exactly as they do in
 * production. Only the notification transport is swapped; everything that the
 * authorization tests depend on is the production wiring.
 */
export type TestAppOptions = {
  /**
   * Stands in for the bound PaymentProviderPort.
   *
   * The payment specs pass the real adapter constructed with a stand-in for
   * `fetch`, so the request this application would have made is asserted on
   * without a byte reaching a payment provider. Omitted, the application picks
   * its own adapter from PAYMENT_PROVIDER exactly as a deployment would.
   */
  paymentProvider?: PaymentProviderPort;
};

export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  const notifications = new RecordingNotificationPort();
  const sms = new RecordingSmsPort();

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NotificationPort)
    .useValue(notifications)
    .overrideProvider(SmsPort)
    .useValue(sms);

  if (options.paymentProvider) {
    builder.overrideProvider(PaymentProviderPort).useValue(options.paymentProvider);
  }

  const moduleRef = await builder.compile();

  // `rawBody: true` mirrors main.ts: the payment webhook verifies an HMAC over
  // the untouched request bytes, so the suite has to boot the app the same way.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  // The CORS allow-list, the security headers and the suppressed `X-Powered-By`
  // — the same call main.ts makes, so what the suite asserts on is the wiring a
  // deployment runs rather than a second description of it.
  applyHttpSecurity(app);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    server: app.getHttpServer(),
    notifications,
    sms,
  };
}

/**
 * Empties the in-memory rate-limit counters.
 *
 * The credential endpoints share one small budget per process, which is what
 * makes the limit cheap to test in auth-rate-limit.spec.ts — and what makes any
 * *other* spec that legitimately calls those endpoints many times run out of it
 * halfway through. Clearing the counter between cases keeps the limiter itself
 * exactly as it is in production; only the accumulated history goes.
 */
export function resetAuthThrottle(app: INestApplication): void {
  const storage = app.get<ThrottlerStorageService>(ThrottlerStorage, { strict: false });
  storage.storage.clear();
}

const TRUNCATED_TABLES = [
  'CompanySettings',
  'ServiceCategoryRouterRule',
  'ServiceRequestQuestionCondition',
  'Message',
  'MessageThread',
  'SupportTicketStatusChange',
  'SupportTicketMessage',
  'SupportTicket',
  'PasswordResetToken',
  'EmailVerificationToken',
  'PaymentWebhookEvent',
  'ContactRevealEvent',
  'NotificationLog',
  'PhoneVerification',
  'ProviderClaimToken',
  'ProviderInviteToken',
  'ProviderCreditTransaction',
  'PackageRenewalAttempt',
  'ProviderPackageEntitlementScope',
  'ProviderPackageEntitlement',
  'OfferPackageScopeCategory',
  'PackagePurchase',
  'Offer',
  'ServiceRequestAnswer',
  'ServiceRequest',
  'ServiceRequestQuestion',
  'ProviderServiceArea',
  'ProviderServiceCategory',
  'ProviderProfile',
  'OfferCreditPackage',
  'ServiceCategory',
  'CustomerNote',
  'CustomerActivationToken',
  'AdminInviteToken',
  'Session',
  'SequenceCounter',
  'User',
];

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const list = TRUNCATED_TABLES.map((table) => `"public"."${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

let sequence = 0;
export function uniqueSuffix(): string {
  sequence += 1;
  return `${sequence}`;
}

export async function createUser(
  prisma: PrismaClient,
  overrides: {
    role: UserRole;
    email?: string;
    phone?: string | null;
    password?: string | null;
    /** Explicit null creates an account with no name — the column is nullable. */
    name?: string | null;
    customerOrigin?: CustomerOrigin | null;
    isActive?: boolean;
  },
) {
  const suffix = uniqueSuffix();
  const password = overrides.password === undefined ? 'Password123!' : overrides.password;

  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${suffix}@example.test`,
      phone: overrides.phone === undefined ? `0555000${suffix.padStart(4, '0')}` : overrides.phone,
      name: overrides.name === undefined ? `User ${suffix}` : overrides.name,
      role: overrides.role,
      isActive: overrides.isActive ?? true,
      passwordHash: password === null ? null : await bcrypt.hash(password, 4),
      customerOrigin: overrides.customerOrigin ?? null,
    },
  });
}

/** Creates a live session row and returns the Cookie header value for it. */
export async function loginAs(prisma: PrismaClient, userId: string): Promise<string> {
  const session = await prisma.session.create({
    data: {
      id: `test-session-${uniqueSuffix()}-${Date.now()}`,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const cookieName = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';
  return `${cookieName}=${session.id}`;
}

/**
 * Creates a category. `offerCreditCost` defaults to null — i.e. unpriced, which
 * blocks offering. That is deliberate: a fixture default of 1 would quietly
 * recreate the hidden fallback the pricing rules forbid, so any test that needs
 * to submit an offer has to state the price it expects to be charged.
 *
 * `kind` defaults to LEAF and `status` to ACTIVE, which is what every category
 * in this suite was before the taxonomy existed. `status` and `isActive` are
 * written together here for the same reason the application writes them
 * together: they are one fact, and a fixture that let them disagree would be
 * testing a state no code path can produce. A caller that passes `isActive`
 * alone still gets the matching status.
 */
export async function createCategory(
  prisma: PrismaClient,
  name = 'Klima',
  options: {
    offerCreditCost?: number | null;
    isActive?: boolean;
    kind?: ServiceCategoryKind;
    status?: ServiceCategoryStatus;
    parentId?: string | null;
    sortOrder?: number;
    /** Defaults to false, exactly as the column does. */
    providerEnrollmentOpen?: boolean;
    /** Defaults to false, exactly as the column does. */
    unlimitedPackageEligible?: boolean;
  } = {},
) {
  const suffix = uniqueSuffix();
  const status =
    options.status ??
    (options.isActive === false ? ServiceCategoryStatus.INACTIVE : ServiceCategoryStatus.ACTIVE);

  return prisma.serviceCategory.create({
    data: {
      name: `${name} ${suffix}`,
      slug: `kategori-${suffix}`,
      kind: options.kind ?? ServiceCategoryKind.LEAF,
      status,
      isActive: status === ServiceCategoryStatus.ACTIVE,
      parentId: options.parentId ?? null,
      sortOrder: options.sortOrder ?? 0,
      offerCreditCost: options.offerCreditCost ?? null,
      providerEnrollmentOpen: options.providerEnrollmentOpen ?? false,
      unlimitedPackageEligible: options.unlimitedPackageEligible ?? false,
    },
  });
}

/**
 * A SELECT question, with options, in one call — the shape almost every
 * taxonomy case needs.
 */
export async function createSelectQuestion(
  prisma: PrismaClient,
  options: {
    categoryId: string;
    key: string;
    label?: string;
    options: { key: string; label: string }[];
    isRequired?: boolean;
    sortOrder?: number;
    isRouter?: boolean;
    multi?: boolean;
  },
) {
  return prisma.serviceRequestQuestion.create({
    data: {
      categoryId: options.categoryId,
      key: options.key,
      label: options.label ?? `Soru ${options.key}`,
      type: options.multi ? 'MULTI_SELECT' : 'SELECT',
      isRequired: options.isRequired ?? false,
      options: options.options,
      sortOrder: options.sortOrder ?? 0,
      isRouter: options.isRouter ?? false,
      isActive: true,
    },
  });
}

export async function createProviderProfile(
  prisma: PrismaClient,
  overrides: {
    userId?: string | null;
    status?: ProviderStatus;
    /** `null` produces an application with no contact address, which is the
     * shape of every guest application submitted before the claim flag existed. */
    email?: string | null;
    claimedAt?: Date | null;
  } = {},
) {
  const suffix = uniqueSuffix();
  return prisma.providerProfile.create({
    data: {
      userId: overrides.userId ?? null,
      claimedAt: overrides.claimedAt ?? null,
      businessName: `İşletme ${suffix}`,
      contactName: `Yetkili ${suffix}`,
      phone: `0555111${suffix.padStart(4, '0')}`,
      email: overrides.email === undefined ? `provider-${suffix}@example.test` : overrides.email,
      taxType: 'SAHIS',
      taxNumber: `1234567${suffix.padStart(3, '0')}`,
      city: 'İstanbul',
      district: 'Kadıköy',
      addressNote: 'Kapı no 5',
      description: 'Test işletmesi',
      status: overrides.status ?? ProviderStatus.APPROVED,
      moderationNote: 'İç moderasyon notu',
    },
  });
}

/**
 * The scope a service area row carries, worked out from the levels it names —
 * the same rule `serviceAreaScopeOf` applies in the application. Fixtures write
 * areas straight through Prisma, and the database CHECK refuses a scope that
 * disagrees with its levels, so they cannot simply leave it out.
 */
export function serviceAreaRow(area: {
  city: string;
  district?: string | null;
  neighborhood?: string | null;
}) {
  const district = area.district ?? null;
  const neighborhood = district ? (area.neighborhood ?? null) : null;

  return {
    city: area.city,
    district,
    neighborhood,
    scope:
      district === null
        ? ProviderServiceAreaScope.CITY
        : neighborhood === null
          ? ProviderServiceAreaScope.DISTRICT
          : ProviderServiceAreaScope.NEIGHBORHOOD,
  };
}

/**
 * An approved provider that can actually discover requests: it needs the
 * category and a service area that matches the request's city/district.
 *
 * `areas` replaces the single city/district pair when a case needs a provider
 * covering more than one place — a province-wide row beside a district one, say.
 * The default is unchanged: one district-scoped area at İstanbul/Kadıköy.
 */
export async function createDiscoverableProvider(
  prisma: PrismaClient,
  options: {
    userId?: string | null;
    categoryId: string;
    city?: string;
    district?: string;
    areas?: Array<{ city: string; district?: string | null; neighborhood?: string | null }>;
  },
) {
  const areas = options.areas ?? [
    { city: options.city ?? 'İstanbul', district: options.district ?? 'Kadıköy' },
  ];
  const provider = await createProviderProfile(prisma, {
    userId: options.userId ?? null,
    status: ProviderStatus.APPROVED,
  });

  await prisma.providerServiceCategory.create({
    data: { providerId: provider.id, categoryId: options.categoryId },
  });
  await prisma.providerServiceArea.createMany({
    data: areas.map((area) => ({ providerId: provider.id, ...serviceAreaRow(area) })),
  });

  return provider;
}

/**
 * An APPROVED request. `approvedAt` defaults to null — i.e. the shape of every
 * request approved before that column existed, which both lifecycle jobs skip
 * on purpose. A test that wants the expiry or reminder clock to run has to say
 * when the request was approved.
 */
export async function createApprovedRequest(
  prisma: PrismaClient,
  options: {
    categoryId: string;
    customerId?: string | null;
    city?: string;
    district?: string;
    /** Requests may name one; a provider area at neighbourhood scope needs it. */
    neighborhood?: string | null;
    approvedAt?: Date | null;
    customerEmail?: string | null;
  },
) {
  const suffix = uniqueSuffix();
  return prisma.serviceRequest.create({
    data: {
      categoryId: options.categoryId,
      customerId: options.customerId ?? null,
      requestNumber: `TR-TEST-${suffix}`,
      customerName: `Müşteri ${suffix}`,
      customerPhone: `0555444${suffix.padStart(4, '0')}`,
      customerEmail:
        options.customerEmail === undefined
          ? `req-${suffix}@example.test`
          : options.customerEmail,
      city: options.city ?? 'İstanbul',
      district: options.district ?? 'Kadıköy',
      neighborhood: options.neighborhood ?? null,
      status: ServiceRequestStatus.APPROVED,
      approvedAt: options.approvedAt ?? null,
      qualityScore: 80,
    },
  });
}

/** Shifts a Date `days` into the past; the lifecycle specs' whole vocabulary. */
/**
 * The body a customer's accept carries.
 *
 * Accepting an offer is what opens the two parties' contact details to each
 * other, so with contact sharing on the API requires the customer's
 * confirmation of the current disclosure in the same request — see
 * OffersService.acceptRequestOffer. The web accept screen collects it with a
 * required checkbox and posts exactly this shape.
 *
 * Specs whose subject is not contact sharing use this so they exercise the
 * accept a real client performs. With the feature off the field is ignored, so
 * it is safe everywhere. Specs that are *about* the rule send their own body:
 * the refusals are the thing they assert.
 */
export const ACCEPT_OFFER = { action: 'ACCEPT' as const, contactDisclosureAccepted: true };

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Backdates an offer as if it had been submitted `hours` ago.
 *
 * Both clocks move, because the offer carries both. `submittedAt` is what the
 * reports and the provider's screens show; `unviewedRefundEligibleAt` — the
 * moment snapshotted from the window in force when the offer was created — is
 * the only one the refund worker reads. Moving the first alone produces an
 * offer that looks old and is not eligible, which is a state no real offer
 * reaches and no test should assert against.
 *
 * An offer with no snapshot keeps none: an out-of-policy offer must stay out of
 * policy however far back it is moved.
 */
export async function backdateOfferSubmission(
  prisma: PrismaClient,
  offerId: string,
  hours: number,
) {
  const offer = await prisma.offer.findUniqueOrThrow({
    where: { id: offerId },
    select: { unviewedRefundWindowHours: true },
  });

  const submittedAt = new Date(Date.now() - hours * 60 * 60 * 1000);

  return prisma.offer.update({
    where: { id: offerId },
    data: {
      submittedAt,
      unviewedRefundEligibleAt:
        offer.unviewedRefundWindowHours === null
          ? null
          : new Date(submittedAt.getTime() + offer.unviewedRefundWindowHours * 60 * 60 * 1000),
    },
  });
}

/** Seeds a credit balance by appending an ADMIN_GRANT ledger row. */
export async function grantCredits(prisma: PrismaClient, providerId: string, amount: number) {
  const latest = await prisma.providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return prisma.providerCreditTransaction.create({
    data: {
      providerId,
      type: CreditTransactionType.ADMIN_GRANT,
      amount,
      balanceAfter: (latest?.balanceAfter ?? 0) + amount,
      reason: 'Test grant',
    },
  });
}

export async function currentCreditBalance(prisma: PrismaClient, providerId: string) {
  const latest = await prisma.providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return latest?.balanceAfter ?? 0;
}

export function offerPayload(overrides: Record<string, unknown> = {}) {
  return {
    priceAmount: 150000,
    message: 'Teklifimiz ektedir.',
    ...overrides,
  };
}

export function serviceRequestPayload(categorySlug: string, overrides: Record<string, unknown> = {}) {
  const suffix = uniqueSuffix();
  return {
    categorySlug,
    customerName: `Müşteri ${suffix}`,
    customerPhone: `0555222${suffix.padStart(4, '0')}`,
    customerEmail: `customer-${suffix}@example.test`,
    city: 'İstanbul',
    district: 'Kadıköy',
    description: 'Klima montajı gerekiyor.',
    answers: [],
    ...overrides,
  };
}

export function providerPayload(categoryIds: string[] = []) {
  const suffix = uniqueSuffix();
  return {
    businessName: `Yeni İşletme ${suffix}`,
    contactName: `Yetkili ${suffix}`,
    phone: `0555333${suffix.padStart(4, '0')}`,
    city: 'İstanbul',
    district: 'Kadıköy',
    categoryIds,
    serviceAreas: [{ city: 'İstanbul', district: 'Kadıköy' }],
  };
}


/**
 * A purchasable package of any type, with the per-type invariants the database
 * CHECK also insists on already satisfied.
 */
export async function createOfferPackage(
  prisma: PrismaClient,
  options: {
    type?: OfferPackageType;
    name?: string;
    priceAmount?: number;
    creditAmount?: number;
    quotaCredits?: number;
    dailyOfferLimit?: number | null;
    periodDays?: number;
    isActive?: boolean;
    scopeCategoryIds?: string[];
  } = {},
) {
  const suffix = uniqueSuffix();
  const type = options.type ?? OfferPackageType.ONE_TIME_CREDITS;
  const isOneTime = type === OfferPackageType.ONE_TIME_CREDITS;

  return prisma.offerCreditPackage.create({
    data: {
      name: `${options.name ?? 'Paket'} ${suffix}`,
      slug: `paket-${suffix}`,
      type,
      creditAmount: isOneTime ? (options.creditAmount ?? 10) : 0,
      quotaCredits:
        type === OfferPackageType.MONTHLY_QUOTA ? (options.quotaCredits ?? 20) : null,
      periodDays: isOneTime ? null : (options.periodDays ?? 30),
      dailyOfferLimit:
        type === OfferPackageType.CATEGORY_UNLIMITED
          ? (options.dailyOfferLimit ?? null)
          : null,
      priceAmount: options.priceAmount ?? 100_000,
      currency: 'TRY',
      isActive: options.isActive ?? true,
      ...(options.scopeCategoryIds?.length
        ? {
            scopeCategories: {
              create: options.scopeCategoryIds.map((categoryId) => ({ categoryId })),
            },
          }
        : {}),
    },
    include: { scopeCategories: true },
  });
}

/**
 * A bought period, written straight to the table.
 *
 * Tests that are about the *settlement* path go through a payment instead; this
 * is for the many cases whose subject is what an already-held period does.
 * `scopeCategoryIds` are written as selected rows — expansion is the settlement
 * path's job and is asserted there.
 */
export async function createEntitlement(
  prisma: PrismaClient,
  options: {
    providerId: string;
    packageId: string;
    type: OfferPackageType;
    startAt?: Date;
    endAt?: Date;
    quotaCredits?: number | null;
    remainingQuota?: number | null;
    dailyOfferLimit?: number | null;
    status?: ProviderEntitlementStatus;
    autoRenewEnabled?: boolean;
    paymentMethodReference?: string | null;
    periodIndex?: number;
    scopeCategoryIds?: string[];
  },
) {
  const startAt = options.startAt ?? new Date(Date.now() - 60_000);
  const endAt = options.endAt ?? new Date(startAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const isQuota = options.type === OfferPackageType.MONTHLY_QUOTA;
  const quota = isQuota ? (options.quotaCredits ?? 20) : null;

  const categories = options.scopeCategoryIds?.length
    ? await prisma.serviceCategory.findMany({
        where: { id: { in: options.scopeCategoryIds } },
        select: { id: true, name: true, kind: true },
      })
    : [];

  return prisma.providerPackageEntitlement.create({
    data: {
      providerId: options.providerId,
      packageId: options.packageId,
      type: options.type,
      packageNameSnapshot: `Paket ${uniqueSuffix()}`,
      priceAmountSnapshot: 100_000,
      currencySnapshot: 'TRY',
      quotaCreditsSnapshot: quota,
      remainingQuota: isQuota ? (options.remainingQuota ?? quota) : null,
      dailyOfferLimitSnapshot: options.dailyOfferLimit ?? null,
      periodDaysSnapshot: 30,
      startAt,
      endAt,
      status: options.status ?? ProviderEntitlementStatus.ACTIVE,
      periodIndex: options.periodIndex ?? 0,
      autoRenewEnabled: options.autoRenewEnabled ?? false,
      autoRenewConsentAt: options.autoRenewEnabled ? new Date() : null,
      paymentMethodReference: options.paymentMethodReference ?? null,
      ...(categories.length
        ? {
            scopes: {
              create: categories.map((category) => ({
                categoryId: category.id,
                categoryNameSnapshot: category.name,
                categoryKindSnapshot: category.kind,
                selected: true,
              })),
            },
          }
        : {}),
    },
    include: { scopes: true },
  });
}
