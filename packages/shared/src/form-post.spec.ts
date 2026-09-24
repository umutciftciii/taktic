import { describe, expect, it, vi } from 'vitest';
import { formPostRoute, isSameOriginFormPost } from './form-post';

function post(
  headers: Record<string, string>,
  body: string = 'email=a%40b.c&password=x',
): Request {
  return new Request('http://internal:3000/login/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

describe('isSameOriginFormPost', () => {
  it('accepts a post whose origin matches the host', () => {
    expect(isSameOriginFormPost(new Headers({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true);
  });

  it('judges against the first x-forwarded-host when a proxy set one, as Next does', () => {
    const headers = new Headers({
      origin: 'https://taktic.example',
      host: 'web:3000',
      'x-forwarded-host': 'taktic.example, edge.internal',
    });
    expect(isSameOriginFormPost(headers)).toBe(true);
    // The internal host alone is not what the browser was on.
    expect(
      isSameOriginFormPost(
        new Headers({ origin: 'http://web:3000', host: 'web:3000', 'x-forwarded-host': 'taktic.example' }),
      ),
    ).toBe(false);
  });

  it('refuses another origin', () => {
    expect(isSameOriginFormPost(new Headers({ origin: 'https://evil.example', host: 'localhost:3000' }))).toBe(false);
    // Same host name, different port, is a different origin.
    expect(isSameOriginFormPost(new Headers({ origin: 'http://localhost:4000', host: 'localhost:3000' }))).toBe(false);
  });

  it('refuses a post with no usable origin at all', () => {
    expect(isSameOriginFormPost(new Headers({ host: 'localhost:3000' }))).toBe(false);
    expect(isSameOriginFormPost(new Headers({ origin: 'null', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOriginFormPost(new Headers({ origin: 'not a url', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOriginFormPost(new Headers({ origin: 'http://localhost:3000' }))).toBe(false);
  });
});

describe('formPostRoute', () => {
  it('answers 303 See Other with the path the submission chose, so the browser GETs it', async () => {
    const submit = vi.fn(async (form: FormData) => `/login?error=1&email=${form.get('email') === 'a@b.c'}`);
    const response = await formPostRoute(submit, '/login')(
      post({ origin: 'http://localhost:3000', host: 'localhost:3000' }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?error=1&email=true');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('never runs the submission for a cross-origin post', async () => {
    const submit = vi.fn(async () => '/');
    const response = await formPostRoute(submit, '/login')(
      post({ origin: 'https://evil.example', host: 'localhost:3000' }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a form without running the submission', async () => {
    const submit = vi.fn(async () => '/');
    const request = new Request('http://localhost:3000/login/submit', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' },
      body: '{"email":"a@b.c"}',
    });
    const response = await formPostRoute(submit, '/login')(request);

    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it('never redirects off this origin, whatever the submission returned', async () => {
    for (const hostile of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const response = await formPostRoute(async () => hostile, '/login')(
        post({ origin: 'http://localhost:3000', host: 'localhost:3000' }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/login');
    }
  });
});
