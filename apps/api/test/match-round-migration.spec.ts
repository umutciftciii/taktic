import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roundInconsistencies } from './match-round-consistency';
import { ensureTestDatabaseExists } from './provision-test-database';
import { assertIsTestDatabase, resolveTestDatabaseUrl } from './test-database';

/**
 * REL-002 — the M1 and M2 migrations against representative databases.
 *
 * A scratch database next to the suite's own (`…_m1_test`, the same `_test`
 * guard) is migrated to the state right before M1 with the real migration
 * chain, filled with one request per shape the backfill has to handle, and then
 * taken through M1 with `prisma migrate deploy` — exactly what a deployment
 * runs. The round rows are compared field by field with what the mapping says,
 * and a second case proves the verification block refuses (and rolls back) a
 * database whose winner is not an accepted offer.
 *
 * M2 (Faz 2) is taken the same way from a post-M1 database: rows an older
 * release wrote without a round between M1 and M2 are re-backfilled, then the
 * columns are enforced and the uniques swapped; a database M2 cannot enforce is
 * refused whole.
 */

const M1 = '20261011120000_add_service_request_match_rounds';
const M2 = '20261011180000_enforce_round_matching_core';
const repoRoot = resolve(__dirname, '../../..');
const migrationsRoot = join(repoRoot, 'prisma/migrations');

function scratchUrl(): string {
  const url = new URL(resolveTestDatabaseUrl());
  const name = url.pathname.replace(/^\//, '').replace(/_test$/, '');
  url.pathname = `/${name.slice(0, 63 - '_m1_test'.length)}_m1_test`;
  return url.toString();
}

const databaseUrl = scratchUrl();
let workDir: string;
let prisma: PrismaClient;

/**
 * A throwaway prisma/ directory holding the chain up to and including `upTo`
 * (by name; the lock file always), or only what comes before it when
 * `inclusive` is false.
 */
function stageMigrations(upTo: string, inclusive = true) {
  const staged = join(workDir, 'migrations');
  rmSync(staged, { recursive: true, force: true });
  for (const entry of readdirSync(migrationsRoot)) {
    const isMigration = entry !== 'migration_lock.toml';
    if (isMigration && (inclusive ? entry > upTo : entry >= upTo)) continue;
    cpSync(join(migrationsRoot, entry), join(staged, entry), { recursive: true });
  }
}

/** Every migration in the repository, applied on top of whatever is there. */
function deployToLatest() {
  stageMigrations('99999999999999_latest');
  deploy();
}

function deploy() {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', join(workDir, 'schema.prisma')], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

async function freshPreM1Database() {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  stageMigrations(M1, false);
  deploy();
}

const sql = (statement: string) => prisma.$executeRawUnsafe(statement);

/** Timestamps as Prisma stores them: UTC wall-clock in a `timestamp(3)`. */
const at = (iso: string) => `'${iso.replace('T', ' ').replace('Z', '')}'`;
const date = (iso: string) => new Date(iso);

beforeAll(async () => {
  assertIsTestDatabase(databaseUrl);
  await ensureTestDatabaseExists(databaseUrl);
  workDir = mkdtempSync(join(tmpdir(), 'rel002-m1-'));
  cpSync(join(repoRoot, 'prisma/schema.prisma'), join(workDir, 'schema.prisma'));
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await freshPreM1Database();
}, 120_000);

async function seedParties() {
  await sql(`INSERT INTO "User" (id, role, "updatedAt") VALUES
    ('u_customer', 'CUSTOMER', now()), ('u_p1', 'PROVIDER', now()), ('u_p2', 'PROVIDER', now())`);
  await sql(`INSERT INTO "ServiceCategory" (id, name, slug, "updatedAt") VALUES ('cat', 'Klima', 'klima', now())`);
  await sql(`INSERT INTO "ProviderProfile" (id, "userId", "businessName", "contactName", phone, city, district, "updatedAt") VALUES
    ('p1', 'u_p1', 'Bir', 'Bir', '+905550000001', 'İstanbul', 'Kadıköy', now()),
    ('p2', 'u_p2', 'İki', 'İki', '+905550000002', 'İstanbul', 'Kadıköy', now())`);
}

type RequestFixture = {
  id: string;
  status: string;
  approvedAt?: string;
  reminderSentAt?: string;
  matchedOfferId?: string;
  matchedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  expiredAt?: string;
  showcaseLeadId?: string;
  directShowcaseProviderId?: string;
};

const SUBMITTED_AT = '2026-09-01T08:00:00.000Z';

async function insertRequest(r: RequestFixture) {
  const optional = (value: string | undefined, render: (v: string) => string = at) =>
    value === undefined ? 'NULL' : render(value);
  const text = (v: string) => `'${v}'`;
  await sql(`INSERT INTO "ServiceRequest" (
      id, "categoryId", "customerId", status, "customerName", "customerPhone", city, district,
      "submittedAt", "approvedAt", "reminderSentAt", "matchedOfferId", "matchedAt",
      "completedAt", "cancelledAt", "expiredAt", "showcaseLeadId", "directShowcaseProviderId", "updatedAt")
    VALUES ('${r.id}', 'cat', 'u_customer', '${r.status}', 'Müşteri', '+905554440000', 'İstanbul', 'Kadıköy',
      ${at(SUBMITTED_AT)}, ${optional(r.approvedAt)}, ${optional(r.reminderSentAt)},
      ${optional(r.matchedOfferId, text)}, ${optional(r.matchedAt)},
      ${optional(r.completedAt)}, ${optional(r.cancelledAt)}, ${optional(r.expiredAt)},
      ${optional(r.showcaseLeadId, text)}, ${optional(r.directShowcaseProviderId, text)}, now())`);
}

async function insertOffer(id: string, requestId: string, providerId: string, status: string) {
  await sql(`INSERT INTO "Offer" (id, "requestId", "providerId", status, "priceAmount", message, "updatedAt")
    VALUES ('${id}', '${requestId}', '${providerId}', '${status}', 1000, 'Teklif', now())`);
}

describe('M1 backfill on a representative pre-M1 database', () => {
  it('writes exactly one Round 1 per request with the documented mapping, and attaches everything to it', async () => {
    await seedParties();

    const APPROVED_AT = '2026-09-02T09:00:00.000Z';
    const REMINDED_AT = '2026-09-09T09:00:00.000Z';
    const MATCHED_AT = '2026-09-03T10:00:00.000Z';

    // The match columns are filled in after the offers exist (FK), below.
    const requests: RequestFixture[] = [
      { id: 'r_draft', status: 'DRAFT' },
      { id: 'r_submitted', status: 'SUBMITTED' },
      // Approved once, then pulled back into review: no live offer period.
      { id: 'r_in_review', status: 'IN_REVIEW', approvedAt: APPROVED_AT },
      { id: 'r_approved', status: 'APPROVED', approvedAt: APPROVED_AT, reminderSentAt: REMINDED_AT },
      // Approved before approvedAt existed: no time is invented.
      { id: 'r_approved_legacy', status: 'APPROVED' },
      { id: 'r_rejected', status: 'REJECTED', approvedAt: APPROVED_AT },
      { id: 'r_matched', status: 'MATCHED', approvedAt: APPROVED_AT },
      { id: 'r_completed', status: 'COMPLETED', approvedAt: APPROVED_AT },
      { id: 'r_cancelled_match', status: 'CANCELLED', approvedAt: APPROVED_AT },
      { id: 'r_cancelled', status: 'CANCELLED', cancelledAt: '2026-09-04T12:00:00.000Z' },
      { id: 'r_expired', status: 'EXPIRED', approvedAt: APPROVED_AT, expiredAt: '2026-09-16T09:00:00.000Z' },
    ];
    for (const r of requests) await insertRequest(r);

    // Two vitrin leads, written with foreign-key triggers off for this one
    // statement: the lead rows themselves (card, placement, version…) are not
    // what this case is about, only the two columns the source rule reads.
    await prisma.$transaction([
      prisma.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
      prisma.$executeRawUnsafe(`INSERT INTO "ServiceRequest" (
          id, "categoryId", status, "customerName", "customerPhone", city, district, "submittedAt",
          "approvedAt", "showcaseLeadId", "directShowcaseProviderId", "updatedAt")
        VALUES
          ('r_direct', 'cat', 'APPROVED', 'M', '+905554440001', 'İstanbul', 'Kadıköy', ${at(SUBMITTED_AT)},
           ${at(APPROVED_AT)}, 'lead_held', 'p1', now()),
          ('r_released', 'cat', 'SUBMITTED', 'M', '+905554440002', 'İstanbul', 'Kadıköy', ${at(SUBMITTED_AT)},
           NULL, 'lead_released', NULL, now())`),
    ]);

    await insertOffer('o_matched', 'r_matched', 'p1', 'ACCEPTED');
    await insertOffer('o_matched_loser', 'r_matched', 'p2', 'REJECTED');
    await insertOffer('o_completed', 'r_completed', 'p2', 'ACCEPTED');
    await insertOffer('o_cancelled', 'r_cancelled_match', 'p1', 'CANCELLED');
    await insertOffer('o_open', 'r_approved', 'p2', 'SUBMITTED');
    await sql(`UPDATE "ServiceRequest" SET "matchedOfferId" = 'o_matched', "matchedAt" = ${at(MATCHED_AT)} WHERE id = 'r_matched'`);
    await sql(`UPDATE "ServiceRequest" SET "matchedOfferId" = 'o_completed', "matchedAt" = ${at(MATCHED_AT)},
      "completedAt" = '2026-09-05 10:00:00' WHERE id = 'r_completed'`);
    await sql(`UPDATE "ServiceRequest" SET "matchedOfferId" = 'o_cancelled', "matchedAt" = ${at(MATCHED_AT)},
      "cancelledAt" = '2026-09-06 10:00:00' WHERE id = 'r_cancelled_match'`);

    await sql(`INSERT INTO "ContactRevealEvent" (id, "requestId", "offerId", "providerId", "disclosureVersion") VALUES
      ('e_matched', 'r_matched', 'o_matched', 'p1', 'v1'),
      ('e_completed', 'r_completed', 'o_completed', 'p2', 'v1')`);
    await sql(`INSERT INTO "MessageThread" (id, "requestId", "offerId", "customerUserId", "providerId", "providerUserId", "updatedAt")
      VALUES ('t_matched', 'r_matched', 'o_matched', 'u_customer', 'p1', 'u_p1', now())`);

    stageMigrations(M1);
    deploy();

    const rounds = await prisma.serviceRequestMatchRound.findMany({
      orderBy: { requestId: 'asc' },
      select: {
        id: true,
        requestId: true,
        roundNumber: true,
        status: true,
        source: true,
        openedBy: true,
        openedAt: true,
        publishedAt: true,
        expiresAt: true,
        reminderSentAt: true,
        matchedAt: true,
        matchedOfferId: true,
        matchedProviderId: true,
        failedAt: true,
        completedAt: true,
        cancelledAt: true,
        expiredAt: true,
      },
    });

    const base = (requestId: string) => ({
      id: `mr1_${requestId}`,
      requestId,
      roundNumber: 1,
      openedBy: 'REQUEST_CREATED',
      openedAt: date(SUBMITTED_AT),
      source: 'MARKETPLACE',
      publishedAt: null,
      expiresAt: null,
      reminderSentAt: null,
      matchedAt: null,
      matchedOfferId: null,
      matchedProviderId: null,
      failedAt: null,
      completedAt: null,
      cancelledAt: null,
      expiredAt: null,
    });
    const published = { publishedAt: date(APPROVED_AT), expiresAt: date('2026-09-16T09:00:00.000Z') };

    expect(rounds).toEqual(
      [
        { ...base('r_approved'), status: 'OPEN', ...published, reminderSentAt: date(REMINDED_AT) },
        { ...base('r_approved_legacy'), status: 'OPEN' },
        {
          ...base('r_cancelled'),
          status: 'CANCELLED',
          cancelledAt: date('2026-09-04T12:00:00.000Z'),
        },
        {
          ...base('r_cancelled_match'),
          status: 'CANCELLED',
          ...published,
          matchedAt: date(MATCHED_AT),
          matchedOfferId: 'o_cancelled',
          matchedProviderId: 'p1',
          cancelledAt: date('2026-09-06T10:00:00.000Z'),
        },
        {
          ...base('r_completed'),
          status: 'COMPLETED',
          ...published,
          matchedAt: date(MATCHED_AT),
          matchedOfferId: 'o_completed',
          matchedProviderId: 'p2',
          completedAt: date('2026-09-05T10:00:00.000Z'),
        },
        { ...base('r_direct'), status: 'OPEN', source: 'DIRECT_SHOWCASE', ...published },
        { ...base('r_draft'), status: 'OPEN' },
        {
          ...base('r_expired'),
          status: 'EXPIRED',
          ...published,
          expiredAt: date('2026-09-16T09:00:00.000Z'),
        },
        { ...base('r_in_review'), status: 'OPEN' },
        {
          ...base('r_matched'),
          status: 'MATCHED',
          ...published,
          matchedAt: date(MATCHED_AT),
          matchedOfferId: 'o_matched',
          matchedProviderId: 'p1',
        },
        { ...base('r_rejected'), status: 'OPEN', ...published },
        // A released lead is a marketplace request.
        { ...base('r_released'), status: 'OPEN' },
        { ...base('r_submitted'), status: 'OPEN' },
      ].sort((a, b) => a.requestId.localeCompare(b.requestId)),
    );

    const links = await prisma.$queryRawUnsafe<Array<{ kind: string; id: string; round: string | null }>>(`
      SELECT 'request' AS kind, id, "currentRoundId" AS round FROM "ServiceRequest"
      UNION ALL SELECT 'offer', id, "matchRoundId" FROM "Offer"
      UNION ALL SELECT 'reveal', id, "roundId" FROM "ContactRevealEvent"
      UNION ALL SELECT 'thread', id, "roundId" FROM "MessageThread"
      ORDER BY 1, 2`);
    expect(links.filter((row) => row.kind !== 'request')).toEqual([
      { kind: 'offer', id: 'o_cancelled', round: 'mr1_r_cancelled_match' },
      { kind: 'offer', id: 'o_completed', round: 'mr1_r_completed' },
      { kind: 'offer', id: 'o_matched', round: 'mr1_r_matched' },
      { kind: 'offer', id: 'o_matched_loser', round: 'mr1_r_matched' },
      { kind: 'offer', id: 'o_open', round: 'mr1_r_approved' },
      { kind: 'reveal', id: 'e_completed', round: 'mr1_r_completed' },
      { kind: 'reveal', id: 'e_matched', round: 'mr1_r_matched' },
      { kind: 'thread', id: 't_matched', round: 'mr1_r_matched' },
    ]);
    expect(links.filter((row) => row.kind === 'request').every((row) => row.round === `mr1_${row.id}`)).toBe(true);

    // And the operators' check agrees with the backfill, row for row. The
    // check is the current release's (it reads M3's tables), so the database
    // is carried through the rest of the chain first — every later migration
    // must apply on top of this backfill, and none of them rewrites a row.
    deployToLatest();
    expect(await roundInconsistencies(prisma)).toEqual([]);
  });

  it('refuses — and rolls back entirely — when a matched request’s winner is not an accepted offer', async () => {
    await seedParties();
    await insertRequest({ id: 'r_bad', status: 'MATCHED', approvedAt: '2026-09-02T09:00:00.000Z' });
    await insertOffer('o_bad', 'r_bad', 'p1', 'SUBMITTED');
    await sql(`UPDATE "ServiceRequest" SET "matchedOfferId" = 'o_bad', "matchedAt" = now() WHERE id = 'r_bad'`);

    stageMigrations(M1);
    let output = '';
    try {
      deploy();
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer };
      output = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`;
    }
    expect(output).toContain('REL-002 M1 backfill verification failed');
    expect(output).toContain('winner_not_accepted=1');

    // Nothing of M1 is left behind: one transaction.
    const [left] = await prisma.$queryRawUnsafe<Array<{ table: string | null; column: bigint }>>(`
      SELECT to_regclass('public."ServiceRequestMatchRound"')::text AS table,
             (SELECT count(*) FROM information_schema.columns
               WHERE table_name = 'ServiceRequest' AND column_name = 'currentRoundId') AS column`);
    expect(left?.table).toBeNull();
    expect(Number(left?.column)).toBe(0);
  });
});

/** Deploys the staged chain and returns prisma's output when it fails. */
function deployExpectingFailure(): string {
  try {
    deploy();
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    return `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`;
  }
  return '';
}

async function indexNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY 1`,
    table,
  );
  return rows.map((row) => row.indexname);
}

describe('M2 enforce on a post-M1 database', () => {
  async function postM1WithLegacyRows() {
    stageMigrations(M1);
    deploy();
    await seedParties();
    // Written as the application wrote them since M1 (with rounds)…
    await insertRequest({ id: 'r_live', status: 'APPROVED', approvedAt: '2026-09-02T09:00:00.000Z' });
    await sql(`INSERT INTO "ServiceRequestMatchRound" (id, "requestId", "roundNumber", status, source, "openedBy",
        "openedAt", "publishedAt", "expiresAt", "updatedAt")
      VALUES ('mr1_r_live', 'r_live', 1, 'OPEN', 'MARKETPLACE', 'REQUEST_CREATED', ${at(SUBMITTED_AT)},
        '2026-09-02 09:00:00', '2026-09-16 09:00:00', now())`);
    await sql(`UPDATE "ServiceRequest" SET "currentRoundId" = 'mr1_r_live' WHERE id = 'r_live'`);
    await insertOffer('o_live', 'r_live', 'p1', 'SUBMITTED');
    await sql(`UPDATE "Offer" SET "matchRoundId" = 'mr1_r_live' WHERE id = 'o_live'`);
    // …and as an older release wrote them between M1 and M2: no round at all.
    await insertRequest({ id: 'r_window', status: 'APPROVED', approvedAt: '2026-09-03T09:00:00.000Z' });
    await insertOffer('o_window', 'r_window', 'p2', 'SUBMITTED');
    await insertOffer('o_window_late', 'r_live', 'p2', 'SUBMITTED');
  }

  it('re-backfills the deploy window, enforces NOT NULL, swaps the uniques and leaves a consistent database', async () => {
    await postM1WithLegacyRows();
    expect(await indexNames('Offer')).toContain('Offer_providerId_requestId_key');

    stageMigrations(M2);
    deploy();

    const links = await prisma.$queryRawUnsafe<Array<{ kind: string; id: string; round: string }>>(`
      SELECT 'request' AS kind, id, "currentRoundId" AS round FROM "ServiceRequest"
      UNION ALL SELECT 'offer', id, "matchRoundId" FROM "Offer" ORDER BY 1, 2`);
    expect(links).toEqual([
      { kind: 'offer', id: 'o_live', round: 'mr1_r_live' },
      { kind: 'offer', id: 'o_window', round: 'mr1_r_window' },
      { kind: 'offer', id: 'o_window_late', round: 'mr1_r_live' },
      { kind: 'request', id: 'r_live', round: 'mr1_r_live' },
      { kind: 'request', id: 'r_window', round: 'mr1_r_window' },
    ]);
    expect(
      await prisma.serviceRequestMatchRound.findUniqueOrThrow({
        where: { id: 'mr1_r_window' },
        select: { status: true, publishedAt: true },
      }),
    ).toEqual({ status: 'OPEN', publishedAt: date('2026-09-03T09:00:00.000Z') });

    const offerIndexes = await indexNames('Offer');
    expect(offerIndexes).toEqual(
      expect.arrayContaining(['Offer_providerId_matchRoundId_key', 'Offer_one_accepted_per_round', 'Offer_id_matchRoundId_key']),
    );
    expect(offerIndexes).not.toContain('Offer_providerId_requestId_key');
    expect(offerIndexes).not.toContain('Offer_one_accepted_per_request');
    expect(await indexNames('ContactRevealEvent')).not.toContain('ContactRevealEvent_requestId_key');
    expect(await indexNames('MessageThread')).not.toContain('MessageThread_requestId_key');

    const nullable = await prisma.$queryRawUnsafe<Array<{ table_name: string; is_nullable: string }>>(`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'ServiceRequest' AND column_name = 'currentRoundId') OR
        (table_name = 'Offer' AND column_name = 'matchRoundId') OR
        (table_name IN ('ContactRevealEvent', 'MessageThread') AND column_name = 'roundId'))
      ORDER BY 1`);
    expect(nullable.every((row) => row.is_nullable === 'NO')).toBe(true);

    // A request inserted after M2 without a round is born with its Round 1.
    await insertRequest({ id: 'r_after', status: 'SUBMITTED' });
    expect(
      await prisma.serviceRequestMatchRound.findUniqueOrThrow({
        where: { id: 'mr1_r_after' },
        select: { roundNumber: true, status: true, publishedAt: true },
      }),
    ).toEqual({ roundNumber: 1, status: 'OPEN', publishedAt: null });

    // The current release's check, after the rest of the chain (M3) applies.
    deployToLatest();
    expect(await roundInconsistencies(prisma)).toEqual([]);
  });

  it('refuses — and rolls back entirely — when an offer sits in another request’s round', async () => {
    await postM1WithLegacyRows();
    await sql(`UPDATE "Offer" SET "matchRoundId" = 'mr1_r_live' WHERE id = 'o_window'`);

    stageMigrations(M2);
    const output = deployExpectingFailure();
    expect(output).toContain('REL-002 M2 verification failed');
    expect(output).toMatch(/offers_bad_round=1/);

    // Nothing of M2 is left behind: the window's rows are still round-less,
    // the per-request uniques still stand, the columns are still nullable.
    expect(await indexNames('Offer')).toContain('Offer_providerId_requestId_key');
    const [row] = await prisma.$queryRawUnsafe<Array<{ round: string | null }>>(
      `SELECT "currentRoundId" AS round FROM "ServiceRequest" WHERE id = 'r_window'`,
    );
    expect(row?.round).toBeNull();
  });
});
