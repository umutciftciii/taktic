import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, resetDatabase, type TestContext } from './harness';
import { AUTH_THROTTLE_LIMIT } from '../src/modules/auth/auth.throttler';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe('credential endpoint throttling', () => {
  it('answers 429 once the login attempt budget is spent', async () => {
    const user = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      password: 'Password123!',
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < AUTH_THROTTLE_LIMIT + 1; attempt += 1) {
      const response = await request(ctx.server)
        .post('/auth/login')
        .send({ email: user.email, password: 'WrongPassword!' });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, AUTH_THROTTLE_LIMIT).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // Correct credentials are blocked too — the limiter keys off the caller,
    // not the outcome, so an attacker cannot keep guessing.
    await request(ctx.server)
      .post('/auth/login')
      .send({ email: user.email, password: 'Password123!' })
      .expect(429);
  });

  it('does not throttle ordinary read endpoints', async () => {
    for (let attempt = 0; attempt < AUTH_THROTTLE_LIMIT + 3; attempt += 1) {
      await request(ctx.server).get('/health').expect(200);
    }
  });
});
