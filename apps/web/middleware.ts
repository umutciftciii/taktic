import { NextResponse, type NextRequest } from 'next/server';
import { apiUrl } from './app/api-base';
import { normalizeSeoPath } from './lib/seo-paths';
import {
  REDIRECT_SNAPSHOT_PATH,
  REDIRECT_SNAPSHOT_TIMEOUT_MS,
  configuredWebOrigin,
  createRedirectResolver,
  redirectLocation,
} from './lib/seo-redirects';

/**
 * SEO-004 — the redirects an operator manages, served as real HTTP 301/302.
 *
 * Next's `permanentRedirect()` answers 308 and `redirect()` 307; the product
 * contract is 301 (a slug change, a permanent manual redirect) and 302 (a
 * temporary one), which only a response built here can carry. Everything this
 * does is in lib/seo-redirects.ts: one in-memory snapshot of the API's
 * `GET /seo/redirects/active`, refreshed every minute, never older than ten.
 *
 * Node runtime (stable in Next 15.5) rather than edge: the environment is read
 * at request time on the server that runs it, and the snapshot is one cache
 * per server process.
 *
 * Only GET and HEAD of an application path are looked at — never `/api`,
 * `/_next` or a file (anything with a dot in it); a redirect
 * source can never be one of those either (the API refuses it). The query
 * string and fragment are dropped: a redirect leads to the target's canonical
 * address, which has none.
 */

const resolver = createRedirectResolver({
  fetchSnapshot: async () => {
    const response = await fetch(`${apiUrl}${REDIRECT_SNAPSHOT_PATH}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REDIRECT_SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`snapshot answered ${response.status}`);
    return response.json();
  },
});

export async function middleware(request: NextRequest) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.next();

  const normalized = normalizeSeoPath(request.nextUrl.pathname);
  if (!normalized.ok || normalized.path === '/') return NextResponse.next();

  const hit = await resolver.resolve(normalized.path);
  if (!hit) return NextResponse.next();

  // The configured public origin when the deployment names one. Without one
  // (a local stack) the request's own origin is the only absolute base there
  // is — Next refuses a relative Location — and an answer built from a Host
  // the caller sent is never cacheable.
  const configured = configuredWebOrigin();
  const location = redirectLocation(hit.target, configured ?? request.nextUrl.origin);
  if (!location) return NextResponse.next();

  return new NextResponse(null, {
    status: hit.status,
    headers: {
      Location: location,
      // A permanent answer may be cached for a while, a temporary one not at
      // all: an operator who removes a 302 expects it gone.
      'Cache-Control': hit.status === 301 && configured ? 'public, max-age=3600' : 'no-store',
    },
  });
}

export const config = {
  runtime: 'nodejs',
  // Not `/api`, not `/_next`, not any path with a dot in it (a file); the API
  // refuses a redirect source with a dot in any segment for the same reason.
  matcher: ['/((?!api/|_next/|.*\\..*).*)'],
};
