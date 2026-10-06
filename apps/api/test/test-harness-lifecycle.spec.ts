import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackageRefundNotificationOutbox } from '../src/modules/notifications/package-refund-notification-outbox.service';
import { RequestCancellationOutbox } from '../src/modules/notifications/request-cancellation-outbox.service';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import { ReviewInvitationOutbox } from '../src/modules/notifications/review-invitation-outbox.service';
import { RequestDraftsService } from '../src/modules/request-drafts/request-drafts.service';
import {
  backgroundWorkOwners,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The harness's own lifecycle contract (TEST-FLAKE-003).
 *
 * A request handler may hand work to the background — an outbox sweep after a
 * commit, a draft sweep after a save — and return before that work is done.
 * The next case's `resetDatabase` used to TRUNCATE while such a sweep was still
 * reading, and a multi-table SELECT that locks its tables in the opposite order
 * to the TRUNCATE closed a lock cycle with it (40P01, seen in CI on
 * status-transition-guards: the publish outbox's audience query). The reset
 * now drains every background-work owner the application has before it
 * touches a table, so the two never overlap.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Resolves on the first event-loop turn at which `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Records when the reset's TRUNCATE is issued.
 *
 * `onTruncate` lets a case that holds background work open release it the
 * moment a TRUNCATE arrives, so a harness that does not wait fails the order
 * assertion instead of hanging.
 */
function watchTruncate(events: string[], onTruncate: () => void) {
  const original = ctx.prisma.$executeRawUnsafe.bind(ctx.prisma);
  return vi.spyOn(ctx.prisma, '$executeRawUnsafe').mockImplementation(((query: string, ...values: unknown[]) => {
    if (query.startsWith('TRUNCATE')) {
      events.push('truncate');
      onTruncate();
    }
    return original(query, ...values);
  }) as typeof ctx.prisma.$executeRawUnsafe);
}

describe('resetDatabase waits for background work the previous case started', () => {
  it('lets an outbox sweep that is mid-send finish before it truncates', async () => {
    const category = await createCategory(ctx.prisma);
    await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const approvedAt = new Date();
    const published = await createApprovedRequest(ctx.prisma, { categoryId: category.id, approvedAt });
    const outbox = ctx.app.get(RequestPublishOutbox);
    await ctx.prisma.$transaction((tx) => outbox.enqueue(tx, published.id, approvedAt));

    const events: string[] = [];
    const gate = deferred();
    const send = vi.spyOn(ctx.notifications, 'send').mockImplementation(async () => {
      events.push('send-start');
      await gate.promise;
      events.push('send-end');
      return { providerMessageId: 'gated' };
    });
    const truncate = watchTruncate(events, gate.release);

    try {
      // What a request handler does after its commit: fire and return.
      outbox.deliverSoon();
      await until(() => events.includes('send-start'));

      const reset = resetDatabase(ctx.prisma);
      // A watchdog only — never what makes the order hold. With the drain in
      // place the TRUNCATE cannot start while the sweep is parked here, so
      // something has to let the sweep go; without it the TRUNCATE releases
      // the gate first and the order below fails.
      const watchdog = setTimeout(gate.release, 100);
      await reset;
      clearTimeout(watchdog);

      // The customer's notice and the provider's: every send that started
      // also finished, and only then did the TRUNCATE go out.
      expect(events.filter((event) => event === 'send-start')).toHaveLength(2);
      expect(events).toEqual(['send-start', 'send-end', 'send-start', 'send-end', 'truncate']);
    } finally {
      truncate.mockRestore();
      send.mockRestore();
    }
  });

  it('lets a draft sweep scheduled after a save finish before it truncates', async () => {
    const drafts = ctx.app.get(RequestDraftsService);
    const events: string[] = [];
    const gate = deferred();
    const sweep = vi.spyOn(drafts, 'sweepExpired').mockImplementation(async () => {
      events.push('sweep-start');
      await gate.promise;
      events.push('sweep-end');
      return 0;
    });
    const truncate = watchTruncate(events, gate.release);

    try {
      (drafts as unknown as { sweepSoon: () => void }).sweepSoon();

      const reset = resetDatabase(ctx.prisma);
      const watchdog = setTimeout(gate.release, 100);
      await reset;
      clearTimeout(watchdog);

      expect(events.slice(0, 3)).toEqual(['sweep-start', 'sweep-end', 'truncate']);
    } finally {
      truncate.mockRestore();
      sweep.mockRestore();
    }
  });
});

describe('every piece of background work is one the harness can drain', () => {
  it('finds the outboxes and the draft sweep among the application’s owners', () => {
    const owners = backgroundWorkOwners(ctx.app);

    for (const type of [
      RequestPublishOutbox,
      RequestCancellationOutbox,
      ReviewInvitationOutbox,
      PackageRefundNotificationOutbox,
      RequestDraftsService,
    ]) {
      expect(owners.some((owner) => owner instanceof type), type.name).toBe(true);
    }
  });

  /*
   * The structural half: a future service that grows a fire-and-forget
   * `deliverSoon` without a way to wait for it would put the TRUNCATE race
   * straight back. Fail here, by name, instead of as a rare deadlock in CI.
   */
  it('has no fire-and-forget sender the harness cannot wait for', () => {
    const owners = new Set<unknown>(backgroundWorkOwners(ctx.app));
    const undrainable = providerInstances()
      .filter((instance) => typeof (instance as { deliverSoon?: unknown }).deliverSoon === 'function')
      .filter((instance) => !owners.has(instance))
      .map((instance) => (instance as object).constructor.name);

    expect(undrainable).toEqual([]);
  });
});

describe('resetAuthThrottle leaves no timer behind', () => {
  /*
   * Clearing the throttler's counters used to leave its expiry timers armed.
   * When one fired it looked up a counter that was no longer there and threw
   * an uncaught TypeError into whatever case happened to be running.
   */
  it('cancels the expiry timers of the counters it clears', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: 'kayitli@example.test' });
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: 'kayitli@example.test', password: 'yanlis-sifre' });

    const storage = ctx.app.get<ThrottlerStorageService>(ThrottlerStorage, { strict: false });
    const timers = () =>
      [...(storage as unknown as { timeoutIds: Map<string, unknown[]> }).timeoutIds.values()].flat();
    expect(timers().length).toBeGreaterThan(0);

    resetAuthThrottle(ctx.app);

    expect(timers()).toEqual([]);
    expect(storage.storage.size).toBe(0);
  });
});

function providerInstances(): unknown[] {
  const { ModulesContainer } = require('@nestjs/core') as typeof import('@nestjs/core');
  const instances: unknown[] = [];
  for (const module of ctx.app.get(ModulesContainer).values()) {
    for (const wrapper of module.providers.values()) {
      if (wrapper.instance) {
        instances.push(wrapper.instance);
      }
    }
  }
  return instances;
}
