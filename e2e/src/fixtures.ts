import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getCities, getDistrictsOfEachCity } from 'turkey-neighbourhoods';
import { e2ePrisma } from './database';
import { E2E_LEMON_PACKAGE_SLUG } from './runtime';

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

/**
 * A Turkish mobile number in the shape the request form expects — allocated
 * from a counter, never derived from a fixture's hex suffix.
 *
 * Deriving it was the bug. The previous mapping dropped every letter out of
 * `randomUUID().slice(0, 8)` and right-padded the rest with zeros, which
 * collapsed a 4.3-billion-value suffix space onto roughly 7e5 reachable
 * numbers: "1a2b3c4d" and "a1b2c3d4" both became 05551234000, and every suffix
 * made only of letters became 05550000000. Two fixtures landing on one number
 * is not a cosmetic clash. `User.phone` is unique, so one of the two inserts
 * fails outright; and the SMS outbox is matched by subscriber digits, so a
 * phone-verification test could read another fixture's one-time code and fail
 * on a wrong code instead of on anything it was written to check. Measured over
 * this suite's fixture count, that reached a few percent of runs.
 *
 * A counter makes the numbers deterministic and reproducible, which random
 * derivation never was: uniqueness holds by construction rather than by luck,
 * and run N issues exactly the numbers run N+1 does. Repeating the sequence
 * from run to run is safe because `prepare-database` truncates before each one.
 *
 * Inside a run it is not, and that is what the block is for. The counter lives
 * in a worker process, but the database outlives every worker: Playwright
 * starts a fresh process for each `--repeat-each` iteration and for each retry,
 * so a bare counter would restart at zero against rows the previous process had
 * already inserted. TEST_WORKER_INDEX is the identifier that does not repeat —
 * Playwright numbers every worker process it starts, across the whole run —
 * whereas TEST_PARALLEL_INDEX is only a slot number and is handed straight back
 * to the replacement worker. Keying the block on the parallel index reproduces
 * the very collision this fix exists to remove.
 */
const PHONE_PREFIX = '0555';
export const PHONE_WORKER_BLOCKS = 1_000;
export const PHONE_SERIALS_PER_BLOCK = 10_000;

/**
 * A private block of numbers, allocated in order.
 *
 * A factory rather than one hard-wired counter so the block can be stated
 * instead of inferred: that is what makes "two worker processes never collide"
 * something a test can demonstrate rather than something this comment claims.
 */
export function createPhoneAllocator(block: number = resolvePhoneBlock()): () => string {
  if (!Number.isInteger(block) || block < 0 || block >= PHONE_WORKER_BLOCKS) {
    throw new Error(
      `Worker ${block} has no phone block: the suite reserves ${PHONE_WORKER_BLOCKS} blocks, ` +
        'and sharing one would put two worker processes on the same numbers.',
    );
  }

  const prefix = `${PHONE_PREFIX}${String(block).padStart(3, '0')}`;
  let serial = 0;

  return () => {
    if (serial >= PHONE_SERIALS_PER_BLOCK) {
      throw new Error(
        `This worker has allocated all ${PHONE_SERIALS_PER_BLOCK} of its fixture phone numbers. ` +
          'Widen the block rather than letting the sequence wrap onto numbers already in the database.',
      );
    }

    // 0555 + 3 + 4 = the eleven digits of a national-format Turkish mobile number.
    return `${prefix}${String(serial++).padStart(4, '0')}`;
  };
}

function resolvePhoneBlock(): number {
  return resolveWorkerIndex('phone', PHONE_WORKER_BLOCKS);
}

/**
 * This worker process's block number.
 *
 * TEST_WORKER_INDEX is the identifier Playwright never reuses within a run —
 * unlike TEST_PARALLEL_INDEX, which is handed straight back to a replacement
 * worker — so it is what keeps two processes off the same fixture values.
 */
function resolveWorkerIndex(kind: string, blocks: number): number {
  const raw = process.env.TEST_WORKER_INDEX;
  const block = raw === undefined || raw === '' ? 0 : Number(raw);

  if (!Number.isInteger(block) || block < 0 || block >= blocks) {
    throw new Error(
      `TEST_WORKER_INDEX=${raw} has no ${kind} block: the suite reserves ${blocks} ` +
        'blocks, and sharing one would put two worker processes on the same fixture values.',
    );
  }

  return block;
}

/** This worker process's allocator, so the sequence never restarts mid-process. */
export const uniquePhone = createPhoneAllocator();

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
 * How many worker processes may each hold a private range of districts.
 *
 * Turkey has 973 of them, so a block is sixty-odd — comfortably more than any
 * one worker allocates, and the allocator below refuses rather than wraps if
 * that ever stops being true.
 */
export const LOCATION_WORKER_BLOCKS = 16;

/** Every (province, district) pair, in one deterministic order. */
export function allDistrictPairs(): Location[] {
  const districtsByCity = getDistrictsOfEachCity() as Record<string, string[]>;

  return getCities()
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .flatMap((city) =>
      [...(districtsByCity[city.code] ?? [])]
        .sort((a, b) => a.localeCompare(b, 'tr-TR'))
        .map((district) => ({ city: city.name, district })),
    );
}

export function createLocationAllocator(
  block: number = resolveWorkerIndex('location', LOCATION_WORKER_BLOCKS),
): () => Location {
  const pairs = allDistrictPairs();
  const perBlock = Math.floor(pairs.length / LOCATION_WORKER_BLOCKS);

  if (!Number.isInteger(block) || block < 0 || block >= LOCATION_WORKER_BLOCKS) {
    throw new Error(
      `Worker ${block} has no location block: the suite reserves ${LOCATION_WORKER_BLOCKS} blocks, ` +
        'and sharing one would put two worker processes on the same district.',
    );
  }

  let serial = 0;

  return () => {
    if (serial >= perBlock) {
      throw new Error(
        `This worker has allocated all ${perBlock} of its fixture districts. ` +
          'Widen the block rather than letting the sequence wrap onto districts already in the database.',
      );
    }

    const pair = pairs[block * perBlock + serial];
    serial += 1;

    if (!pair) {
      throw new Error('Fixture district allocation ran past the district list.');
    }

    return pair;
  };
}

/** This worker process's allocator, so the sequence never restarts mid-process. */
const allocateLocation = createLocationAllocator();

/**
 * A real province/district pair nobody else in this run uses.
 *
 * Provider discovery matches on city+district, so a per-test district is what
 * lets a test assert "this provider's matching list holds exactly one request"
 * without caring what the rest of the suite created.
 *
 * It used to be `Kadıköy-<suffix>`: unique, but not a place. The request form
 * now offers Turkey's actual districts as a select and the API refuses a
 * province/district pair that does not exist, so an invented district can no
 * longer be typed in or posted — a fixture using one would be testing a request
 * the product cannot create. Uniqueness therefore comes from allocating a
 * distinct *real* pair instead of decorating one.
 *
 * Same allocator shape as {@link createPhoneAllocator} and for the same reason:
 * a counter is unique by construction, while the database outlives the worker
 * process that holds it, so each worker takes its own block.
 */
export function uniqueLocation(): Location {
  return allocateLocation();
}

export async function createCustomer(name = 'E2E Müşteri'): Promise<SeededCustomer> {
  const suffix = uniqueSuffix();
  const email = `e2e-customer-${suffix}@example.test`;
  const user = await prisma().user.create({
    data: {
      email,
      phone: uniquePhone(),
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
      phone: uniquePhone(),
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
  // One number for both rows, as before: the account and the profile it owns
  // belong to the same business, and only the account's copy is unique-indexed.
  const phone = uniquePhone();

  const user = await prisma().user.create({
    data: {
      email,
      phone,
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
      phone,
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

/**
 * The credit package the payments runtime's variant mapping points at.
 *
 * Its slug is fixed because LEMON_SQUEEZY_VARIANT_MAP is fixed: the mapping is
 * by slug so it survives a reseed, and the stub sandbox only knows one variant.
 * The database is truncated before each run, so one row per run is enough.
 */
export async function createLemonSqueezyCreditPackage(options: {
  creditAmount: number;
  priceAmount: number;
}) {
  return prisma().offerCreditPackage.upsert({
    where: { slug: E2E_LEMON_PACKAGE_SLUG },
    update: {
      creditAmount: options.creditAmount,
      priceAmount: options.priceAmount,
      isActive: true,
    },
    create: {
      name: 'E2E Kredi Paketi',
      slug: E2E_LEMON_PACKAGE_SLUG,
      creditAmount: options.creditAmount,
      priceAmount: options.priceAmount,
      currency: 'TRY',
      description: 'Uçtan uca test için yazılım kullanım kredisi paketi',
      isActive: true,
      sortOrder: 0,
    },
  });
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
    customerPhone: uniquePhone(),
    customerEmail: `e2e-request-${suffix}@example.test`,
    city: location.city,
    district: location.district,
    description: 'Salon klimasının montajı ve ilk bakımı gerekiyor.',
  };
}
