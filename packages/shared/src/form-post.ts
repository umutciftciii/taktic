import { safeRedirectPath } from './safe-redirect';

/**
 * Plain-HTML form posts to a fixed URL, for the forms that must survive a deploy.
 *
 * A Server Action is addressed by an id Next derives at build time, salted with
 * the build's own encryption key. A clean build — a fresh container, a CI
 * image — draws a new key, so every id changes even when not one line of source
 * did. A tab rendered by the previous build still holds the old ids; submitting
 * it gets `404 x-nextjs-action-not-found`, the client throws
 * `UnrecognizedActionError`, and the person lands on the generic error screen.
 * For the sign-in form that is a person locked out of the product by a deploy.
 *
 * The forms that sign people in, out and back in (password reset, activation)
 * therefore post as ordinary HTML forms to a route handler whose URL is part of
 * the source, not of the build. The browser does a normal navigation; the handler
 * does exactly what the Server Action did and answers `303 See Other`, so the
 * next request is a GET of the chosen screen and a reload never re-posts.
 */

type HeaderReader = { get(name: string): string | null };

/**
 * Whether a form post came from a page on this same origin.
 *
 * The CSRF check a Server Action got for free from Next (`action-handler`):
 * the `Origin` host has to equal the host the request arrived on — the first
 * `x-forwarded-host` when a proxy set one, `host` otherwise. A route handler
 * gets no such check, so without this a page on any other site could post a
 * victim's browser into this one (login CSRF, forced sign-out).
 *
 * One deliberate difference: Next lets a post with no `Origin` through with a
 * warning, for browsers too old to send it. Every browser this product supports
 * sends `Origin` on a form POST, so here a missing, opaque (`null`) or
 * unparsable one is refused.
 */
export function isSameOriginFormPost(headers: HeaderReader): boolean {
  const origin = headers.get('origin');
  if (!origin || origin === 'null') {
    return false;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const forwardedHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || headers.get('host');

  return Boolean(host) && originHost === host;
}

/**
 * The whole route handler for one form: origin check, form parse, submission,
 * then `303` to wherever the submission decided.
 *
 * `submit` is the former Server Action body, returning the path it used to hand
 * `redirect()`. Its answer still passes the shared open-redirect guard before it
 * becomes a `Location` header: every path it builds is internal today, and this
 * keeps that true for the next person who edits one. Anything the guard refuses
 * falls back to `fallbackPath`, the form's own screen.
 */
export function formPostRoute(
  submit: (formData: FormData) => Promise<string>,
  fallbackPath: string,
): (request: Request) => Promise<Response> {
  return async function POST(request: Request): Promise<Response> {
    if (!isSameOriginFormPost(request.headers)) {
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } });
    }

    const location = safeRedirectPath(await submit(formData), fallbackPath);

    return new Response(null, {
      status: 303,
      headers: { location, 'cache-control': 'no-store' },
    });
  };
}
