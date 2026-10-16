// node --test scripts/ops/migration-recovery.test.mjs
//
// The static half of the P3009 recovery (migration-recovery.mjs) and the
// migrate image's guard (prisma-migrate-guard.sh), with a fake Prisma.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { analyze, blankNonCode, verifySql } from './migration-recovery.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = join(repoRoot, 'prisma/migrations');
const temp = [];
after(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

describe('migration-recovery.mjs analyze', () => {
  it('calls the phone guard migration atomic and lists the CHECK it adds', () => {
    const sql = readFileSync(join(migrationsDir, '20261006120000_user_phone_e164_check/migration.sql'), 'utf8');
    const result = analyze(sql);
    assert.equal(result.atomic, true, result.blockers.join('; '));
    assert.deepEqual(result.objects, [{ kind: 'constraint', schema: 'public', name: 'User', constraint: 'User_phone_e164_check' }]);
  });

  it('finds every migration in the repository atomic (a non-atomic one must be a deliberate, reviewed exception)', () => {
    const names = readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name));
    assert.ok(names.length >= 104);
    const notAtomic = names.filter((name) => !analyze(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8')).atomic);
    assert.deepEqual(notAtomic, []);
  });

  it('refuses a file that commits half-way', () => {
    const result = analyze('CREATE TABLE "LabB" ("id" INTEGER);\nCOMMIT;\nCREATE TABLE "LabC" ("id" INTEGER);\nSELECT 1/0;\n');
    assert.equal(result.atomic, false);
    assert.match(result.blockers.join('\n'), /COMMIT: ends the transaction/);
  });

  for (const [statement, why] of [
    ['BEGIN;', /opens a transaction/],
    ['START TRANSACTION;', /opens a transaction/],
    ['END;', /ends the transaction/],
    ['ROLLBACK;', /ends the transaction/],
    ['SAVEPOINT a;', /transaction control/],
    ['CREATE INDEX CONCURRENTLY "i" ON "T" ("c");', /cannot run inside a transaction block/],
    ['VACUUM "T";', /cannot run inside a transaction block/],
    ['ALTER SYSTEM SET work_mem = 1;', /cannot run inside a transaction block/],
    ['CALL do_things();', /a procedure may commit/],
  ]) {
    it(`refuses ${statement}`, () => {
      const result = analyze(`CREATE TABLE "A" ("id" INTEGER);\n${statement}\n`);
      assert.equal(result.atomic, false);
      assert.match(result.blockers.join('\n'), why);
    });
  }

  it('reads COMMIT/BEGIN inside a PL/pgSQL body, a comment or a literal as text, not as a statement', () => {
    const sql = [
      '-- COMMIT; here is only a comment',
      '/* ROLLBACK; nor here */',
      "INSERT INTO \"Log\" VALUES ('COMMIT; is data');",
      'DO $$ BEGIN IF true THEN RAISE EXCEPTION \'x; COMMIT\'; END IF; END $$;',
      'CREATE FUNCTION "f"() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END; $body$;',
    ].join('\n');
    const result = analyze(sql);
    assert.equal(result.atomic, true, result.blockers.join('; '));
    assert.ok(!blankNonCode(sql).includes('ROLLBACK'));
  });

  it('extracts tables, indexes, types, columns, constraints, functions and triggers', () => {
    const result = analyze(`
      CREATE TYPE "Status" AS ENUM ('A', 'B');
      CREATE TABLE "Thing" ("id" TEXT NOT NULL, CONSTRAINT "Thing_pkey" PRIMARY KEY ("id"));
      CREATE UNIQUE INDEX "Thing_x_key" ON "Thing"("x");
      ALTER TABLE "Other" ADD COLUMN "a" TEXT, ADD COLUMN "b" INTEGER, ADD CONSTRAINT "Other_a_check" CHECK ("a" <> '');
      CREATE FUNCTION "thing_guard"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER "thing_guard" BEFORE UPDATE ON "Thing" FOR EACH ROW EXECUTE FUNCTION "thing_guard"();
      UPDATE "Other" SET "a" = 'x';
    `);
    assert.equal(result.atomic, true);
    assert.deepEqual(
      result.objects.map((o) => `${o.kind}:${o.constraint ?? o.trigger ?? o.column ?? o.name}`),
      ['type:Status', 'relation:Thing', 'relation:Thing_x_key', 'column:a', 'column:b', 'constraint:Other_a_check', 'function:thing_guard', 'trigger:thing_guard'],
    );
    assert.deepEqual(result.atomicOnly, ['UPDATE "Other" SET']);
  });

  it('leaves an object the file drops and creates again to atomicity, since it exists after a rollback too', () => {
    const result = analyze('ALTER TABLE "P" DROP CONSTRAINT "P_range";\nALTER TABLE "P" ADD CONSTRAINT "P_range" CHECK ("n" >= 0);\n');
    assert.deepEqual(result.objects, []);
    assert.match(result.atomicOnly.join('\n'), /P_range \(dropped and created again by this file\)/);
  });

  it('builds a SELECT that only reads catalogs and quotes identifiers safely', () => {
    const sql = verifySql(analyze(`CREATE TABLE "We'ird" ("id" INTEGER);\nALTER TABLE "We'ird" ADD COLUMN "c" INTEGER;`).objects);
    assert.match(sql, /^SELECT 'relation', 'We''ird', \(to_regclass\('"public"\."We''ird"'\) IS NOT NULL\)::int/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
  });
});

/** The guard script with its /app paths pointed at a scratch image root and a fake prisma. */
function guardRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'taktic-guard-test-'));
  temp.push(dir);
  mkdirSync(join(dir, 'prisma/migrations/20261006120000_user_phone_e164_check'), { recursive: true });
  writeFileSync(join(dir, 'prisma/migrations/20261006120000_user_phone_e164_check/migration.sql'), 'SELECT 1;\n');
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/.bin/prisma'), `#!/bin/sh\necho "prisma $*" >> "${join(dir, 'prisma.log')}"\n`);
  chmodSync(join(dir, 'node_modules/.bin/prisma'), 0o755);
  const guard = readFileSync(join(repoRoot, 'scripts/ops/prisma-migrate-guard.sh'), 'utf8').replaceAll('/app/', `${dir}/`);
  writeFileSync(join(dir, 'guard.sh'), guard);
  return dir;
}

function guard(dir, args, env = {}) {
  const result = spawnSync('sh', [join(dir, 'guard.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://placeholder', ...env },
  });
  let log = '';
  try {
    log = readFileSync(join(dir, 'prisma.log'), 'utf8');
  } catch {}
  return { code: result.status, stderr: result.stderr, log };
}

describe('prisma-migrate-guard.sh resolve-rolled-back', () => {
  const NAME = '20261006120000_user_phone_e164_check';
  const staging = { APP_ENVIRONMENT: 'staging', TAKTIC_RESOLVE_CONFIRM: NAME };

  it('runs migrate resolve --rolled-back on staging with the confirmation, and nothing else', () => {
    const dir = guardRoot();
    const result = guard(dir, ['resolve-rolled-back', NAME], staging);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.log.trim(), `prisma migrate resolve --rolled-back ${NAME} --schema ${dir}/prisma/schema.prisma`);
  });

  for (const [label, args, env, why] of [
    ['production', ['resolve-rolled-back', NAME], { ...staging, APP_ENVIRONMENT: 'production' }, /only where APP_ENVIRONMENT=staging \(got 'production'\)/],
    ['no APP_ENVIRONMENT', ['resolve-rolled-back', NAME], { TAKTIC_RESOLVE_CONFIRM: NAME }, /got 'unset'/],
    ['no confirmation', ['resolve-rolled-back', NAME], { APP_ENVIRONMENT: 'staging' }, /TAKTIC_RESOLVE_CONFIRM does not name/],
    ['a confirmation for another migration', ['resolve-rolled-back', NAME], { ...staging, TAKTIC_RESOLVE_CONFIRM: '20260101000000_other' }, /does not name/],
    ['a migration the image does not carry', ['resolve-rolled-back', '20990101000000_absent'], { ...staging, TAKTIC_RESOLVE_CONFIRM: '20990101000000_absent' }, /carries no migration/],
    ['a name that is not a migration directory', ['resolve-rolled-back', '../../etc'], { ...staging, TAKTIC_RESOLVE_CONFIRM: '../../etc' }, /not a migration directory name/],
    ['extra arguments', ['resolve-rolled-back', NAME, '--applied'], staging, /exactly one migration name/],
    ['migrate resolve --applied', ['resolve', '--applied', NAME], staging, /exactly one command expected/],
    ['a bare resolve', ['resolve'], staging, /refused: 'resolve' is not one of/],
  ]) {
    it(`refuses ${label}, before Prisma starts`, () => {
      const dir = guardRoot();
      const result = guard(dir, args, env);
      assert.equal(result.code, 64, result.stderr);
      assert.match(result.stderr, why);
      assert.equal(result.log, '', 'prisma was started');
    });
  }

  it('keeps the four original commands', () => {
    const dir = guardRoot();
    assert.equal(guard(dir, ['status']).code, 0);
    assert.equal(guard(dir, ['migrations']).code, 0);
    assert.match(guard(dir, ['status']).log, /prisma migrate status --schema/);
  });
});
