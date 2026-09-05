import { resolvePublicWebBaseUrl } from './public-urls';
import { getAdminAppBaseUrl } from '../modules/users/admin-invite.constants';

/**
 * Who may call this API from a browser, with the session cookie attached.
 *
 * This used to be `origin: true`, which is not an allow-list at all: the `cors`
 * package reflects whatever `Origin` the request carried back in
 * `Access-Control-Allow-Origin`, and paired with `credentials: true` that means
 * *any* site a signed-in person visits can read this API as them. Every
 * authenticated endpoint — their requests, their offers, their messages, their
 * contact details — was one `fetch(..., {credentials: 'include'})` away from a
 * page they merely opened. Reflection is the vulnerability; a fixed list is the
 * fix.
 *
 * The list is derived from configuration this deployment already has rather
 * than from a new mandatory variable: the two origins that are allowed are the
 * web application and the admin panel, and the API already has to know both of
 * them to mail a link to either. Nothing new has to be set for an existing
 * deployment to keep working.
 *
 * Requests with no `Origin` header at all — server-to-server calls, curl, the
 * Next.js processes talking to `API_INTERNAL_URL` — are untouched. CORS is a
 * browser rule about *cross-origin* reads; a caller that sends no origin is not
 * a browser doing one, and refusing it here would break every server-rendered
 * screen in the product while stopping nothing.
 */

/**
 * The parts of the Express request and response this layer touches.
 *
 * Declared structurally rather than imported from @types/express, which is the
 * approach the rest of this API already takes (see the payment webhook's
 * `RawBodyRequest` and the phone-verification controller's `IncomingRequest`):
 * nothing here depends on the HTTP adapter's type packages, and what a
 * middleware is allowed to reach for stays visible in one place.
 */
export type MiddlewareRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};

export type MiddlewareResponse = {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  /** Express's own helper; appends rather than replacing an existing Vary. */
  vary(field: string): unknown;
  end(): unknown;
};

export type MiddlewareNext = () => void;

/** The methods this API answers. Sent on a preflight, and only on a preflight. */
const ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';

/** What a preflight result may be cached for, in seconds. */
const PREFLIGHT_MAX_AGE = '600';

/**
 * The request headers allowed when a preflight did not ask for anything in
 * particular. Requesting headers is the normal case and they are echoed back;
 * this is the floor.
 */
const DEFAULT_ALLOWED_HEADERS = 'Content-Type';

/** Hostnames that mean "this machine", and are therefore not the internet. */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The origins that may make a credentialed cross-origin call.
 *
 * Read on every call rather than cached, like every other configuration switch
 * in this codebase, so a test sees the environment it actually has.
 *
 * Outside production, a configured origin that points at this machine brings
 * its loopback siblings with it: a stack configured as `http://localhost:3000`
 * is the same stack a developer reaches at `http://127.0.0.1:3000`, and the
 * end-to-end suite drives `127.0.0.1` while a browser opened by hand goes to
 * `localhost`. The expansion is deliberately narrow — same scheme, same port,
 * only the three spellings of the loopback host — and it does not happen under
 * NODE_ENV=production, where a loopback origin is a misconfiguration rather
 * than a convenience.
 */
export function resolveAllowedOrigins(): string[] {
  const configured = [resolvePublicWebBaseUrl().baseUrl, getAdminAppBaseUrl()];
  const allowed = new Set<string>();

  for (const value of configured) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      // A base URL that cannot be parsed cannot name an origin. It is already
      // reported where it matters (public-urls.ts describes it for the e-mail
      // transport); here it simply allows nobody.
      continue;
    }

    allowed.add(parsed.origin);

    if (expandsLoopback() && LOOPBACK_HOSTNAMES.includes(parsed.hostname)) {
      const port = parsed.port ? `:${parsed.port}` : '';
      for (const hostname of LOOPBACK_HOSTNAMES) {
        allowed.add(new URL(`${parsed.protocol}//${hostname}${port}`).origin);
      }
    }
  }

  return [...allowed];
}

/** Whether this origin may read this API as the signed-in person. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  return typeof origin === 'string' && origin.length > 0 && allowed.includes(origin);
}

/**
 * The CORS layer, written out rather than delegated to the `cors` package.
 *
 * The package cannot express the rule this API needs. With `credentials: true`
 * it emits `Access-Control-Allow-Credentials: true` on every response whatever
 * the origin was, and its way of saying "not allowed" (`origin: false`) emits
 * `Access-Control-Allow-Origin: *`. An unknown origin has to receive *neither*
 * header, and that is the whole of what this middleware does differently.
 *
 * `Vary: Origin` goes on every response, allowed or not: the answer depends on
 * the request's origin, so a shared cache that ignored it would hand one
 * origin's response to another.
 */
export function corsMiddleware(allowed: string[] = resolveAllowedOrigins()) {
  return (req: MiddlewareRequest, res: MiddlewareResponse, next: MiddlewareNext): void => {
    res.vary('Origin');

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const permitted = isOriginAllowed(origin, allowed);

    if (permitted) {
      res.setHeader('Access-Control-Allow-Origin', origin as string);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // A preflight is an OPTIONS carrying Access-Control-Request-Method. An
    // ordinary OPTIONS is a request like any other and is left to the router.
    const isPreflight =
      req.method === 'OPTIONS' && Boolean(req.headers['access-control-request-method']);

    if (!isPreflight) {
      next();
      return;
    }

    if (permitted) {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] ?? DEFAULT_ALLOWED_HEADERS,
      );
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
    }

    // Answered either way, and with nothing in it. A preflight from an origin
    // that is not on the list simply carries no permission, which is what makes
    // the browser refuse the call it was asking about.
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
  };
}

function expandsLoopback(): boolean {
  return process.env.NODE_ENV !== 'production';
}
