import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bitmapOnlyPlan, rebuildTables } from './planner-table-state';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * CI-HARDEN-001. The helper's only job is to stop a plan spec from passing on
 * files it did not rebuild, so what is proven is that it refuses, against a real
 * server: the helper it replaced found its tables with a regex over the SQL, and
 * a statement spelled `FROM "User" u` matched nothing and rebuilt nothing.
 */
let db: PrismaClient;

const filenode = async (table: string): Promise<string> => {
  const [row] = await db.$queryRawUnsafe<Array<{ node: string }>>(
    `SELECT relfilenode::text AS node FROM pg_class WHERE oid = to_regclass($1)`,
    `public."${table}"`,
  );
  return row!.node;
};

const statement = (query: string) => ({ query, params: '[]' });

beforeAll(() => {
  db = new PrismaClient({ datasources: { db: { url: resolveTestDatabaseUrl() } } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('rebuildTables', () => {
  it('gives every named table new files', async () => {
    const before = [await filenode('User'), await filenode('Offer')];
    await rebuildTables(db, ['User', 'Offer']);
    expect(await filenode('User')).not.toBe(before[0]);
    expect(await filenode('Offer')).not.toBe(before[1]);
  });

  it('refuses an empty list, which would prove nothing', async () => {
    await expect(rebuildTables(db, [])).rejects.toThrow(/no tables/);
  });

  it.each(['NoSuchTable', 'user', 'User"; DROP TABLE "Offer', 'pg_class'])(
    'refuses %s, which is no table of the schema, and rebuilds nothing',
    async (missing) => {
      const before = await filenode('User');
      await expect(rebuildTables(db, ['User', missing])).rejects.toThrow(/not tables of the public schema/);
      expect(await filenode('User')).toBe(before);
    },
  );

  it('fails when PostgreSQL refuses the rebuild', async () => {
    // Inside a transaction, where VACUUM is an error.
    await expect(db.$transaction((tx) => rebuildTables(tx, ['User']))).rejects.toThrow(/cannot run inside a transaction block/);
  });

  it('fails when PostgreSQL skips the table and reports success', async () => {
    // Without ownership VACUUM warns and returns normally: no error to catch,
    // the same files as before. One connection, so that SET ROLE holds for it.
    const role = `planner_state_${randomBytes(6).toString('hex')}`;
    const url = new URL(resolveTestDatabaseUrl());
    url.searchParams.set('connection_limit', '1');
    const narrow = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await db.$executeRawUnsafe(`CREATE ROLE "${role}"`);
      await narrow.$executeRawUnsafe(`SET ROLE "${role}"`);
      await expect(rebuildTables(narrow, ['User'])).rejects.toThrow(/"User" was not rebuilt/);
    } finally {
      await narrow.$disconnect();
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
});

describe('bitmapOnlyPlan', () => {
  it('rebuilds a table the statement names under an alias', async () => {
    const before = await filenode('User');
    await bitmapOnlyPlan(db, statement('SELECT count(*) FROM "User" u'), ['User']);
    expect(await filenode('User')).not.toBe(before);
  });

  it('returns the nodes and indexes of the plan', async () => {
    const plan = await bitmapOnlyPlan(db, statement(`SELECT id FROM "User" WHERE email = 'a@b.c'`), ['User']);
    // Either index of the column will do: which one wins depends on what earlier
    // files of the shard left in the table, and this spec resets nothing.
    expect(plan).toContain('Bitmap Index Scan');
    expect(plan.some((node) => node.startsWith('User_email_'))).toBe(true);
  });

  it('fails when the plan reads a table the list does not name', async () => {
    const join = 'SELECT count(*) FROM "User" u JOIN "ProviderProfile" p ON p."userId" = u.id';
    await expect(bitmapOnlyPlan(db, statement(join), ['User'])).rejects.toThrow(/reads "ProviderProfile"/);
  });

  it('sees a table read only in a subquery', async () => {
    const nested = 'SELECT (SELECT count(*) FROM "ProviderProfile"), id FROM "User"';
    await expect(bitmapOnlyPlan(db, statement(nested), ['User'])).rejects.toThrow(/reads "ProviderProfile"/);
  });

  it('fails when the list names a table the plan does not read', async () => {
    await expect(bitmapOnlyPlan(db, statement('SELECT count(*) FROM "User"'), ['User', 'Offer'])).rejects.toThrow(/does not read "Offer"/);
  });

  it('fails when the plan reads no table at all', async () => {
    await expect(bitmapOnlyPlan(db, statement('SELECT 1'), ['User'])).rejects.toThrow(/does not read "User"/);
  });
});
