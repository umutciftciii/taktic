import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The add_provider_service_area_scope migration, run as SQL against data shaped
 * the way the table could be shaped before it.
 *
 * Every other spec in this suite runs against a database the migration has
 * already been applied to, which proves the end state and nothing about the
 * journey. This one seeds the legacy shapes into a scratch schema — the
 * pre-migration table, with no scope column and the old unique index — and runs
 * the committed file over them.
 *
 * What it is here to hold down is the promise the file makes: it adds and never
 * subtracts. No row is deleted, merged, or moved to a different place, and
 * where the data cannot satisfy the new constraints the whole thing stops with
 * the data untouched rather than editing it into shape.
 */
/**
 * PostgreSQL statements, split out of a file.
 *
 * Prisma refuses a raw call carrying more than one command, so the file has to
 * be handed over a statement at a time. Splitting on ";" alone would cut the
 * guard blocks in half — their bodies are full of semicolons — so this walks
 * the text and skips over what a semicolon does not end: line comments, quoted
 * literals, and dollar-quoted bodies.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const rest = sql.slice(index);

    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }

    if (sql[index] === "'") {
      index = endOfQuoted(sql, index);
      continue;
    }

    const dollarTag = /^\$[A-Za-z_0-9]*\$/.exec(rest)?.[0];
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, index + dollarTag.length);
      index = close === -1 ? sql.length : close + dollarTag.length;
      continue;
    }

    if (sql[index] === ';') {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      index += 1;
      start = index;
      continue;
    }

    index += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);

  return statements;
}

/** The index just past a single-quoted literal, '' escapes included. */
function endOfQuoted(sql: string, openQuote: number): number {
  let index = openQuote + 1;
  while (index < sql.length) {
    if (sql[index] !== "'") {
      index += 1;
      continue;
    }
    if (sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

const migrationSql = readFileSync(
  resolve(
    __dirname,
    '../../../prisma/migrations/20260906120000_add_provider_service_area_scope/migration.sql',
  ),
  'utf8',
);

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
  schema = `psa_migration_${process.pid}_${counter}`;

  // The two tables the migration touches, exactly as they stood before it: no
  // scope column, and the old unique index that let a NULL-bearing duplicate
  // through.
  await runStatements(prisma, `
    CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}"."ProviderProfile" (
      "id" TEXT NOT NULL,
      "businessName" TEXT NOT NULL,
      "city" TEXT NOT NULL,
      "district" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProviderProfile_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE "${schema}"."ProviderServiceArea" (
      "id" TEXT NOT NULL,
      "providerId" TEXT NOT NULL,
      "city" TEXT NOT NULL,
      "district" TEXT,
      "neighborhood" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProviderServiceArea_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "ProviderServiceArea_providerId_city_district_neighborhood_key"
      ON "${schema}"."ProviderServiceArea" ("providerId", "city", "district", "neighborhood");
  `);
});

async function seedProvider(id: string, city = 'İstanbul', district = 'Kadıköy') {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."ProviderProfile" ("id","businessName","city","district") VALUES ($1,$2,$3,$4)`,
    id,
    `İşletme ${id}`,
    city,
    district,
  );
}

async function seedArea(
  id: string,
  providerId: string,
  city: string,
  district: string | null,
  neighborhood: string | null,
) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."ProviderServiceArea" ("id","providerId","city","district","neighborhood") VALUES ($1,$2,$3,$4,$5)`,
    id,
    providerId,
    city,
    district,
    neighborhood,
  );
}

/**
 * Runs the migration the way Prisma does: one transaction, so a refusal leaves
 * nothing behind. `SET LOCAL search_path` is what points the file's unqualified
 * table names at the scratch schema, and it is why this has to be one
 * transaction on one connection rather than two statements on a pool.
 */
async function runMigration(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    for (const statement of splitSqlStatements(migrationSql)) {
      await tx.$executeRawUnsafe(statement);
    }
  });
}

/** The same one-statement-at-a-time hand-over, for the scratch schema's setup. */
async function runStatements(client: PrismaClient, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    await client.$executeRawUnsafe(statement);
  }
}

type StoredArea = {
  id: string;
  providerId: string;
  scope: string | null;
  city: string;
  district: string | null;
  neighborhood: string | null;
};

async function readAreas(): Promise<StoredArea[]> {
  return prisma.$queryRawUnsafe<StoredArea[]>(
    `SELECT "id","providerId",NULL::text AS scope,"city","district","neighborhood"
       FROM "${schema}"."ProviderServiceArea" ORDER BY "id"`,
  );
}

async function readAreasWithScope(): Promise<StoredArea[]> {
  return prisma.$queryRawUnsafe<StoredArea[]>(
    `SELECT "id","providerId","scope"::text AS scope,"city","district","neighborhood"
       FROM "${schema}"."ProviderServiceArea" ORDER BY "id"`,
  );
}

describe('the migration keeps every existing area', () => {
  it('preserves ids, providers and places across all three scopes', async () => {
    await seedProvider('p-multi', 'Ankara', 'Çankaya');
    await seedArea('a-city', 'p-multi', 'İstanbul', null, null);
    await seedArea('a-district', 'p-multi', 'İzmir', 'Konak', null);
    await seedArea('a-neighborhood', 'p-multi', 'Bursa', 'Nilüfer', 'Ertuğrul Mah');
    const before = await readAreas();

    await runMigration();

    const after = await readAreasWithScope();
    expect(after.map((area) => area.id)).toEqual(before.map((area) => area.id));
    expect(
      after.map(({ id, providerId, city, district, neighborhood }) => ({
        id,
        providerId,
        city,
        district,
        neighborhood,
      })),
    ).toEqual(
      before.map(({ id, providerId, city, district, neighborhood }) => ({
        id,
        providerId,
        city,
        district,
        neighborhood,
      })),
    );
    expect(after.map((area) => area.scope)).toEqual(['CITY', 'DISTRICT', 'NEIGHBORHOOD']);
  });

  it('keeps an overlapping pair rather than collapsing it', async () => {
    // The shape the migration used to delete. It is redundant coverage, not
    // wrong coverage, and which of the rows to lose was never a migration's
    // decision — the provider removes it from their own screen when they want.
    await seedProvider('p-overlap');
    await seedArea('o-city', 'p-overlap', 'İstanbul', null, null);
    await seedArea('o-district', 'p-overlap', 'İstanbul', 'Kadıköy', null);
    await seedArea('o-neighborhood', 'p-overlap', 'İstanbul', 'Kadıköy', 'Caferağa Mah');

    await runMigration();

    const after = await readAreasWithScope();
    expect(after.map((area) => area.id)).toEqual(['o-city', 'o-district', 'o-neighborhood']);
    expect(after.map((area) => area.scope)).toEqual(['CITY', 'DISTRICT', 'NEIGHBORHOOD']);
  });

  it('never lowers the area count', async () => {
    await seedProvider('p-a');
    await seedProvider('p-b');
    await seedArea('x-1', 'p-a', 'İstanbul', null, null);
    await seedArea('x-2', 'p-a', 'İstanbul', 'Kadıköy', null);
    await seedArea('x-3', 'p-b', 'Ankara', 'Çankaya', null);

    await runMigration();

    expect(await readAreasWithScope()).toHaveLength(3);
  });
});

describe('the migration backfills only what is missing', () => {
  it('gives one area to a provider that had none, from its legacy location', async () => {
    await seedProvider('p-empty', 'İzmir', 'Konak');

    await runMigration();

    expect(await readAreasWithScope()).toEqual([
      {
        id: 'psa_bf_p-empty',
        providerId: 'p-empty',
        scope: 'DISTRICT',
        city: 'İzmir',
        district: 'Konak',
        neighborhood: null,
      },
    ]);
  });

  it('invents nothing for a provider that already has an area', async () => {
    // The legacy pair here (İstanbul/Kadıköy) is deliberately different from
    // the area on file. A backfill that ran anyway would hand this provider
    // coverage nobody asked for, in a district they never claimed.
    await seedProvider('p-has-one', 'İstanbul', 'Kadıköy');
    await seedArea('kept', 'p-has-one', 'Ankara', 'Çankaya', null);

    await runMigration();

    const after = await readAreasWithScope();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'kept', city: 'Ankara', district: 'Çankaya' });
  });

  it('leaves alone a provider whose only area is a whole province', async () => {
    await seedProvider('p-province', 'İstanbul', 'Kadıköy');
    await seedArea('province', 'p-province', 'İstanbul', null, null);

    await runMigration();

    const after = await readAreasWithScope();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'province', scope: 'CITY', district: null });
  });
});

/**
 * The refusals. Each asserts two things: that the migration stopped, and that
 * the rows are exactly as they were — no scope column, nothing deleted, nothing
 * rewritten. The second is what makes stopping safe to do in a release window.
 */
describe('the migration stops rather than repair the data', () => {
  async function expectRefusal(pattern: RegExp) {
    const before = await readAreas();
    await expect(runMigration()).rejects.toThrow(pattern);

    const after = await readAreas();
    expect(after).toEqual(before);
    // Rolled back whole: the column the migration adds first is not there.
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'ProviderServiceArea'`,
      schema,
    );
    expect(columns.map((column) => column.column_name)).not.toContain('scope');
  }

  it('refuses a duplicate area, naming the provider and the place', async () => {
    // Two "all of İstanbul" rows: the old unique index treated the NULLs as
    // distinct and let this through, and the new per-scope index cannot be
    // created over it.
    await seedProvider('p-dup');
    await seedArea('dup-a', 'p-dup', 'İstanbul', null, null);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."ProviderServiceArea" ("id","providerId","city","district","neighborhood")
       VALUES ('dup-b','p-dup','İstanbul',NULL,NULL)`,
    );

    await expectRefusal(/duplicate areas.*p-dup/s);
  });

  it('refuses a neighbourhood with no district', async () => {
    await seedProvider('p-orphan');
    await seedArea('orphan', 'p-orphan', 'Antalya', null, 'Bir Mah');

    await expectRefusal(/neighbourhoods with no district.*orphan/s);
  });

  it('refuses a blank level', async () => {
    await seedProvider('p-blank');
    await seedArea('blank', 'p-blank', 'İstanbul', '   ', null);

    await expectRefusal(/blank city, district or neighbourhood.*blank/s);
  });

  it('refuses to backfill a provider whose legacy location is blank', async () => {
    await seedProvider('p-nolegacy', 'İstanbul', '');

    await expectRefusal(/no usable legacy location.*p-nolegacy/s);
  });

  it('changes nothing for the other providers when one row stops it', async () => {
    await seedProvider('p-good');
    await seedArea('good-1', 'p-good', 'İstanbul', 'Kadıköy', null);
    await seedProvider('p-bad');
    await seedArea('bad-1', 'p-bad', 'Antalya', null, 'Bir Mah');
    await seedProvider('p-empty-too', 'İzmir', 'Konak');

    await expectRefusal(/neighbourhoods with no district/);

    // The backfill for p-empty-too did not happen either: a refusal is all or
    // nothing, so the operator re-runs it once, after fixing p-bad.
    const after = await readAreas();
    expect(after.map((area) => area.id)).toEqual(['bad-1', 'good-1']);
  });
});

describe('after the migration the database enforces the new rules', () => {
  it('refuses a duplicate and a scope that disagrees with its levels', async () => {
    await seedProvider('p-rules');
    await seedArea('rule-1', 'p-rules', 'İstanbul', null, null);
    await runMigration();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."ProviderServiceArea" ("id","providerId","scope","city","district","neighborhood","updatedAt")
         VALUES ('rule-2','p-rules','CITY','İstanbul',NULL,NULL,CURRENT_TIMESTAMP)`,
      ),
      // The per-scope unique index, refusing a second whole-province row. Prisma
      // surfaces the key rather than the index name over a raw call; the index
      // is asserted by name from the catalogue in provider-service-areas.spec.ts.
    ).rejects.toThrow(/\("providerId", city\)=\(p-rules, İstanbul\) already exists/);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."ProviderServiceArea" ("id","providerId","scope","city","district","neighborhood","updatedAt")
         VALUES ('rule-3','p-rules','CITY','Ankara','Çankaya',NULL,CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/ProviderServiceArea_scope_levels/);
  });
});
