import request from 'supertest';
import { ServiceRequestStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  daysAgo,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  uniqueSuffix,
  type TestContext,
} from './harness';
import {
  SERVICE_REQUEST_MAX_OPEN_PER_PHONE,
  SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY,
  SERVICE_REQUEST_THROTTLE_LIMIT,
} from '../src/modules/service-requests/service-requests.constants';

/**
 * The three budgets `POST /service-requests` now enforces: an IP-scoped
 * throttle ahead of everything else, and — inside the creation transaction —
 * a rolling 24h count and an open-request ceiling, both keyed on
 * `customerPhone` rather than the caller's identity, so a signed-out visitor
 * cycling contact e-mails cannot dodge either one.
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
  resetAuthThrottle(ctx.app);
});

describe('POST /service-requests rate limits', () => {
  it('answers 429 once the IP budget is spent, even across different phones', async () => {
    const category = await createCategory(ctx.prisma);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < SERVICE_REQUEST_THROTTLE_LIMIT + 1; attempt += 1) {
      const response = await request(ctx.server)
        .post('/service-requests')
        .send(
          serviceRequestPayload(category.slug, {
            customerPhone: `05551110${String(attempt).padStart(3, '0')}`,
          }),
        );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, SERVICE_REQUEST_THROTTLE_LIMIT).every((status) => status === 201)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it('answers 429 REQUEST_RATE_LIMITED on the 6th request in 24h from the same phone', async () => {
    const category = await createCategory(ctx.prisma);
    const phone = '05552220001';

    const statuses: Array<{ status: number; body: Record<string, unknown> }> = [];
    for (let attempt = 0; attempt < SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY + 1; attempt += 1) {
      // Reset the IP throttle before every call: the phone limit is what this
      // case is about, and the shared IP budget (5 per 10 minutes) would
      // otherwise trip first and mask it.
      resetAuthThrottle(ctx.app);
      const response = await request(ctx.server)
        .post('/service-requests')
        .send(
          serviceRequestPayload(category.slug, {
            customerPhone: phone,
            customerEmail: `phone-limit-${attempt}@example.test`,
            customerName: `Müşteri ${attempt}`,
          }),
        );
      statuses.push({ status: response.status, body: response.body });
    }

    expect(
      statuses.slice(0, SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY).every(({ status }) => status === 201),
    ).toBe(true);
    const last = statuses.at(-1)!;
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('REQUEST_RATE_LIMITED');

    // Nothing was written for the refused attempt.
    expect(await ctx.prisma.serviceRequest.count({ where: { customerPhone: phone } })).toBe(
      SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY,
    );
  });

  it('answers 429 REQUEST_RATE_LIMITED once a phone has 10 open APPROVED requests, isolated from the 24h count', async () => {
    const category = await createCategory(ctx.prisma);
    const phone = '05553330001';
    // Older than the 24h window the other rule counts, so only the open-count
    // rule can fire here: if the open-count check were deleted, every one of
    // these calls would still succeed, because none of these rows (nor the
    // control POST below) fall inside `phoneWindowStart`.
    const old = daysAgo(2);

    for (let index = 0; index < SERVICE_REQUEST_MAX_OPEN_PER_PHONE - 1; index += 1) {
      await createApprovedRequest(ctx.prisma, {
        categoryId: category.id,
        customerPhone: phone,
        submittedAt: old,
      });
    }
    expect(
      await ctx.prisma.serviceRequest.count({
        where: { customerPhone: phone, status: ServiceRequestStatus.APPROVED },
      }),
    ).toBe(SERVICE_REQUEST_MAX_OPEN_PER_PHONE - 1);

    // Negative control: 9 open requests is still under the ceiling of 10, so
    // this must succeed. Without it, a broken (always-refuse) open-count
    // check would pass the assertions below for the wrong reason.
    resetAuthThrottle(ctx.app);
    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          customerPhone: phone,
          customerEmail: `control-${uniqueSuffix()}@example.test`,
        }),
      )
      .expect(201);

    // The 10th open request — auto-publish is off in this suite, so the
    // control POST above landed as SUBMITTED and did not itself count toward
    // the APPROVED ceiling.
    await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerPhone: phone,
      submittedAt: old,
    });
    expect(
      await ctx.prisma.serviceRequest.count({
        where: { customerPhone: phone, status: ServiceRequestStatus.APPROVED },
      }),
    ).toBe(SERVICE_REQUEST_MAX_OPEN_PER_PHONE);

    resetAuthThrottle(ctx.app);
    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          customerPhone: phone,
          customerEmail: 'eleventh@example.test',
        }),
      );

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('REQUEST_RATE_LIMITED');
    expect(
      await ctx.prisma.serviceRequest.count({
        where: { customerPhone: phone, status: ServiceRequestStatus.APPROVED },
      }),
    ).toBe(SERVICE_REQUEST_MAX_OPEN_PER_PHONE);
  });

  it('does not count requests older than 24h toward the rolling per-phone budget', async () => {
    const category = await createCategory(ctx.prisma);
    const phone = '05554440001';
    const old = daysAgo(2);

    // Five SUBMITTED rows, all outside the 24h window. SUBMITTED (not
    // APPROVED) so this exercises only the 24h rule, never the open-request
    // ceiling above. If the 24h check ignored `submittedAt` and simply
    // counted every row for the phone, this POST would 429 instead.
    for (let index = 0; index < SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY; index += 1) {
      const suffix = uniqueSuffix();
      await ctx.prisma.serviceRequest.create({
        data: {
          categoryId: category.id,
          requestNumber: `TR-TEST-${suffix}`,
          customerName: `Müşteri ${suffix}`,
          customerPhone: phone,
          customerEmail: `old-${suffix}@example.test`,
          city: 'İstanbul',
          district: 'Kadıköy',
          status: ServiceRequestStatus.SUBMITTED,
          submittedAt: old,
          qualityScore: 80,
        },
      });
    }
    expect(await ctx.prisma.serviceRequest.count({ where: { customerPhone: phone } })).toBe(
      SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY,
    );

    resetAuthThrottle(ctx.app);
    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          customerPhone: phone,
          customerEmail: `fresh-${uniqueSuffix()}@example.test`,
        }),
      )
      .expect(201);
  });
});
