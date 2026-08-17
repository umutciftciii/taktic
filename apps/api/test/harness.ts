import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  CreditTransactionType,
  CustomerOrigin,
  PrismaClient,
  ProviderStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module';
import { SmsTransportUnavailableError } from '../src/modules/notifications/console-sms.adapter';
import { NotificationMessage, NotificationPort } from '../src/modules/notifications/notification.port';
import { SmsMessage, SmsPort, SmsSendResult } from '../src/modules/notifications/sms.port';
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

  async send(message: NotificationMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new EmailTransportUnavailableError();
    }

    this.sent.push(message);
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
export async function createTestApp(): Promise<TestContext> {
  const notifications = new RecordingNotificationPort();
  const sms = new RecordingSmsPort();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NotificationPort)
    .useValue(notifications)
    .overrideProvider(SmsPort)
    .useValue(sms)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
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

const TRUNCATED_TABLES = [
  'NotificationLog',
  'PhoneVerification',
  'ProviderCreditTransaction',
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
    name?: string;
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
      name: overrides.name ?? `User ${suffix}`,
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
 */
export async function createCategory(
  prisma: PrismaClient,
  name = 'Klima',
  options: { offerCreditCost?: number | null; isActive?: boolean } = {},
) {
  const suffix = uniqueSuffix();
  return prisma.serviceCategory.create({
    data: {
      name: `${name} ${suffix}`,
      slug: `kategori-${suffix}`,
      isActive: options.isActive ?? true,
      sortOrder: 0,
      offerCreditCost: options.offerCreditCost ?? null,
    },
  });
}

export async function createProviderProfile(
  prisma: PrismaClient,
  overrides: { userId?: string | null; status?: ProviderStatus } = {},
) {
  const suffix = uniqueSuffix();
  return prisma.providerProfile.create({
    data: {
      userId: overrides.userId ?? null,
      businessName: `İşletme ${suffix}`,
      contactName: `Yetkili ${suffix}`,
      phone: `0555111${suffix.padStart(4, '0')}`,
      email: `provider-${suffix}@example.test`,
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
 * An approved provider that can actually discover requests: it needs the
 * category and a service area that matches the request's city/district.
 */
export async function createDiscoverableProvider(
  prisma: PrismaClient,
  options: { userId?: string | null; categoryId: string; city?: string; district?: string },
) {
  const city = options.city ?? 'İstanbul';
  const district = options.district ?? 'Kadıköy';
  const provider = await createProviderProfile(prisma, {
    userId: options.userId ?? null,
    status: ProviderStatus.APPROVED,
  });

  await prisma.providerServiceCategory.create({
    data: { providerId: provider.id, categoryId: options.categoryId },
  });
  await prisma.providerServiceArea.create({
    data: { providerId: provider.id, city, district },
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
      status: ServiceRequestStatus.APPROVED,
      approvedAt: options.approvedAt ?? null,
      qualityScore: 80,
    },
  });
}

/** Shifts a Date `days` into the past; the lifecycle specs' whole vocabulary. */
export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
