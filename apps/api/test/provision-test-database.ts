import { PrismaClient } from '@prisma/client';
import {
  assertIsTestDatabase,
  databaseNameOf,
  isAutoProvisionable,
} from './test-database';

/**
 * Creates this checkout's test database when it does not exist yet.
 *
 * `prisma migrate deploy` applies migrations to a database; it does not create
 * one. Before per-checkout naming that gap was invisible, because everybody
 * shared a `taktic_test` somebody had created once. Now every checkout asks for
 * a database nobody has created, so the suite has to either make it or say
 * plainly that it cannot.
 *
 * What this is allowed to do is deliberately narrow:
 *
 *   - It connects to PostgreSQL's own `postgres` maintenance database, never to
 *     the application database. CREATE DATABASE is a cluster-level statement;
 *     no table and no row anywhere else is written by this step.
 *   - It creates only a name that has already cleared assertIsTestDatabase, so
 *     the statement can never name a development or production database.
 *   - It creates only on loopback. On any other host the run stops with an
 *     error that says which database to create and how, because a test suite
 *     inventing databases on a server it did not set up is not a trade this
 *     project wants to make.
 *
 * Databases are never dropped. The same checkout reuses its own database on the
 * next run, which is what makes the first run the only slow one.
 */

/** PostgreSQL's own maintenance database, present in every stock cluster. */
const MAINTENANCE_DATABASE = 'postgres';

/** SQLSTATE 42P04 — another process won the race and created it first. */
const DUPLICATE_DATABASE = '42P04';

export type ProvisionOutcome = 'existing' | 'created';

export type ProvisionDeps = {
  /** Whether the target database can be connected to right now. */
  canConnect: (databaseUrl: string) => Promise<boolean>;
  /** Issues CREATE DATABASE for `name` over a connection to `maintenanceUrl`. */
  createDatabase: (maintenanceUrl: string, name: string) => Promise<void>;
};

/**
 * The same server, addressed by its maintenance database.
 *
 * Everything else about the URL — credentials, port, parameters — is carried
 * over untouched, so the connection this makes is the one the operator already
 * configured.
 */
export function maintenanceUrlFor(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${MAINTENANCE_DATABASE}`;
  return url.toString();
}

export async function ensureTestDatabaseExists(
  databaseUrl: string,
  deps: ProvisionDeps = defaultDeps,
): Promise<ProvisionOutcome> {
  // Re-asserted here rather than assumed from the caller: this is the one place
  // in the suite that composes a CREATE DATABASE statement, so it re-establishes
  // the guarantee instead of inheriting it.
  assertIsTestDatabase(databaseUrl);

  if (await deps.canConnect(databaseUrl)) {
    return 'existing';
  }

  const name = databaseNameOf(databaseUrl);

  if (!isAutoProvisionable(databaseUrl)) {
    throw new Error(
      `The test database "${name}" does not exist, and this suite only creates databases on ` +
        'loopback. Create it on the target server (CREATE DATABASE "' +
        name +
        '";), or point TEST_DATABASE_URL at a database that already exists.',
    );
  }

  await deps.createDatabase(maintenanceUrlFor(databaseUrl), name);
  return 'created';
}

const defaultDeps: ProvisionDeps = {
  async canConnect(databaseUrl) {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    } finally {
      await prisma.$disconnect();
    }
  },

  async createDatabase(maintenanceUrl, name) {
    const prisma = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } });
    try {
      // The name has cleared assertIsTestDatabase, which admits only lowercase
      // letters, digits and underscores — so quoting it is enough, and there is
      // nothing here for a value to escape from.
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    } catch (error) {
      if (isDuplicateDatabaseError(error)) {
        return;
      }
      throw new Error(
        `Could not create the test database "${name}": ${describe(error)}. ` +
          'Create it by hand, or point TEST_DATABASE_URL at a database that already exists.',
      );
    } finally {
      await prisma.$disconnect();
    }
  },
};

function isDuplicateDatabaseError(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  return meta?.code === DUPLICATE_DATABASE || describe(error).includes(DUPLICATE_DATABASE);
}

/**
 * The first line of the message, with any connection string taken out.
 *
 * Prisma renders the datasource URL into some of its errors, and this text ends
 * up on a developer's terminal and in CI logs — neither of which should ever
 * carry a password.
 */
function describe(error: unknown): string {
  const raw = error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : String(error);
  return raw.replace(/postgres(ql)?:\/\/\S*/gi, '(connection string)');
}
