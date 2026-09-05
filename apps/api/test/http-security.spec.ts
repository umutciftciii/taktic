import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SECURITY_HEADERS } from '../src/common/http-security';
import { isOriginAllowed, resolveAllowedOrigins } from '../src/common/cors';
import { createTestApp, type TestContext } from './harness';

/**
 * What this API tells a browser it may do, and what it tells every browser
 * about itself.
 *
 * Two halves, and they fail in opposite directions. The allow-list is the
 * security half: it replaced `origin: true`, which reflected whatever `Origin`
 * a request carried and paired that with `Access-Control-Allow-Credentials:
 * true` — so any site a signed-in person merely visited could read this API as
 * them. The header half is the one that quietly stops holding if somebody adds
 * a route and forgets, which is why it is asserted on a response the router
 * actually produced rather than on the constant.
 *
 * Every hostile origin below is `evil.example`, reserved by RFC 2606 and
 * resolving nowhere.
 */

const ORIGIN_VARIABLES = [
  'NODE_ENV',
  'WEB_APP_URL',
  'WEB_ORIGIN',
  'NEXT_PUBLIC_WEB_URL',
  'ADMIN_APP_URL',
  'ADMIN_ORIGIN',
  'NEXT_PUBLIC_ADMIN_URL',
] as const;

describe('the CORS allow-list', () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = Object.fromEntries(ORIGIN_VARIABLES.map((key) => [key, process.env[key]]));
    for (const key of ORIGIN_VARIABLES) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('is the configured web and admin origins', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_APP_URL = 'https://taktick.example';
    process.env.ADMIN_APP_URL = 'https://yonetim.taktick.example';

    expect(resolveAllowedOrigins().sort()).toEqual([
      'https://taktick.example',
      'https://yonetim.taktick.example',
    ]);
  });

  it('reads the older variable names an existing deployment already set', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://taktick.example';
    process.env.ADMIN_ORIGIN = 'https://yonetim.taktick.example';

    expect(resolveAllowedOrigins()).toContain('https://taktick.example');
    expect(resolveAllowedOrigins()).toContain('https://yonetim.taktick.example');
  });

  it('keeps only the origin of a value that carries a path', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_APP_URL = 'https://taktick.example/app';
    process.env.ADMIN_APP_URL = 'https://yonetim.taktick.example';

    expect(resolveAllowedOrigins()).toContain('https://taktick.example');
    expect(resolveAllowedOrigins()).not.toContain('https://taktick.example/app');
  });

  it('never contains an origin nobody configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_APP_URL = 'https://taktick.example';
    process.env.ADMIN_APP_URL = 'https://yonetim.taktick.example';

    expect(isOriginAllowed('https://evil.example', resolveAllowedOrigins())).toBe(false);
    // The prefix trick: an attacker registering a domain that starts with a
    // configured one. Membership is exact, so this is nobody.
    expect(isOriginAllowed('https://taktick.example.evil.example', resolveAllowedOrigins())).toBe(
      false,
    );
    expect(isOriginAllowed(undefined, resolveAllowedOrigins())).toBe(false);
    expect(isOriginAllowed('', resolveAllowedOrigins())).toBe(false);
  });

  describe('outside production', () => {
    it('lets a loopback origin be reached by all three of its spellings', () => {
      process.env.NODE_ENV = 'development';
      process.env.WEB_ORIGIN = 'http://localhost:3000';
      process.env.ADMIN_ORIGIN = 'http://127.0.0.1:3002';

      const allowed = resolveAllowedOrigins();

      // The developer who typed the other name into the address bar, and the
      // end-to-end suite, which drives 127.0.0.1 throughout.
      expect(allowed).toContain('http://localhost:3000');
      expect(allowed).toContain('http://127.0.0.1:3000');
      expect(allowed).toContain('http://[::1]:3000');
      expect(allowed).toContain('http://127.0.0.1:3002');
      expect(allowed).toContain('http://localhost:3002');
    });

    it('expands the port and scheme it was given, and no other', () => {
      process.env.NODE_ENV = 'development';
      process.env.WEB_ORIGIN = 'http://localhost:3000';
      process.env.ADMIN_ORIGIN = 'http://localhost:3002';

      const allowed = resolveAllowedOrigins();

      expect(allowed).not.toContain('http://localhost:4000');
      expect(allowed).not.toContain('https://localhost:3000');
      expect(allowed).not.toContain('http://evil.example');
    });

    it('does not expand an origin that is not loopback', () => {
      process.env.NODE_ENV = 'development';
      process.env.WEB_APP_URL = 'https://taktick.example';
      process.env.ADMIN_APP_URL = 'https://yonetim.taktick.example';

      expect(resolveAllowedOrigins().sort()).toEqual([
        'https://taktick.example',
        'https://yonetim.taktick.example',
      ]);
    });
  });

  it('does not expand loopback under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.ADMIN_ORIGIN = 'http://localhost:3002';

    const allowed = resolveAllowedOrigins();

    expect(allowed).toContain('http://localhost:3000');
    expect(allowed).not.toContain('http://127.0.0.1:3000');
  });
});

describe('what a browser is told, over HTTP', () => {
  let context: TestContext;

  /**
   * The origins this application is booted with.
   *
   * Pinned rather than inherited: the allow-list is resolved once, when the
   * application is wired, so a stray WEB_ORIGIN in the developer's shell would
   * otherwise decide what these cases are asserting on.
   */
  const webOrigin = 'http://localhost:3000';
  const adminOrigin = 'http://localhost:3002';

  let original: Record<string, string | undefined>;

  beforeAll(async () => {
    original = Object.fromEntries(ORIGIN_VARIABLES.map((key) => [key, process.env[key]]));
    for (const key of ORIGIN_VARIABLES) {
      delete process.env[key];
    }
    process.env.NODE_ENV = 'test';
    process.env.WEB_ORIGIN = webOrigin;
    process.env.ADMIN_ORIGIN = adminOrigin;

    context = await createTestApp();
  });

  afterAll(async () => {
    await context.app.close();

    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('the security headers', () => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      it(`sets ${name}`, async () => {
        const response = await request(context.server).get('/health').expect(200);
        expect(response.headers[name.toLowerCase()]).toBe(value);
      });
    }

    it('sets them on a refusal too, not only on a success', async () => {
      const response = await request(context.server).get('/providers/me/dashboard').expect(401);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    });

    it('no longer announces the stack in X-Powered-By', async () => {
      const response = await request(context.server).get('/health').expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('a request from an allowed origin', () => {
    for (const [name, origin] of [
      ['the web application', webOrigin],
      ['the admin panel', adminOrigin],
    ] as const) {
      it(`answers ${name} with its own origin and permission to send the cookie`, async () => {
        const response = await request(context.server)
          .get('/health')
          .set('Origin', origin)
          .expect(200);

        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-allow-credentials']).toBe('true');
      });

      it(`answers ${name}'s preflight`, async () => {
        const response = await request(context.server)
          .options('/auth/login')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type')
          .expect(204);

        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-allow-credentials']).toBe('true');
        expect(response.headers['access-control-allow-methods']).toContain('POST');
        expect(response.headers['access-control-allow-headers']).toBe('content-type');
      });
    }

    it('says the answer depends on the origin, so no cache hands it to another', async () => {
      const response = await request(context.server)
        .get('/health')
        .set('Origin', webOrigin)
        .expect(200);

      expect(response.headers.vary).toContain('Origin');
    });
  });

  describe('a request from any other origin', () => {
    const strangers = [
      'https://evil.example',
      'http://evil.example',
      'http://localhost:4000',
      'https://localhost:3000',
      'null',
    ];

    for (const origin of strangers) {
      it(`gives ${origin} no CORS headers at all`, async () => {
        const response = await request(context.server)
          .get('/health')
          .set('Origin', origin)
          .expect(200);

        // Not reflected, and not `*` either: with no
        // Access-Control-Allow-Origin the browser refuses to hand the response
        // to the calling page.
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      });

      it(`refuses ${origin}'s preflight without saying anything is allowed`, async () => {
        const response = await request(context.server)
          .options('/auth/login')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .expect(204);

        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
        expect(response.headers['access-control-allow-methods']).toBeUndefined();
      });
    }
  });

  it('leaves a caller that sends no Origin alone', async () => {
    // curl, a health check, and every server-rendered screen in the product:
    // the Next processes call this API from the server, where there is no
    // origin to send. CORS is a browser rule about cross-origin reads, and
    // refusing these would break the product while stopping nothing.
    const response = await request(context.server).get('/health').expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
