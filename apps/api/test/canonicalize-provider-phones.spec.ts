import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCanonicalization,
  CanonicalizationAborted,
  CanonicalizationRefused,
  planCanonicalization,
} from '../src/scripts/canonicalize-provider-phones';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The canonicalize-provider-phones ops script (CONTACT-PHONE-DATA-HYGIENE-001),
 * against scratch "ProviderProfile" and "User" tables.
 *
 * A schema of its own per case, with the script's unqualified SQL pointed at it
 * by `SET LOCAL search_path` — the way canonicalize-user-phones.spec does — so
 * nothing here shares rows with the application tables other specs truncate.
 */

let prisma: PrismaClient;
let schema: string;
let counter = 0;

beforeAll(() => {
  prisma = new PrismaClient({ datasources: { db: { url: resolveTestDatabaseUrl() } } });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (schema) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  counter += 1;
  schema = `canonicalize_provider_phones_${process.pid}_${counter}`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${schema}"."User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "phone" TEXT
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${schema}"."ProviderProfile" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT,
      "phone" TEXT NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL
    )`);
});

const EARLIER = new Date('2026-01-01T00:00:00.000Z');

async function seedUser(id: string, phone: string | null) {
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."User" ("id","phone") VALUES ($1,$2)`, id, phone);
}

async function seedProfile(id: string, phone: string, userId: string | null = null) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."ProviderProfile" ("id","userId","phone","updatedAt") VALUES ($1,$2,$3,$4)`,
    id,
    userId,
    phone,
    EARLIER,
  );
}

type Row = { id: string; userId: string | null; phone: string; updatedAt: Date };

async function rows(): Promise<Row[]> {
  return prisma.$queryRawUnsafe(`SELECT * FROM "${schema}"."ProviderProfile" ORDER BY "id"`);
}

async function userPhones() {
  return prisma.$queryRawUnsafe<Array<{ id: string; phone: string | null }>>(
    `SELECT * FROM "${schema}"."User" ORDER BY "id"`,
  );
}

async function inScratch<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, readOnly = false): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (readOnly) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    return fn(tx);
  });
}

/** The shape of the local data: four format-only rows, two of them the owner's own number. */
async function seedLocalShape() {
  await seedUser('u-owner-a', '+905550007701');
  await seedUser('u-owner-b', '+905550007702');
  await seedUser('u-owner-c', '+905550009999');
  await seedUser('u-owner-d', null);
  await seedProfile('p-a-owned-same', '05550007701', 'u-owner-a');
  await seedProfile('p-b-owned-same', '5550007702', 'u-owner-b');
  await seedProfile('p-c-owned-other', '+905550007703', 'u-owner-c');
  await seedProfile('p-d-owner-no-phone', '+905550007704', 'u-owner-d');
  await seedProfile('p-e-guest', '05550007705');
  await seedProfile('p-f-guest', '905550007706');
  await seedProfile('p-g-canonical', '+905550007707');
}

describe('dry run', () => {
  it('plans every format-only change and writes nothing — even inside a read-only transaction', async () => {
    await seedLocalShape();
    const before = await rows();

    const plan = await inScratch((tx) => planCanonicalization(tx), true);

    expect(await rows()).toEqual(before);
    expect(plan).toMatchObject({ scanned: 7, alreadyCanonical: 3, unsupported: [], refusals: [] });
    expect(plan.changes).toEqual([
      { providerId: 'p-a-owned-same', oldPhone: '05550007701', newPhone: '+905550007701', owner: 'matches' },
      { providerId: 'p-b-owned-same', oldPhone: '5550007702', newPhone: '+905550007702', owner: 'matches' },
      { providerId: 'p-e-guest', oldPhone: '05550007705', newPhone: '+905550007705', owner: 'no-owner' },
      { providerId: 'p-f-guest', oldPhone: '905550007706', newPhone: '+905550007706', owner: 'no-owner' },
    ]);
    expect(plan.ownerMatch.before).toEqual({ matches: 2, differs: 1, 'owner-has-no-phone': 1, 'no-owner': 3 });
    expect(plan.ownerMatch.after).toEqual(plan.ownerMatch.before);
  });
});

describe('apply', () => {
  it('rewrites only the planned rows to E.164, keeps owner matches, and never touches User', async () => {
    await seedLocalShape();
    const usersBefore = await userPhones();

    const result = await inScratch((tx) => applyCanonicalization(tx));

    expect(result.applied).toHaveLength(4);
    expect(result.after.nonCanonical).toBe(0);
    expect(result.after.ownerMatch.matches).toBe(2);

    const after = new Map((await rows()).map((row) => [row.id, row]));
    expect(after.get('p-a-owned-same')?.phone).toBe('+905550007701');
    expect(after.get('p-b-owned-same')?.phone).toBe('+905550007702');
    expect(after.get('p-e-guest')?.phone).toBe('+905550007705');
    expect(after.get('p-f-guest')?.phone).toBe('+905550007706');
    // Untouched rows keep their timestamp; rewritten ones move it.
    expect(after.get('p-g-canonical')?.updatedAt).toEqual(EARLIER);
    expect(after.get('p-c-owned-other')?.phone).toBe('+905550007703');
    expect(after.get('p-a-owned-same')?.updatedAt).not.toEqual(EARLIER);
    expect(await userPhones()).toEqual(usersBefore);
  });

  it('is a no-op the second time', async () => {
    await seedLocalShape();
    await inScratch((tx) => applyCanonicalization(tx));

    const again = await inScratch((tx) => planCanonicalization(tx));
    expect(again.changes).toEqual([]);
    expect(again.alreadyCanonical).toBe(7);
  });

  it('refuses the whole run when one value cannot be canonicalised, and changes nothing', async () => {
    await seedLocalShape();
    await seedProfile('p-z-unsupported', '12345');
    const before = await rows();

    const error = await inScratch((tx) => applyCanonicalization(tx)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CanonicalizationRefused);
    expect((error as CanonicalizationRefused).plan.unsupported).toEqual([
      { providerId: 'p-z-unsupported', phone: '12345' },
    ]);
    expect(await rows()).toEqual(before);
  });

  it('rolls back when a row changed between the plan and its write', async () => {
    await seedLocalShape();

    const error = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        // A save that lands after the plan read: the guarded UPDATE must miss.
        const db = {
          $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
          $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
            if (sql.startsWith('UPDATE') && values[1] === 'p-e-guest') {
              await tx.$executeRawUnsafe(
                `UPDATE "ProviderProfile" SET "phone" = '+905559990000' WHERE "id" = 'p-e-guest'`,
              );
            }
            return tx.$executeRawUnsafe(sql, ...values);
          },
        } as unknown as Prisma.TransactionClient;
        return applyCanonicalization(db);
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CanonicalizationAborted);
    expect((await rows()).find((row) => row.id === 'p-a-owned-same')?.phone).toBe('05550007701');
  });
});
