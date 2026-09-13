import { createHash, randomBytes } from 'node:crypto';
import { parseCookieHeader } from '../auth/cookie';
import { REQUEST_DRAFT_COOKIE_NAME } from './request-drafts.constants';

export function generateDraftToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDraftToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The draft token the web app forwarded, or null. Same parsing as the session cookie. */
export function getDraftTokenFromRequest(request: {
  headers?: Record<string, string | string[] | undefined>;
}): string | null {
  const header = request.headers?.cookie;
  const normalized = Array.isArray(header) ? header.join(';') : header;
  const value = parseCookieHeader(normalized).get(REQUEST_DRAFT_COOKIE_NAME);
  return value && value.length > 0 ? value : null;
}
