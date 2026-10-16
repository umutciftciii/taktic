#!/usr/bin/env node
// Static analysis of one Prisma migration.sql, for the P3009 recovery
// (scripts/ops/migration-recover.sh, STAGING-P3009-HARDENING-001).
//
//   node scripts/ops/migration-recovery.mjs analyze    < migration.sql
//   node scripts/ops/migration-recovery.mjs verify-sql < migration.sql
//
// Why this exists. `prisma migrate deploy` sends a migration file to
// PostgreSQL as one simple-query string. PostgreSQL runs a multi-statement
// simple query as ONE implicit transaction, so when any statement fails,
// everything the file did before it — DDL and DML — is rolled back. That holds
// only while the file itself does not end the transaction: an explicit
// COMMIT (or BEGIN/END/ROLLBACK, or a statement that refuses to run inside a
// transaction block, such as CREATE INDEX CONCURRENTLY) splits it, and the
// part before the split stays applied while Prisma still records
// applied_steps_count = 0 (proven against Prisma 6 in CI's ops job). So
// `migrate resolve --rolled-back` is safe only for a file this tool calls
// atomic, and even then the recovery also checks, on the live database, that
// none of the objects the file creates exists.
//
// `analyze` prints one line per finding and exits 0 when the file is atomic,
// 1 when it is not (a recovery must then restore or fix forward), 2 on usage.
// `verify-sql` prints a read-only SELECT returning `kind|name|present` rows,
// present = 1 when the object exists now. Neither prints anything but
// identifiers from the file.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The file with comments, string literals and dollar-quoted bodies blanked,
 * so that a `COMMIT` inside a PL/pgSQL body or a comment is not read as a
 * statement and a `;` inside a literal does not split one. Double-quoted
 * identifiers are kept: they are what the object checks need.
 */
export function blankNonCode(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (ch === "'") {
      // E'…' escapes are handled by skipping a backslash-escaped quote too.
      const escaped = /[eE]$/.test(out);
      i += 1;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += "''";
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
        out += '$$ $$';
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function statements(sql) {
  return blankNonCode(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;

/** An identifier as PostgreSQL stores it: quoted kept exact, bare folded to lower case. */
export function identName(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
  return text.toLowerCase();
}

function qualified(raw) {
  const parts = raw.match(new RegExp(IDENT, 'g')).map(identName);
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: 'public', name: parts[0] };
}

/** Statements that end, split or refuse the implicit transaction. */
const NON_ATOMIC = [
  [/^(BEGIN|START TRANSACTION)\b/i, 'opens a transaction of its own'],
  [/^(COMMIT|END|ROLLBACK|ABORT)\b/i, 'ends the transaction: what ran before it stays applied'],
  [/^(SAVEPOINT|RELEASE|PREPARE TRANSACTION)\b/i, 'transaction control'],
  [/\bCONCURRENTLY\b/i, 'cannot run inside a transaction block'],
  [/^VACUUM\b/i, 'cannot run inside a transaction block'],
  [/^(CREATE|DROP) DATABASE\b/i, 'cannot run inside a transaction block'],
  [/^(CREATE|DROP) TABLESPACE\b/i, 'cannot run inside a transaction block'],
  [/^ALTER SYSTEM\b/i, 'cannot run inside a transaction block'],
  [/^CALL\b/i, 'a procedure may commit'],
];

export function analyze(sql) {
  const blockers = [];
  const objects = [];
  const atomicOnly = [];
  const list = statements(sql);
  if (list.length === 0) blockers.push('the file holds no statement');
  // Names this file drops. An object it drops and creates again (a CHECK
  // replaced under the same name) exists after a clean rollback too, so its
  // presence proves nothing either way: such an object is left to atomicity.
  const dropped = new Set();
  for (const stmt of list) {
    for (const d of stmt.matchAll(new RegExp(String.raw`\bDROP (?:CONSTRAINT|INDEX|TABLE|TYPE|TRIGGER|FUNCTION|COLUMN|SEQUENCE|VIEW|MATERIALIZED VIEW) (?:IF EXISTS )?(${QUALIFIED})`, 'gi'))) {
      dropped.add(qualified(d[1]).name);
    }
  }
  const keep = (object, label) => {
    const name = object.constraint ?? object.trigger ?? object.column ?? object.name;
    if (dropped.has(name)) atomicOnly.push(`${label} ${name} (dropped and created again by this file)`);
    else objects.push(object);
  };
  for (const stmt of list) {
    for (const [pattern, why] of NON_ATOMIC) {
      if (pattern.test(stmt)) blockers.push(`${stmt.split(' ').slice(0, 4).join(' ')}: ${why}`);
    }
    let m;
    if ((m = new RegExp(String.raw`^CREATE (?:UNLOGGED )?TABLE (IF NOT EXISTS )?(${QUALIFIED})`, 'i').exec(stmt))) {
      if (m[1]) atomicOnly.push(`CREATE TABLE IF NOT EXISTS ${qualified(m[2]).name}`);
      else keep({ kind: 'relation', ...qualified(m[2]) }, 'CREATE TABLE');
    } else if ((m = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (IF NOT EXISTS )?(${IDENT}) ON (?:ONLY )?(${QUALIFIED})`, 'i').exec(stmt))) {
      if (m[1]) atomicOnly.push(`CREATE INDEX IF NOT EXISTS ${identName(m[2])}`);
      else keep({ kind: 'relation', schema: qualified(m[3]).schema, name: identName(m[2]) }, 'CREATE INDEX');
    } else if ((m = new RegExp(String.raw`^CREATE (?:SEQUENCE|VIEW|MATERIALIZED VIEW) (IF NOT EXISTS )?(${QUALIFIED})`, 'i').exec(stmt))) {
      if (m[1]) atomicOnly.push(`${stmt.split(' ').slice(0, 2).join(' ')} IF NOT EXISTS`);
      else keep({ kind: 'relation', ...qualified(m[2]) }, 'CREATE RELATION');
    } else if ((m = new RegExp(String.raw`^CREATE TYPE (${QUALIFIED})`, 'i').exec(stmt))) {
      keep({ kind: 'type', ...qualified(m[1]) }, 'CREATE TYPE');
    } else if ((m = new RegExp(String.raw`^CREATE FUNCTION (${QUALIFIED})`, 'i').exec(stmt))) {
      keep({ kind: 'function', ...qualified(m[1]) }, 'CREATE FUNCTION');
    } else if ((m = new RegExp(String.raw`^CREATE (?:CONSTRAINT )?TRIGGER (${IDENT}) .*? ON (?:ONLY )?(${QUALIFIED})`, 'i').exec(stmt))) {
      keep({ kind: 'trigger', ...qualified(m[2]), trigger: identName(m[1]) }, 'CREATE TRIGGER');
    } else if ((m = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QUALIFIED}) (.*)$`, 'i').exec(stmt))) {
      const table = qualified(m[1]);
      let found = false;
      for (const add of m[2].matchAll(new RegExp(String.raw`\bADD COLUMN (IF NOT EXISTS )?(${IDENT})`, 'gi'))) {
        found = true;
        if (add[1]) atomicOnly.push(`ADD COLUMN IF NOT EXISTS ${identName(add[2])}`);
        else keep({ kind: 'column', ...table, column: identName(add[2]) }, 'ADD COLUMN');
      }
      for (const add of m[2].matchAll(new RegExp(String.raw`\bADD CONSTRAINT (${IDENT})`, 'gi'))) {
        found = true;
        keep({ kind: 'constraint', ...table, constraint: identName(add[1]) }, 'ADD CONSTRAINT');
      }
      if (!found) atomicOnly.push(`ALTER TABLE ${table.name} …`);
    } else {
      atomicOnly.push(stmt.split(' ').slice(0, 3).join(' '));
    }
  }
  return { atomic: blockers.length === 0, blockers, objects, atomicOnly };
}

const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const reg = (schema, name) => lit(`"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`);

/** One read-only SELECT: a `kind|name|present` row per object. */
export function verifySql(objects) {
  if (objects.length === 0) return "SELECT 'none' AS kind, '-' AS name, 0 AS present WHERE false";
  const rows = objects.map((o) => {
    switch (o.kind) {
      case 'relation':
        return `SELECT 'relation', ${lit(o.name)}, (to_regclass(${reg(o.schema, o.name)}) IS NOT NULL)::int`;
      case 'column':
        return `SELECT 'column', ${lit(`${o.name}.${o.column}`)}, (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${reg(o.schema, o.name)}) AND attname = ${lit(o.column)} AND NOT attisdropped))::int`;
      case 'constraint':
        return `SELECT 'constraint', ${lit(o.constraint)}, (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(${reg(o.schema, o.name)}) AND conname = ${lit(o.constraint)}))::int`;
      case 'type':
        return `SELECT 'type', ${lit(o.name)}, (EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${lit(o.schema)} AND t.typname = ${lit(o.name)}))::int`;
      case 'function':
        return `SELECT 'function', ${lit(o.name)}, (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${lit(o.schema)} AND p.proname = ${lit(o.name)}))::int`;
      case 'trigger':
        return `SELECT 'trigger', ${lit(o.trigger)}, (EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(${reg(o.schema, o.name)}) AND tgname = ${lit(o.trigger)}))::int`;
      default:
        throw new Error(`unknown object kind ${o.kind}`);
    }
  });
  return rows.join('\nUNION ALL\n');
}

function main(argv) {
  const [command] = argv;
  if (command !== 'analyze' && command !== 'verify-sql') {
    process.stderr.write('usage: migration-recovery.mjs analyze|verify-sql < migration.sql\n');
    return 2;
  }
  const result = analyze(readFileSync(0, 'utf8'));
  if (command === 'verify-sql') {
    process.stdout.write(`${verifySql(result.objects)}\n`);
    return 0;
  }
  for (const blocker of result.blockers) process.stdout.write(`BLOCKER ${blocker}\n`);
  for (const o of result.objects) {
    const name = o.kind === 'column' ? `${o.name}.${o.column}` : o.kind === 'constraint' ? o.constraint : o.kind === 'trigger' ? o.trigger : o.name;
    process.stdout.write(`OBJECT ${o.kind} ${name}\n`);
  }
  for (const entry of result.atomicOnly) process.stdout.write(`ATOMIC-ONLY ${entry}\n`);
  process.stdout.write(result.atomic ? 'migration-recovery: ATOMIC\n' : 'migration-recovery: NOT ATOMIC\n');
  return result.atomic ? 0 : 1;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
