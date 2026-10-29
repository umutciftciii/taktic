import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * How long the database gets to answer before readiness gives up. Well under
 * the container healthcheck's own 5 s timeout (Dockerfile), so a slow or
 * unreachable database is reported as "not ready" by this process instead of
 * the probe being killed and recorded as a crash.
 */
export const READINESS_DB_TIMEOUT_MS = 2_000;

export type DatabaseReadiness = 'ok' | 'unreachable' | 'timeout';

export type ReadinessReport =
  | { ready: true; database: 'ok'; appliedMigrations: number }
  | { ready: false; database: Exclude<DatabaseReadiness, 'ok'> };

class ReadinessTimeoutError extends Error {}

/**
 * OBS-READY-001: whether this process can serve a request that needs the
 * database, right now.
 *
 * Liveness (`GET /health`) stays what it was — "the process answers" — and
 * never touches the database: an orchestrator that restarted the API whenever
 * PostgreSQL blinked would turn a database outage into a restart loop.
 * Readiness is the other question, and it is only ever answered, never acted
 * on, by this process: a failed probe is a 503, not an exit. Prisma reconnects
 * on the next query once the database is back.
 *
 * The report carries the database state and the applied migration count, and
 * nothing that describes the connection: no host, port, user, database name
 * or driver message. Those stay in the server log — and even there only the
 * error class and code, since a Prisma connection message names the host.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  /** The last state reported, so the log records changes rather than every probe. */
  private lastState: DatabaseReadiness | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async check(timeoutMs = READINESS_DB_TIMEOUT_MS): Promise<ReadinessReport> {
    let report: ReadinessReport;
    try {
      const appliedMigrations = await withTimeout(this.countAppliedMigrations(), timeoutMs);
      report = { ready: true, database: 'ok', appliedMigrations };
    } catch (error) {
      const database = error instanceof ReadinessTimeoutError ? 'timeout' : 'unreachable';
      report = { ready: false, database };
      if (this.lastState !== database) {
        this.logger.warn(`readiness: database ${database} (${describeError(error)})`);
      }
    }

    if (report.ready && this.lastState !== null && this.lastState !== 'ok') {
      this.logger.log('readiness: database reachable again');
    }
    this.lastState = report.database;
    return report;
  }

  /**
   * Migrations Prisma has finished and not rolled back — the same rows
   * `prisma migrate status` counts as applied. A row left by a failed
   * migration (finished_at NULL) or one resolved as rolled back is not.
   */
  private async countAppliedMigrations(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ applied: number }>>`
      SELECT count(*)::int AS applied
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    return rows[0]?.applied ?? 0;
  }
}

/**
 * Settles with the query or with a timeout, whichever comes first. The query
 * is not cancelled — Prisma has no cancellation — so its eventual rejection is
 * swallowed here: an unhandled rejection after the probe already answered
 * would take the process down, which is the one thing readiness must not do.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadinessTimeoutError()), timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function describeError(error: unknown): string {
  if (error instanceof ReadinessTimeoutError) {
    return 'no answer in time';
  }
  if (error instanceof Error) {
    const code = (error as { errorCode?: unknown; code?: unknown }).errorCode ?? (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name} ${code}` : error.name;
  }
  return 'unknown error';
}
