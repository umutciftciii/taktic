import { cookies } from 'next/headers';
import { apiUrl } from '../api-base';

/**
 * A call to one of the API's `/account/*` routes as the signed-in person.
 *
 * Plain module rather than part of actions.ts: everything exported from a
 * `'use server'` file becomes a Server Action anybody can invoke, and this is a
 * helper, not an endpoint.
 */
export async function accountFetch(path: string, init: RequestInit): Promise<Response> {
  const cookieHeader = (await cookies()).toString();

  return fetch(`${apiUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
}

export function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
