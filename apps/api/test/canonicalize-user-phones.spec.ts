import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCanonicalization,
  CanonicalizationAborted,
  CanonicalizationRefused,
  parseResolutionFile,
  planCanonicalization,
  type ResolutionFile,
} from '../src/scripts/canonicalize-user-phones';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The canonicalize-user-phones ops script (AUTH-REG-002), against a scratch
 * "User" table.
 *
 * The real table can no longer hold the rows this script exists for — its
 * CHECK refuses them — so each case builds them in a schema of its own and
 * points the script's unqualified SQL at it with `SET LOCAL search_path`, the
 * way the script's own transaction would run against the configured database.
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
  schema = `canonicalize_phones_${process.pid}_${counter}`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${schema}"."User" (
      "id" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "phone" TEXT,
      "email" TEXT,
      "phoneVerifiedAt" TIMESTAMP(3),
      "emailVerifiedAt" TIMESTAMP(3),
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "User_pkey" PRIMARY KEY ("id")
    )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "User_phone_key" ON "${schema}"."User" ("phone")`);
});

const EARLIER = new Date('2026-01-01T00:00:00.000Z');

async function seed(id: string, phone: string | null, extra: { role?: string; emailVerifiedAt?: Date } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."User" ("id","role","phone","email","emailVerifiedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    id,
    extra.role ?? 'CUSTOMER',
    phone,
    `${id}@example.test`,
    extra.emailVerifiedAt ?? null,
    EARLIER,
  );
}

type Row = {
  id: string;
  role: string;
  phone: string | null;
  email: string | null;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  updatedAt: Date;
};

async function rows(): Promise<Row[]> {
  return prisma.$queryRawUnsafe(`SELECT * FROM "${schema}"."User" ORDER BY "id"`);
}

type Tx = Prisma.TransactionClient;

async function inScratch<T>(fn: (tx: Tx) => Promise<T>, readOnly = false): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (readOnly) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    return fn(tx);
  });
}

function resolutions(...entries: Array<[string, string]>): ResolutionFile {
  return {
    version: 1,
    resolutions: entries.map(([userId, expectedPhone]) => ({ userId, expectedPhone, action: 'clear' as const })),
  };
}

/** The shape of the local data the script was written for: format-only rows plus one collision. */
async function seedLocalShape() {
  await seed('a-survivor', '05550007701');
  await seed('b-gives-up', '5550007701', { emailVerifiedAt: EARLIER });
  await seed('c-format', '05550007702');
  await seed('d-provider', '05550007703', { role: 'PROVIDER' });
  await seed('e-canonical', '+905550001122');
  await seed('f-none', null, { role: 'ADMIN' });
}

describe('dry run', () => {
  it('plans every change and the collision, and writes nothing — even inside a read-only transaction', async () => {
    await seedLocalShape();
    const before = await rows();

    const plan = await inScratch((tx) => planCanonicalization(tx, null), true);

    expect(await rows()).toEqual(before);
    expect(plan).toMatchObject({ scanned: 6, withPhone: 5, alreadyCanonical: 1, unsupported: [] });
    expect(plan.changes.map((change) => [change.userId, change.oldPhone, change.newPhone])).toEqual([
      ['a-survivor', '05550007701', '+905550007701'],
      ['b-gives-up', '5550007701', '+905550007701'],
      ['c-format', '05550007702', '+905550007702'],
      ['d-provider', '05550007703', '+905550007703'],
    ]);
    expect(plan.collisions).toEqual([
      {
        canonicalPhone: '+905550007701',
        resolved: false,
        members: [
          { userId: 'a-survivor', role: 'CUSTOMER', phone: '05550007701', resolution: 'keeps' },
          { userId: 'b-gives-up', role: 'CUSTOMER', phone: '5550007701', resolution: 'keeps' },
        ],
      },
    ]);
    expect(plan.refusals).toEqual(['unresolved collision on one canonical number (2 accounts)']);
  });
});

describe('apply', () => {
  it('rewrites format-only rows to E.164 and touches nothing else', async () => {
    await seed('c-format', '05550007702');
    await seed('d-provider', '0555 000 77 03', { role: 'PROVIDER' });
    await seed('g-country', '905551234567');
    await seed('e-canonical', '+905550001122');
    await seed('f-none', null);
    const before = await rows();

    const result = await inScratch((tx) => applyCanonicalization(tx, null));

    expect(result.applied).toHaveLength(3);
    expect(result.after).toEqual({ nonCanonical: 0, duplicateGroups: 0 });
    const after = await rows();
    const changed = new Set(['c-format', 'd-provider', 'g-country']);
    for (const [index, row] of after.entries()) {
      const was = before[index]!;
      // Only the number and the change stamp move, and only on planned rows.
      expect({ ...row, phone: null, updatedAt: null }).toEqual({ ...was, phone: null, updatedAt: null });
      if (changed.has(row.id)) {
        expect(row.updatedAt.getTime()).toBeGreaterThan(was.updatedAt.getTime());
      } else {
        expect(row).toEqual(was);
      }
    }
    expect(after.map((row) => row.phone)).toEqual(['+905550007702', '+905550007703', '+905550001122', null, '+905551234567']);
  });

  it('refuses a collision without a resolution, changing nothing', async () => {
    await seedLocalShape();
    const before = await rows();

    const refused = await inScratch((tx) => applyCanonicalization(tx, null)).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(CanonicalizationRefused);
    expect(await rows()).toEqual(before);
  });

  it('applies an approved resolution: the survivor keeps the number, the other account only loses it', async () => {
    await seedLocalShape();
    const before = await rows();

    const result = await inScratch((tx) => applyCanonicalization(tx, resolutions(['b-gives-up', '5550007701'])));

    // The clear runs first so the survivor's rewrite has a free number to land on.
    expect(result.applied.map((change) => [change.userId, change.newPhone, change.reason])).toEqual([
      ['b-gives-up', null, 'resolution-clear'],
      ['a-survivor', '+905550007701', 'canonicalize'],
      ['c-format', '+905550007702', 'canonicalize'],
      ['d-provider', '+905550007703', 'canonicalize'],
    ]);
    expect(result.after).toEqual({ nonCanonical: 0, duplicateGroups: 0 });

    const after = await rows();
    expect(after).toHaveLength(before.length);
    const b = after.find((row) => row.id === 'b-gives-up')!;
    expect(b.phone).toBeNull();
    // The address and its proof stay; no phone proof appears anywhere.
    expect(b.email).toBe('b-gives-up@example.test');
    expect(b.emailVerifiedAt).toEqual(EARLIER);
    expect(after.every((row) => row.phoneVerifiedAt === null)).toBe(true);
    expect(after.find((row) => row.id === 'a-survivor')!.phone).toBe('+905550007701');
  });

  it.each([
    ['a value that no longer matches', resolutions(['b-gives-up', '05550007701']), /stored value differs/],
    ['an account outside every collision', resolutions(['b-gives-up', '5550007701'], ['c-format', '05550007702']), /not part of any collision/],
    ['an unknown account', resolutions(['b-gives-up', '5550007701'], ['nobody', '0']), /no such account/],
  ])('refuses a resolution naming %s', async (_label, file, reason) => {
    await seedLocalShape();
    const before = await rows();

    const refused = await inScratch((tx) => applyCanonicalization(tx, file)).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(CanonicalizationRefused);
    expect((refused as CanonicalizationRefused).plan.refusals.join('\n')).toMatch(reason);
    expect(await rows()).toEqual(before);
  });

  it('refuses a value the canonicaliser cannot place, rather than guessing', async () => {
    await seed('c-format', '05550007702');
    await seed('h-junk', '123');
    const before = await rows();

    const refused = await inScratch((tx) => applyCanonicalization(tx, null)).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(CanonicalizationRefused);
    expect((refused as CanonicalizationRefused).plan.unsupported).toEqual([{ userId: 'h-junk', role: 'CUSTOMER', phone: '123' }]);
    expect(await rows()).toEqual(before);
  });

  it('rolls everything back when a row changed after it was planned', async () => {
    await seedLocalShape();
    const before = await rows();

    // Another writer moves d-provider's number between the plan's read and the
    // guarded write; every row written before that point must come back too.
    const aborted = await inScratch((tx) => {
      let first = true;
      const racing = {
        $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
        $executeRawUnsafe: async (query: string, ...values: unknown[]) => {
          if (first) {
            first = false;
            await tx.$executeRawUnsafe(`UPDATE "User" SET "phone" = '+905559990000' WHERE "id" = 'd-provider'`);
          }
          return tx.$executeRawUnsafe(query, ...values);
        },
      } as unknown as Tx;
      return applyCanonicalization(racing, resolutions(['b-gives-up', '5550007701']));
    }).catch((error: unknown) => error);

    expect(aborted).toBeInstanceOf(CanonicalizationAborted);
    expect((aborted as Error).message).toContain('d-provider no longer holds the value the plan read');
    expect(await rows()).toEqual(before);
  });
});

describe('the resolution file', () => {
  it('accepts only the documented shape', () => {
    expect(parseResolutionFile('{"version":1,"resolutions":[{"userId":"b","expectedPhone":"5","action":"clear"}]}')).toEqual(
      resolutions(['b', '5']),
    );
    expect(() => parseResolutionFile('{"version":2,"resolutions":[]}')).toThrow();
    expect(() => parseResolutionFile('{"version":1,"resolutions":[{"userId":"b","action":"delete"}]}')).toThrow();
  });
});
