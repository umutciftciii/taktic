import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_PHONE_PATTERN, normalizePhoneNumber } from '../src/modules/phone-verification/phone.util';
import { splitSqlStatements } from './sql-statements';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The user_phone_e164_check migration (AUTH-REG-002), run as SQL against a
 * "User" table shaped the way it stood before it.
 *
 * Every other spec runs against a database the migration has already been
 * applied to — and whose CHECK now refuses the very rows this file has to
 * start from — so the journey is proved here, in a scratch schema: a table
 * still holding a non-canonical number stops the migration with the data and
 * the schema untouched; a clean one gets the constraint.
 */

const migrationSql = readFileSync(
  resolve(__dirname, '../../../prisma/migrations/20261006120000_user_phone_e164_check/migration.sql'),
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
  schema = `phone_e164_migration_${process.pid}_${counter}`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  // The columns the migration reads, and the byte-exact unique index it keeps.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${schema}"."User" (
      "id" TEXT NOT NULL,
      "phone" TEXT,
      CONSTRAINT "User_pkey" PRIMARY KEY ("id")
    )`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "User_phone_key" ON "${schema}"."User" ("phone")`);
});

async function seed(id: string, phone: string | null) {
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."User" ("id","phone") VALUES ($1,$2)`, id, phone);
}

/** One transaction on one connection, as Prisma runs a migration file. */
async function runMigration(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    for (const statement of splitSqlStatements(migrationSql)) {
      await tx.$executeRawUnsafe(statement);
    }
  });
}

async function constraintDefinition(): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.conname = 'User_phone_e164_check'`,
    schema,
  );
  return rows[0]?.def ?? null;
}

async function phones(): Promise<Array<{ id: string; phone: string | null }>> {
  return prisma.$queryRawUnsafe(`SELECT "id","phone" FROM "${schema}"."User" ORDER BY "id"`);
}

describe('the migration and the application state one rule', () => {
  it('carries the application pattern byte for byte, in the guard and in the constraint', () => {
    const literal = `'${CANONICAL_PHONE_PATTERN.source}'`;
    expect(migrationSql.split(literal).length - 1).toBeGreaterThanOrEqual(3);
    // Nothing else is matched against: no country-specific rule of its own.
    expect(migrationSql.match(/'\^[^']*'/g)?.every((pattern) => pattern === literal)).toBe(true);
  });

  it('admits exactly what normalizePhoneNumber returns', () => {
    for (const typed of ['05321234567', '0532 123 45 67', '5321234567', '905321234567', '+49 30 1234567', '0049301234567']) {
      expect(normalizePhoneNumber(typed)).toMatch(CANONICAL_PHONE_PATTERN);
    }
    for (const stored of ['05321234567', '5321234567', '905321234567', '+90 532 123 45 67', '', '+0532123456']) {
      expect(stored).not.toMatch(CANONICAL_PHONE_PATTERN);
    }
  });
});

describe('a table still holding a non-canonical number', () => {
  it('stops the migration and leaves the data and the schema as they were', async () => {
    await seed('a', '+905321234567');
    await seed('b', '05329998877');
    await seed('c', null);
    const before = await phones();

    await expect(runMigration()).rejects.toThrow(/1 User\.phone value\(s\) are not canonical E\.164/);

    expect(await phones()).toEqual(before);
    expect(await constraintDefinition()).toBeNull();
  });

  it.each(['5329998877', '905329998877', '+90 532 999 88 77', ''])('stops on %j too', async (value) => {
    await seed('a', value);
    await expect(runMigration()).rejects.toThrow(/not canonical E\.164/);
    expect(await constraintDefinition()).toBeNull();
  });
});

describe('a clean table', () => {
  it('gets the constraint, and keeps every row as it was', async () => {
    await seed('a', '+905321234567');
    await seed('b', '+4930123456');
    await seed('c', null);
    await seed('d', null);
    const before = await phones();

    await runMigration();

    expect(await phones()).toEqual(before);
    expect(await constraintDefinition()).toBe(
      `CHECK (((phone IS NULL) OR (phone ~ '${CANONICAL_PHONE_PATTERN.source}'::text)))`,
    );
  });

  it('from then on refuses a non-canonical number and still admits several NULLs', async () => {
    await runMigration();

    await expect(seed('x', '05321234567')).rejects.toThrow(/User_phone_e164_check/);
    await seed('n1', null);
    await seed('n2', null);
    await seed('ok', '+905321234567');
    expect((await phones()).map((row) => row.id)).toEqual(['n1', 'n2', 'ok']);
  });
});
