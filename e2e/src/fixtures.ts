import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { e2ePrisma } from './database';

/**
 * Deterministic, collision-free seed data.
 *
 * Fixtures are written straight to the database rather than through the admin
 * UI: creating a priced category, an approved provider and a credit balance
 * through screens would make every test depend on unrelated flows, and a
 * failure there would read as a failure of the journey under test.
 *
 * What is deliberately NOT shortcut: authentication (actors log in through the
 * real form and carry a real session cookie), request approval (the admin does
 * it in the admin app), offering, accepting, and the credit spend. Every rule
 * this suite claims to cover is exercised by the application, not simulated
 * here. The only account detail written directly is the password hash, in the
 * same bcrypt form the register endpoint produces.
 */

/** Cheap bcrypt rounds: fixtures are created constantly and never stored. */
const PASSWORD_ROUNDS = 4;

export const FIXTURE_PASSWORD = 'E2ePassword123!';

/**
 * Unique across a run AND across runs. The database is truncated before each
 * run, but a suffix that restarted at 1 every time would make a leftover row
 * from an interrupted run look like this run's fixture.
 */
export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

/** A Turkish mobile number in the shape the request form expects. */
function uniquePhone(seed: string): string {
  const digits = seed.replace(/\D/g, '').padEnd(7, '0').slice(0, 7);
  return `0555${digits}`;
}

export type SeededCustomer = {
  id: string;
  email: string;
  password: string;
  name: string;
};

export type SeededProvider = {
  id: string;
  userId: string;
  email: string;
  password: string;
  businessName: string;
};

export type SeededCategory = {
  id: string;
  name: string;
  slug: string;
  offerCreditCost: number;
};

export type Location = {
  city: string;
  district: string;
};

export function prisma(): PrismaClient {
  return e2ePrisma();
}

/**
 * A district nobody else uses.
 *
 * Provider discovery matches on city+district, so a per-test district is what
 * lets a test assert "this provider's matching list holds exactly one request"
 * without caring what the rest of the suite created.
 */
export function uniqueLocation(suffix = uniqueSuffix()): Location {
  return { city: 'İstanbul', district: `Kadıköy-${suffix}` };
}

export async function createCustomer(name = 'E2E Müşteri'): Promise<SeededCustomer> {
  const suffix = uniqueSuffix();
  const email = `e2e-customer-${suffix}@example.test`;
  const user = await prisma().user.create({
    data: {
      email,
      phone: uniquePhone(suffix),
      name: `${name} ${suffix}`,
      role: 'CUSTOMER',
      isActive: true,
      passwordHash: await bcrypt.hash(FIXTURE_PASSWORD, PASSWORD_ROUNDS),
    },
    select: { id: true, name: true },
  });

  return { id: user.id, email, password: FIXTURE_PASSWORD, name: user.name ?? name };
}

export async function createAdmin(): Promise<SeededCustomer> {
  const suffix = uniqueSuffix();
  const email = `e2e-admin-${suffix}@example.test`;
  const user = await prisma().user.create({
    data: {
      email,
      phone: uniquePhone(suffix),
      name: `E2E Yönetici ${suffix}`,
      role: 'SUPER_ADMIN',
      isActive: true,
      passwordHash: await bcrypt.hash(FIXTURE_PASSWORD, PASSWORD_ROUNDS),
    },
    select: { id: true, name: true },
  });

  return { id: user.id, email, password: FIXTURE_PASSWORD, name: user.name ?? 'admin' };
}

/**
 * A category with an explicit offer price.
 *
 * There is no default: the schema treats "unpriced" as a real state that blocks
 * offering, so every test states the number it expects to be charged.
 */
export async function createCategory(offerCreditCost: number): Promise<SeededCategory> {
  const suffix = uniqueSuffix();
  const category = await prisma().serviceCategory.create({
    data: {
      name: `E2E Klima ${suffix}`,
      slug: `e2e-klima-${suffix}`,
      description: 'Uçtan uca test kategorisi',
      isActive: true,
      sortOrder: 0,
      offerCreditCost,
    },
    select: { id: true, name: true, slug: true },
  });

  return { ...category, offerCreditCost };
}

/**
 * An approved provider that can actually discover requests: it owns a platform
 * account, serves the category, and covers the location.
 */
export async function createProvider(options: {
  categoryId: string;
  location: Location;
  credits: number;
}): Promise<SeededProvider> {
  const suffix = uniqueSuffix();
  const email = `e2e-provider-${suffix}@example.test`;
  const businessName = `E2E İşletme ${suffix}`;

  const user = await prisma().user.create({
    data: {
      email,
      phone: uniquePhone(suffix),
      name: businessName,
      role: 'PROVIDER',
      isActive: true,
      passwordHash: await bcrypt.hash(FIXTURE_PASSWORD, PASSWORD_ROUNDS),
    },
    select: { id: true },
  });

  const provider = await prisma().providerProfile.create({
    data: {
      userId: user.id,
      businessName,
      contactName: `Yetkili ${suffix}`,
      phone: uniquePhone(suffix),
      email,
      city: options.location.city,
      district: options.location.district,
      description: 'Uçtan uca test işletmesi',
      status: 'APPROVED',
      serviceCategories: { create: { categoryId: options.categoryId } },
      serviceAreas: {
        create: { city: options.location.city, district: options.location.district },
      },
    },
    select: { id: true },
  });

  if (options.credits > 0) {
    await grantCredits(provider.id, options.credits);
  }

  return { id: provider.id, userId: user.id, email, password: FIXTURE_PASSWORD, businessName };
}

/** Seeds a balance the same way the admin grant does: an ADMIN_GRANT ledger row. */
export async function grantCredits(providerId: string, amount: number) {
  const latest = await prisma().providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return prisma().providerCreditTransaction.create({
    data: {
      providerId,
      type: 'ADMIN_GRANT',
      amount,
      balanceAfter: (latest?.balanceAfter ?? 0) + amount,
      reason: 'E2E fixture grant',
    },
  });
}

export async function creditBalance(providerId: string): Promise<number> {
  const latest = await prisma().providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return latest?.balanceAfter ?? 0;
}

export async function countRefundTransactions(providerId?: string): Promise<number> {
  return prisma().providerCreditTransaction.count({
    where: { type: 'OFFER_REFUND', ...(providerId ? { providerId } : {}) },
  });
}

/** The details a customer types into the request form. */
export function requestFormValues(location: Location, customerName: string) {
  const suffix = uniqueSuffix();

  return {
    customerName,
    customerPhone: uniquePhone(suffix),
    customerEmail: `e2e-request-${suffix}@example.test`,
    city: location.city,
    district: location.district,
    description: 'Salon klimasının montajı ve ilk bakımı gerekiyor.',
  };
}
