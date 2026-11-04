import { PrismaClient, UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseReset,
  isResetStatement,
  loadResetPlan,
  RESET_MODES,
  resolveResetMode,
  type ResetClient,
  type ResetMode,
} from './database-reset';
import {
  createApprovedRequest,
  createCategory,
  createUser,
  databaseResetTables,
  loginAs,
  resetDatabase,
  restoreMigrationRows,
} from './harness';
import { maintenanceUrlFor } from './provision-test-database';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * CI-PERF-004: `delete` must be indistinguishable from `truncate` to everything
 * that runs after it, and neither may ever run where it should not.
 *
 * Most of this works on a scratch schema, because the real schema has no
 * sequences to compare and no trigger a schema change has not yet added. The
 * block on the real tables comes last.
 */

const url = resolveTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url } } });
/** One connection, so "the same connection afterwards" is what is being tested. */
const onlyConnection = new PrismaClient({
  datasources: { db: { url: `${url}${url.includes('?') ? '&' : '?'}connection_limit=1` } },
});

const SCHEMA = `reset_fixture_${process.pid}`;
const s = (name: string) => `"${SCHEMA}"."${name}"`;
const sql = (statement: string) => prisma.$executeRawUnsafe(statement);

const TABLES = { seeds: ['parent'], keep: ['kept'], schema: SCHEMA };

/**
 * The shapes the real schema has or could grow: a FK cycle through a deferred
 * constraint, RESTRICT, SET NULL and CASCADE references, an append-only table,
 * owned sequences of both kinds with a non-default start, a sequence nobody
 * owns, a table reached only through the closure, and one the reset must keep.
 */
async function createFixture() {
  await sql(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await sql(`CREATE SCHEMA "${SCHEMA}"`);
  await sql(`CREATE SEQUENCE ${s('loose')} START 500`);
  await sql(`CREATE TABLE ${s('parent')} (id bigserial PRIMARY KEY, tag text, pinned bigint)`);
  await sql(`CREATE TABLE ${s('child')} (
    id int GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5) PRIMARY KEY,
    parent_id bigint NOT NULL REFERENCES ${s('parent')} ON DELETE RESTRICT,
    ticket bigint NOT NULL DEFAULT nextval('${s('loose')}'))`);
  await sql(`ALTER TABLE ${s('parent')} ADD CONSTRAINT pinned_fk FOREIGN KEY (pinned)
    REFERENCES ${s('child')} DEFERRABLE INITIALLY DEFERRED`);
  await sql(`CREATE TABLE ${s('audit')} (
    id serial PRIMARY KEY,
    parent_id bigint REFERENCES ${s('parent')} ON DELETE SET NULL,
    note text)`);
  await sql(`CREATE FUNCTION ${s('refuse')}() RETURNS trigger LANGUAGE plpgsql AS
    $f$ BEGIN RAISE EXCEPTION 'append-only'; END $f$`);
  await sql(`CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON ${s('audit')}
    FOR EACH ROW EXECUTE FUNCTION ${s('refuse')}()`);
  await sql(`CREATE TABLE ${s('reached_only')} (
    parent_id bigint REFERENCES ${s('parent')} ON DELETE CASCADE)`);
  await sql(`CREATE TABLE ${s('kept')} (id int PRIMARY KEY, label text)`);
  await sql(`INSERT INTO ${s('kept')} VALUES (1, 'stays')`);
}

async function populate() {
  await sql(`INSERT INTO ${s('parent')} (tag) VALUES ('a'), ('b')`);
  await sql(`INSERT INTO ${s('child')} (parent_id) VALUES (1), (2)`);
  await sql(`UPDATE ${s('parent')} SET pinned = 100 WHERE id = 1`);
  await sql(`INSERT INTO ${s('audit')} (parent_id, note) VALUES (1, 'x')`);
  await sql(`INSERT INTO ${s('reached_only')} VALUES (2)`);
}

async function rows(table: string): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${s(table)}`,
  );
  return row!.n;
}

/** Everything a later statement could observe of what a reset left behind. */
async function observe() {
  const sequence = async (name: string) =>
    (
      await prisma.$queryRawUnsafe<{ last_value: bigint; is_called: boolean }[]>(
        `SELECT last_value, is_called FROM ${s(name)}`,
      )
    )[0]!;
  const state = {
    rows: {
      parent: await rows('parent'),
      child: await rows('child'),
      audit: await rows('audit'),
      reached_only: await rows('reached_only'),
      kept: await rows('kept'),
    },
    sequences: {
      parent: await sequence('parent_id_seq'),
      child: await sequence('child_id_seq'),
      audit: await sequence('audit_id_seq'),
      loose: await sequence('loose'),
    },
  };

  // The next rows get these ids; the triggers and constraints still bite.
  const [parent] = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
    `INSERT INTO ${s('parent')} (tag) VALUES ('next') RETURNING id`,
  );
  const [child] = await prisma.$queryRawUnsafe<{ id: number; ticket: bigint }[]>(
    `INSERT INTO ${s('child')} (parent_id) VALUES (${parent!.id}) RETURNING id, ticket`,
  );
  await sql(`INSERT INTO ${s('audit')} (parent_id, note) VALUES (${parent!.id}, 'y')`);

  const failure = async (statement: string) => {
    try {
      await sql(statement);
      return 'accepted';
    } catch (error) {
      return (error as { meta?: { code?: string } }).meta?.code ?? 'raised';
    }
  };
  return {
    ...state,
    next: { parent: parent!.id, child: child!.id, ticket: child!.ticket },
    enforced: {
      foreignKey: await failure(`INSERT INTO ${s('child')} (parent_id) VALUES (999999)`),
      restrict: await failure(`DELETE FROM ${s('parent')} WHERE id = ${parent!.id}`),
      appendOnly: await failure(`DELETE FROM ${s('audit')}`),
    },
  };
}

function resetter(mode: ResetMode, tables = TABLES) {
  return createDatabaseReset({ mode, ...tables });
}

beforeAll(async () => {
  await prisma.$connect();
  await onlyConnection.$connect();
});

afterAll(async () => {
  await sql(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$disconnect();
  await onlyConnection.$disconnect();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TEST_DB_RESET', () => {
  it('defaults to truncate, and refuses what it does not know', () => {
    vi.stubEnv('TEST_DB_RESET', undefined);
    expect(resolveResetMode()).toBe('truncate');
    vi.unstubAllEnvs();
    expect(resolveResetMode('  ')).toBe('truncate');
    expect(resolveResetMode('truncate')).toBe('truncate');
    expect(resolveResetMode('delete')).toBe('delete');

    for (const bad of ['DELETE', 'drop', 'truncate;']) {
      expect(() => resolveResetMode(bad), bad).toThrow(/TEST_DB_RESET must be one of/);
    }
  });
});

describe('what delete leaves behind', () => {
  beforeEach(createFixture);

  it('is what truncate leaves behind, down to the next id', async () => {
    const after: Record<string, unknown> = {};
    for (const mode of RESET_MODES) {
      await createFixture();
      await populate();
      await resetter(mode).run(prisma);
      after[mode] = await observe();
    }

    expect(after.delete).toEqual(after.truncate);
    expect(after.truncate).toMatchObject({
      rows: { parent: 0, child: 0, audit: 0, reached_only: 0, kept: 1 },
      sequences: {
        parent: { last_value: 1n, is_called: false },
        // Its own START, not 1.
        child: { last_value: 100n, is_called: false },
        audit: { last_value: 1n, is_called: false },
        // Nobody owns it, so RESTART IDENTITY leaves it where it was.
        loose: { last_value: 501n, is_called: true },
      },
      next: { parent: 1n, child: 100, ticket: 502n },
      enforced: { foreignKey: '23503', restrict: '23503', appendOnly: 'P0001' },
    });
  });

  it('reaches the tables only the closure reaches, and restarts their sequences', async () => {
    const plan = await loadResetPlan(prisma, { mode: 'delete', ...TABLES });

    expect(plan.tables).toEqual(['audit', 'child', 'parent', 'reached_only']);
    expect(plan.sequences).toEqual(['audit_id_seq', 'child_id_seq', 'parent_id_seq']);
    expect(plan.statement).toMatch(/SET LOCAL session_replication_role = replica/);
    expect(plan.statement).toMatch(/IN ACCESS EXCLUSIVE MODE/);
    expect(plan.statement).not.toMatch(/"kept"\s*;/);
    expect(isResetStatement(plan.statement)).toBe(true);
    expect(isResetStatement((await loadResetPlan(prisma, { mode: 'truncate', ...TABLES })).statement)).toBe(true);
  });

  it.each(RESET_MODES)('%s waits for a writer still in flight, and takes its rows too', async (mode) => {
    let commit!: () => void;
    const released = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let inserted!: () => void;
    const hasInserted = new Promise<void>((resolve) => {
      inserted = resolve;
    });

    const writer = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO ${s('parent')} (tag) VALUES ('in flight')`);
        inserted();
        await released;
      },
      { timeout: 30_000 },
    );
    await hasInserted;

    const reset = resetter(mode);
    await reset.planFor(prisma);
    const resetting = reset.run(prisma);

    await vi.waitFor(
      async () => {
        const waiting = await prisma.$queryRawUnsafe<{ query: string }[]>(
          `SELECT query FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        expect(waiting.filter(({ query }) => isResetStatement(query))).toHaveLength(1);
      },
      { timeout: 10_000, interval: 20 },
    );

    commit();
    await writer;
    await resetting;
    expect(await rows('parent')).toBe(0);
  });
});

describe('replica mode ends with the statement', () => {
  const role = async () =>
    (
      await onlyConnection.$queryRawUnsafe<{ role: string; pid: number }[]>(
        `SELECT current_setting('session_replication_role') AS role, pg_backend_pid() AS pid`,
      )
    )[0]!;

  beforeEach(async () => {
    await createFixture();
    await populate();
  });

  it('after a reset that worked, on the very same connection', async () => {
    const before = await role();

    await resetter('delete').run(onlyConnection);

    expect(await role()).toEqual({ role: 'origin', pid: before.pid });
    await expect(
      onlyConnection.$executeRawUnsafe(`INSERT INTO ${s('child')} (parent_id) VALUES (999999)`),
    ).rejects.toMatchObject({ meta: { code: '23503' } });
    await onlyConnection.$executeRawUnsafe(`INSERT INTO ${s('audit')} (note) VALUES ('z')`);
    await expect(
      onlyConnection.$executeRawUnsafe(`DELETE FROM ${s('audit')}`),
    ).rejects.toThrow(/append-only/);
  });

  it('after a reset that failed, and takes everything it did back with it', async () => {
    const reset = resetter('delete');
    await reset.planFor(onlyConnection);
    // After the plan's checks: replica mode now does not silence this trigger,
    // so the block fails partway through its deletes.
    await sql(`ALTER TABLE ${s('audit')} ENABLE ALWAYS TRIGGER audit_append_only`);
    const before = await role();

    await expect(reset.run(onlyConnection)).rejects.toThrow(/append-only/);

    expect(await role()).toEqual({ role: 'origin', pid: before.pid });
    expect(await rows('parent')).toBe(2);
    expect(await rows('child')).toBe(2);
    expect(await rows('audit')).toBe(1);
    expect(await rows('reached_only')).toBe(1);
  });
});

describe('a reset that cannot be trusted stops everything after it', () => {
  beforeEach(async () => {
    await createFixture();
    await populate();
  });

  it.each(RESET_MODES)('%s: a failure is permanent, and later resets touch nothing', async (mode) => {
    const reset = resetter(mode);
    await reset.planFor(prisma);
    await sql(`DROP TABLE ${s('reached_only')}`);
    await sql(`DROP TABLE ${s('audit')}`);
    await sql(`ALTER TABLE ${s('child')} DROP CONSTRAINT child_parent_id_fkey`);
    await sql(`ALTER TABLE ${s('parent')} DROP CONSTRAINT pinned_fk`);
    await sql(`DROP TABLE ${s('child')}`);
    await sql(`DROP TABLE ${s('parent')}`);

    await expect(reset.run(prisma)).rejects.toThrow(/does not exist|42P01/);

    const queried = vi.spyOn(prisma, '$queryRawUnsafe');
    const executed = vi.spyOn(prisma, '$executeRawUnsafe');
    await expect(reset.run(prisma)).rejects.toThrow(/An earlier database reset failed/);
    expect(queried).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  it.each(RESET_MODES)('%s: rows written after the reset committed are caught', async (mode) => {
    const reset = resetter(mode);
    const real = prisma.$executeRawUnsafe.bind(prisma);
    const late: ResetClient = {
      $queryRawUnsafe: prisma.$queryRawUnsafe.bind(prisma),
      $executeRawUnsafe: (async (query: string, ...values: unknown[]) => {
        const result = await real(query, ...values);
        if (isResetStatement(query)) {
          await real(`INSERT INTO ${s('parent')} (tag) VALUES ('late')`);
        }
        return result;
      }) as ResetClient['$executeRawUnsafe'],
    };

    await expect(reset.run(late)).rejects.toThrow(/Rows survived the reset in .*\.parent/);
  });

  it('a kept table that changed stops the reset before it deletes anything', async () => {
    const reset = resetter('delete');
    await reset.planFor(prisma);
    await sql(`INSERT INTO ${s('kept')} VALUES (2, 'leaked')`);

    await expect(reset.run(prisma)).rejects.toThrow(/A table no reset clears has changed/);
    expect(await rows('parent')).toBe(2);
  });

  it('a connection left in replica mode stops the reset before it deletes anything', async () => {
    const reset = resetter('delete');
    await reset.planFor(onlyConnection);
    await onlyConnection.$executeRawUnsafe('SET session_replication_role = replica');

    try {
      await expect(reset.run(onlyConnection)).rejects.toThrow(/session_replication_role=replica/);
      expect(await rows('parent')).toBe(2);
    } finally {
      await onlyConnection.$executeRawUnsafe('RESET session_replication_role');
    }
  });
});

describe('the plan refuses what it cannot vouch for', () => {
  beforeEach(createFixture);

  it.each(RESET_MODES)('%s: a table nothing would empty', async (mode) => {
    await sql(`CREATE TABLE ${s('stray')} (id int)`);

    await expect(loadResetPlan(prisma, { mode, ...TABLES })).rejects.toThrow(/nothing would empty .*\.stray/);
  });

  it.each(RESET_MODES)('%s: a table named but gone', async (mode) => {
    await expect(
      loadResetPlan(prisma, { mode, ...TABLES, seeds: ['parent', 'gone'] }),
    ).rejects.toThrow(/do not exist: gone/);
  });

  it.each(RESET_MODES)('%s: a kept table the cascade would empty', async (mode) => {
    await expect(
      loadResetPlan(prisma, { mode, ...TABLES, keep: ['kept', 'audit'] }),
    ).rejects.toThrow(/must be kept/);
  });

  const unmatchable: [string, string, RegExp][] = [
    [
      'a trigger enabled ALWAYS',
      `ALTER TABLE ${s('audit')} ENABLE ALWAYS TRIGGER audit_append_only`,
      /triggers replica mode does not silence/,
    ],
    [
      'a trigger enabled REPLICA',
      `ALTER TABLE ${s('audit')} ENABLE REPLICA TRIGGER audit_append_only`,
      /triggers replica mode does not silence/,
    ],
    [
      'an ON TRUNCATE trigger',
      `CREATE TRIGGER t BEFORE TRUNCATE ON ${s('child')} EXECUTE FUNCTION ${s('refuse')}()`,
      /ON TRUNCATE triggers/,
    ],
    [
      'a rule',
      `CREATE RULE r AS ON DELETE TO ${s('child')} DO INSTEAD NOTHING`,
      /have rules/,
    ],
    ['row security', `ALTER TABLE ${s('child')} ENABLE ROW LEVEL SECURITY`, /row security/],
    [
      'a partitioned table',
      `CREATE TABLE ${s('split')} (id bigint, parent_id bigint REFERENCES ${s('parent')}) PARTITION BY HASH (id)`,
      /are not plain tables/,
    ],
  ];

  it.each(unmatchable)('delete: %s, while truncate has no objection', async (_label, statement, expected) => {
    await sql(statement);

    await expect(loadResetPlan(prisma, { mode: 'delete', ...TABLES })).rejects.toThrow(expected);
    await expect(loadResetPlan(prisma, { mode: 'truncate', ...TABLES })).resolves.toBeDefined();
  });
});

describe('it only ever runs against a test database', () => {
  it.each(RESET_MODES)('%s: the server is asked, whatever the client was built from', async (mode) => {
    const elsewhere = new PrismaClient({ datasources: { db: { url: maintenanceUrlFor(url) } } });
    const executed = vi.spyOn(elsewhere, '$executeRawUnsafe');
    try {
      await expect(createDatabaseReset({ mode, ...databaseResetTables }).run(elsewhere)).rejects.toThrow(
        /Refusing to run tests against "postgres"/,
      );
      expect(executed).not.toHaveBeenCalled();
    } finally {
      await elsewhere.$disconnect();
    }
  });

  it('refuses a standby', async () => {
    const standby = {
      $queryRawUnsafe: async () => [{ database: 'taktic_x_test', inRecovery: true }],
      $executeRawUnsafe: async () => 0,
    } as unknown as ResetClient;

    await expect(loadResetPlan(standby, { mode: 'delete', ...TABLES })).rejects.toThrow(/read-only standby/);
  });
});

/**
 * Inside a transaction that is rolled back, so the role, its grants and the
 * parameter ACL never exist outside it, and no login or password is involved.
 */
describe('privileges', () => {
  const ROLE = `reset_fixture_role_${process.pid}`;

  class Rollback extends Error {}

  async function asRole(
    setup: string[],
    body: (tx: ResetClient) => Promise<void>,
  ): Promise<void> {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE ROLE "${ROLE}" NOLOGIN`);
          for (const statement of setup) {
            await tx.$executeRawUnsafe(statement);
          }
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ROLE}"`);
          await body(tx);
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);
  }

  /** The owner's rights on the tables and sequences, without its superuser. */
  const OWNER_RIGHTS = [`GRANT "${new URL(url).username}" TO "${ROLE}"`];

  beforeEach(async () => {
    await createFixture();
    await populate();
  });

  it('delete: a role that may not set the parameter is told so before anything runs', async () => {
    await asRole(OWNER_RIGHTS, async (tx) => {
      const [{ superuser }] = (await tx.$queryRawUnsafe<{ superuser: string }[]>(
        `SELECT current_setting('is_superuser') AS superuser`,
      )) as [{ superuser: string }];
      expect(superuser).toBe('off');

      await expect(loadResetPlan(tx, { mode: 'delete', ...TABLES })).rejects.toThrow(
        /needs a superuser, or GRANT SET ON PARAMETER session_replication_role/,
      );
    });
  });

  it('delete: and the server would have refused it anyway', async () => {
    await asRole(OWNER_RIGHTS, async (tx) => {
      await expect(
        tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
      ).rejects.toThrow(/permission denied to set parameter/);
    });
  });

  it('delete: the parameter grant alone is enough, with no superuser anywhere', async () => {
    await asRole(
      [...OWNER_RIGHTS, `GRANT SET ON PARAMETER session_replication_role TO "${ROLE}"`],
      async (tx) => {
        await createDatabaseReset({ mode: 'delete', ...TABLES }).run(tx);

        const [{ n }] = (await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${s('audit')}`,
        )) as [{ n: number }];
        expect(n).toBe(0);
      },
    );
  });

  it.each(RESET_MODES)('%s: a role without table rights is told so before anything runs', async (mode) => {
    await asRole(
      [
        `GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${ROLE}"`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${ROLE}"`,
        `GRANT SET ON PARAMETER session_replication_role TO "${ROLE}"`,
      ],
      async (tx) => {
        await expect(loadResetPlan(tx, { mode, ...TABLES })).rejects.toThrow(
          new RegExp(`this role lacks ${mode.toUpperCase()} on`),
        );
      },
    );
  });
});

describe('privileges the check afterwards needs', () => {
  const ROLE = `reset_fixture_reader_${process.pid}`;

  beforeEach(createFixture);

  it.each(RESET_MODES)('%s: a role that could write but not read is refused before it writes', async (mode) => {
    const refused = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE ROLE "${ROLE}" NOLOGIN`);
        await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${ROLE}"`);
        await tx.$executeRawUnsafe(`GRANT DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${ROLE}"`);
        await tx.$executeRawUnsafe(`GRANT SET ON PARAMETER session_replication_role TO "${ROLE}"`);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ROLE}"`);
        await loadResetPlan(tx, { mode, ...TABLES });
      },
      { timeout: 30_000 },
    );

    await expect(refused).rejects.toThrow(/this role cannot read/);
  });
});

describe('on the real tables', () => {
  async function everyTableCount(tables: string[]) {
    const selects = tables.map(
      (table) => `SELECT '${table}' AS "table", count(*)::int AS n FROM "public"."${table}"`,
    );
    const counted = await prisma.$queryRawUnsafe<{ table: string; n: number }[]>(selects.join(' UNION ALL '));
    return counted.filter((row) => row.n > 0);
  }

  it('the plan covers every table but the migration history', async () => {
    const plan = await loadResetPlan(prisma, { mode: 'delete', ...databaseResetTables });
    const [{ total }] = (await prisma.$queryRawUnsafe<{ total: number }[]>(
      `SELECT count(*)::int AS total FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'f')`,
    )) as [{ total: number }];

    expect(plan.tables).toHaveLength(total - 1);
    expect(plan.tables).not.toContain('_prisma_migrations');
    // Named by no list; a DELETE of the list alone would have left these behind.
    expect(plan.tables).toEqual(
      expect.arrayContaining(['OperationsSettings', 'ManualCreditOperation', 'ShowcaseEntitlement']),
    );
    expect(plan.sequences).toEqual([]);
  });

  describe.each(RESET_MODES)('%s', (mode) => {
    const reset = createDatabaseReset({ mode, ...databaseResetTables, afterReset: restoreMigrationRows });

    beforeEach(async () => {
      await resetDatabase(prisma);
    });

    it('empties them, keeps the history, and leaves every guard working', async () => {
      const plan = await reset.planFor(prisma);
      const history = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "_prisma_migrations"`,
      );

      const admin = await createUser(prisma, { role: UserRole.ADMIN });
      await loginAs(prisma, admin.id);
      const category = await createCategory(prisma);
      await createApprovedRequest(prisma, { categoryId: category.id });
      await prisma.operationsSettings.create({ data: { unviewedOfferRefundWindowHours: 48 } });
      await prisma.accountStatusChange.create({
        data: { userId: admin.id, userRole: UserRole.ADMIN, fromActive: true, toActive: false, actorId: admin.id },
      });
      expect((await everyTableCount(plan.tables)).length).toBeGreaterThan(6);

      await reset.run(prisma);

      expect(await everyTableCount(plan.tables)).toEqual([{ table: 'OpsAlertRoutingSettings', n: 1 }]);
      expect(
        await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "_prisma_migrations"`),
      ).toEqual(history);

      // The application's own transactions: triggers, foreign keys, on as ever.
      const user = await createUser(prisma, { role: UserRole.ADMIN });
      const change = await prisma.accountStatusChange.create({
        data: { userId: user.id, userRole: UserRole.ADMIN, fromActive: true, toActive: false, actorId: user.id },
      });
      await expect(prisma.accountStatusChange.delete({ where: { id: change.id } })).rejects.toThrow();
      expect(await prisma.accountStatusChange.count()).toBe(1);
      await expect(
        prisma.session.create({ data: { id: 'orphan', userId: 'nobody', expiresAt: new Date() } }),
      ).rejects.toMatchObject({ code: 'P2003' });
      const nextCategory = await createCategory(prisma, 'Boya');
      const request = await createApprovedRequest(prisma, { categoryId: nextCategory.id });
      // ServiceRequest_round_one_at_birth, a BEFORE INSERT trigger.
      expect(await prisma.serviceRequestMatchRound.count({ where: { requestId: request.id } })).toBe(1);
    });
  });
});
