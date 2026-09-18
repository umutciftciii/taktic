import { describe, expect, it } from 'vitest';
import { resolveSeoSite } from '../lib/seo-site';

/**
 * The one decision every SEO surface hangs off: may this deployment be
 * indexed, and at which origin. Closed unless the deployment says
 * `production` *and* names a public https origin — the same origin contract
 * the API mails links from (`apps/api/src/common/public-urls.ts`).
 */
const env = (overrides: Record<string, string | undefined>) =>
  ({ APP_ENVIRONMENT: 'production', WEB_APP_URL: 'https://taktick.example', ...overrides }) as unknown as NodeJS.ProcessEnv;

describe('resolveSeoSite — environment gate', () => {
  it('is open on a declared production with a public https origin', () => {
    expect(resolveSeoSite(env({}))).toEqual({ indexable: true, origin: 'https://taktick.example' });
  });

  it.each(['local', 'staging'])('is closed on %s', (environment) => {
    expect(resolveSeoSite(env({ APP_ENVIRONMENT: environment }))).toEqual({
      indexable: false,
      origin: null,
      reason: 'ENVIRONMENT_NOT_PRODUCTION',
    });
  });

  it.each(['', '   ', undefined])('is closed when the environment is undeclared (%j)', (value) => {
    expect(resolveSeoSite(env({ APP_ENVIRONMENT: value }))).toMatchObject({
      indexable: false,
      reason: 'ENVIRONMENT_UNDECLARED',
    });
  });

  it('is closed, and does not throw, on a value that is not one of the three', () => {
    expect(resolveSeoSite(env({ APP_ENVIRONMENT: 'prod' }))).toMatchObject({
      indexable: false,
      reason: 'ENVIRONMENT_INVALID',
    });
  });

  it('never reads NODE_ENV as a production signal', () => {
    expect(
      resolveSeoSite({ NODE_ENV: 'production', WEB_APP_URL: 'https://taktick.example' } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({ indexable: false, reason: 'ENVIRONMENT_UNDECLARED' });
  });
});

describe('resolveSeoSite — origin', () => {
  it('trims whitespace and keeps only the origin', () => {
    expect(resolveSeoSite(env({ WEB_APP_URL: '  https://taktick.example  ' }))).toEqual({
      indexable: true,
      origin: 'https://taktick.example',
    });
  });

  it('falls back to WEB_ORIGIN, then NEXT_PUBLIC_WEB_URL, in the API’s order', () => {
    expect(resolveSeoSite(env({ WEB_APP_URL: undefined, WEB_ORIGIN: 'https://a.example' }))).toEqual({
      indexable: true,
      origin: 'https://a.example',
    });
    expect(
      resolveSeoSite(env({ WEB_APP_URL: undefined, WEB_ORIGIN: undefined, NEXT_PUBLIC_WEB_URL: 'https://b.example' })),
    ).toEqual({ indexable: true, origin: 'https://b.example' });
    expect(resolveSeoSite(env({ WEB_APP_URL: 'https://first.example', WEB_ORIGIN: 'https://second.example' }))).toEqual({
      indexable: true,
      origin: 'https://first.example',
    });
  });

  it.each([
    [undefined, 'ORIGIN_MISSING'],
    ['', 'ORIGIN_MISSING'],
    ['not a url', 'ORIGIN_MALFORMED'],
    ['https://taktick.example/app', 'ORIGIN_NOT_AN_ORIGIN'],
    ['https://taktick.example/?x=1', 'ORIGIN_NOT_AN_ORIGIN'],
    ['http://taktick.example', 'ORIGIN_INSECURE'],
    ['https://localhost', 'ORIGIN_LOOPBACK'],
    ['https://127.0.0.1:3000', 'ORIGIN_LOOPBACK'],
    ['https://[::1]', 'ORIGIN_LOOPBACK'],
    ['http://localhost:3000', 'ORIGIN_LOOPBACK'],
  ])('is closed on origin %j (%s) even in production', (value, reason) => {
    expect(resolveSeoSite(env({ WEB_APP_URL: value }))).toEqual({ indexable: false, origin: null, reason });
  });

  it('accepts a trailing slash as the bare origin', () => {
    expect(resolveSeoSite(env({ WEB_APP_URL: 'https://taktick.example/' }))).toEqual({
      indexable: true,
      origin: 'https://taktick.example',
    });
  });

  it('reads the process environment when handed nothing', () => {
    const before = { APP_ENVIRONMENT: process.env.APP_ENVIRONMENT, WEB_APP_URL: process.env.WEB_APP_URL };
    process.env.APP_ENVIRONMENT = 'staging';
    process.env.WEB_APP_URL = 'https://taktick.example';
    try {
      expect(resolveSeoSite()).toMatchObject({ indexable: false, reason: 'ENVIRONMENT_NOT_PRODUCTION' });
    } finally {
      process.env.APP_ENVIRONMENT = before.APP_ENVIRONMENT;
      process.env.WEB_APP_URL = before.WEB_APP_URL;
    }
  });
});
