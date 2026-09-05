import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  corsMiddleware,
  type MiddlewareNext,
  type MiddlewareRequest,
  type MiddlewareResponse,
} from './cors';

/**
 * The response headers every answer this API gives carries, and the one it
 * stopped giving.
 *
 * None of these is a feature; each one closes a way of using a correct response
 * against the person who asked for it. They are set here, once, on the whole
 * application rather than per controller — a header that has to be remembered
 * at each endpoint is a header that will be missing from the next one.
 *
 * The web and admin applications set the same five in their own
 * `next.config.ts`. The values are deliberately identical: a person moving
 * between the three origins is inside one product, and a rule that holds on two
 * of them is a rule with a hole in it.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  /**
   * One year, and only ever honoured over https — a browser ignores this header
   * on a plain-http response, which is why it can be set unconditionally here
   * without breaking a local stack. No `includeSubDomains` and no `preload`:
   * both are commitments about hostnames this repository does not own, and
   * neither can be taken back quickly once a browser has cached it.
   */
  'Strict-Transport-Security': 'max-age=31536000',

  /**
   * Stops a browser from second-guessing a declared content type. This API
   * serves uploaded files from /uploads, and an image an admin uploaded that a
   * browser decides to read as HTML is a stored cross-site scripting hole on
   * this origin.
   */
  'X-Content-Type-Options': 'nosniff',

  /**
   * Clickjacking, said the modern way. `frame-ancestors` is the only directive
   * here on purpose: a broader policy on an API that serves JSON and uploads
   * buys nothing and is the sort of thing that breaks a screen months later.
   */
  'Content-Security-Policy': "frame-ancestors 'self'",

  /**
   * The same rule again for browsers that never implemented `frame-ancestors`.
   * Redundant where both are understood, and `frame-ancestors` wins there.
   */
  'X-Frame-Options': 'SAMEORIGIN',

  /**
   * A full URL to same-origin destinations, bare origin when leaving for
   * another https site, and nothing at all when leaving https for http. This
   * product puts single-use tokens in query strings — activation, password
   * reset, provider claim — and the default policy would hand those to whatever
   * third party a page happened to load.
   */
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

/** Sets {@link SECURITY_HEADERS} on every response, including static files. */
export function securityHeadersMiddleware() {
  return (_req: MiddlewareRequest, res: MiddlewareResponse, next: MiddlewareNext): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }

    next();
  };
}

/**
 * Applies the transport-level security decisions to an application.
 *
 * Called from `main.ts` and from the test harness, so the suite asserts on the
 * same wiring a deployment runs rather than on a second description of it.
 * Mounted before the static file handler, so an uploaded file is answered with
 * the same headers as an endpoint.
 */
export function applyHttpSecurity(app: NestExpressApplication): void {
  // Express announces itself in `X-Powered-By` on every response. It tells an
  // attacker which stack — and, combined with a fingerprint, roughly which
  // version — to look up known issues for, and it tells a legitimate caller
  // nothing at all.
  app.disable('x-powered-by');

  app.use(securityHeadersMiddleware());
  app.use(corsMiddleware());
}
