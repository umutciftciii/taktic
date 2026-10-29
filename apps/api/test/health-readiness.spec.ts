import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { READINESS_DB_TIMEOUT_MS, ReadinessService } from '../src/modules/health/readiness.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestContext } from './harness';

/**
 * OBS-READY-001: liveness and readiness are two different questions.
 *
 * `GET /health` is "the process answers" and must keep answering while the
 * database is gone — a container restarted on every database blip would turn
 * an outage into a restart loop. `GET /health/ready` is "a request that needs
 * the database can be served": 200 with the applied migration count, or 503,
 * within a short timeout, and never anything that describes the connection.
 */

const MIGRATIONS_DIR = resolve(__dirname, '../../../prisma/migrations');

/** What `prisma migrate deploy` applied to the test database: every migration directory. */
function migrationsInRepository(): number {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(MIGRATIONS_DIR, entry.name, 'migration.sql')),
  ).length;
}

/** Pieces of DATABASE_URL a readiness answer must never repeat. */
function connectionSecrets(): string[] {
  const url = new URL(process.env.DATABASE_URL!);
  return [url.hostname, url.port, decodeURIComponent(url.username), decodeURIComponent(url.password), url.pathname.slice(1)].filter(
    (part) => part.length >= 3,
  );
}

/** The driver's own wording for "the server is down": it names the host. */
function unreachableError() {
  return new Prisma.PrismaClientInitializationError(
    "Can't reach database server at `db-secret-host.internal:5432`",
    '6.0.0',
    'P1001',
  );
}

describe('health endpoints', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('GET /health (liveness)', () => {
    it('answers exactly as before and does not ask the database', async () => {
      const probe = vi.spyOn(ctx.app.get(ReadinessService), 'check');
      const query = vi.spyOn(ctx.prisma, '$queryRaw');

      const response = await request(ctx.server).get('/health').expect(200);

      expect(response.body).toEqual({ status: 'ok', service: 'taktic-api' });
      expect(probe).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it('stays 200 while the database is unreachable', async () => {
      vi.spyOn(ctx.prisma, '$queryRaw').mockRejectedValue(unreachableError());

      await request(ctx.server).get('/health/ready').expect(503);
      const response = await request(ctx.server).get('/health').expect(200);

      expect(response.body).toEqual({ status: 'ok', service: 'taktic-api' });
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('is 200 with the database state and the applied migration count', async () => {
      const response = await request(ctx.server).get('/health/ready').expect(200);

      expect(response.body).toEqual({
        status: 'ready',
        service: 'taktic-api',
        database: 'ok',
        migrations: { applied: migrationsInRepository() },
      });
    });

    it('counts only finished migrations that were not rolled back', async () => {
      const before = (await request(ctx.server).get('/health/ready').expect(200)).body.migrations.applied;
      const ids = ['obs-ready-001-unfinished', 'obs-ready-001-rolled-back'];
      try {
        // The two states `prisma migrate status` does not call applied: a
        // migration that failed half-way (finished_at NULL) and one resolved
        // as rolled back.
        await ctx.prisma.$executeRaw`
          INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
          VALUES
            (${ids[0]}, 'x', '29991231000000_obs_ready_unfinished', now(), NULL, NULL, 0),
            (${ids[1]}, 'x', '29991231000001_obs_ready_rolled_back', now(), now(), now(), 0)
        `;

        const response = await request(ctx.server).get('/health/ready').expect(200);
        expect(response.body.migrations.applied).toBe(before);
      } finally {
        await ctx.prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id IN (${ids[0]}, ${ids[1]})`;
      }
    });

    it('carries nothing that describes the connection', async () => {
      const response = await request(ctx.server).get('/health/ready').expect(200);
      const text = JSON.stringify(response.body);

      for (const secret of connectionSecrets()) {
        expect(text).not.toContain(secret);
      }
    });

    it('is 503 while the database is unreachable, without the driver message', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(ctx.prisma, '$queryRaw').mockRejectedValue(unreachableError());

      const response = await request(ctx.server).get('/health/ready').expect(503);

      expect(response.body).toEqual({ status: 'unavailable', service: 'taktic-api', database: 'unreachable' });
      expect(JSON.stringify(response.body)).not.toContain('db-secret-host');
      // The log keeps the error class and code, not the host the message names.
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('PrismaClientInitializationError P1001');
      expect(logged).not.toContain('db-secret-host');
    });

    it('gives up after the timeout when the database does not answer', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // A query that hangs past the probe and only then fails: the late
      // rejection must not surface as an unhandled one (Vitest fails the run
      // if it does) — that is what would take a real process down.
      vi.spyOn(ctx.prisma, '$queryRaw').mockImplementation(
        () =>
          new Promise((_, reject) => setTimeout(() => reject(unreachableError()), READINESS_DB_TIMEOUT_MS + 200)) as never,
      );

      const started = Date.now();
      const response = await request(ctx.server).get('/health/ready').expect(503);
      const elapsed = Date.now() - started;

      expect(response.body).toEqual({ status: 'unavailable', service: 'taktic-api', database: 'timeout' });
      expect(elapsed).toBeGreaterThanOrEqual(READINESS_DB_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(READINESS_DB_TIMEOUT_MS + 1_500);

      await new Promise((settle) => setTimeout(settle, 400));
    });

    it('is 200 again once the database answers, in the same process', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(ctx.prisma, '$queryRaw').mockRejectedValueOnce(unreachableError());

      await request(ctx.server).get('/health/ready').expect(503);
      const response = await request(ctx.server).get('/health/ready').expect(200);

      expect(response.body.database).toBe('ok');
    });
  });
});

describe('ReadinessService against a database that is really not there', () => {
  let client: PrismaClient;

  beforeAll(() => {
    // Port 1 on loopback: nothing listens, the connection is refused at once.
    const url = new URL(process.env.DATABASE_URL!);
    url.hostname = '127.0.0.1';
    url.port = '1';
    url.searchParams.set('connect_timeout', '1');
    client = new PrismaClient({ datasourceUrl: url.toString() });
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  it('reports not-ready instead of throwing', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new ReadinessService(client as unknown as PrismaService);

    const report = await service.check();

    expect(report.ready).toBe(false);
    expect(['unreachable', 'timeout']).toContain(report.database);
    vi.restoreAllMocks();
  });
});
