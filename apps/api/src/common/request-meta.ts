import { SourceChannel } from '@prisma/client';

/**
 * Who is on the other end of a request, as far as a record of consent needs
 * to say (CMP-006 D10).
 *
 * New code reads the client address, user agent and declared channel through
 * this one function. The three older copies (phone verification, vitrin
 * public, Turnstile) are deliberately left as they are.
 *
 * - `ipAddress` is `req.ip`, which honours TRUST_PROXY exactly as the auth
 *   throttler does. Behind the web app that is the browser's address only
 *   when the web forwards it (WEB_TRUST_PROXY); otherwise it is the web
 *   server's own, and the record says so honestly rather than guessing.
 * - `userAgent` is the header as received, cut to 500 characters.
 * - `sourceChannel` is the client's own declaration in `x-taktic-client-channel`
 *   (`web` or `mobile`). It is a label with the same trust as the user agent,
 *   not a proof; anything else — including no header — is UNKNOWN.
 */
export const CLIENT_CHANNEL_HEADER = 'x-taktic-client-channel';

export const USER_AGENT_MAX_LENGTH = 500;
const IP_MAX_LENGTH = 64;

export type RequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
  sourceChannel: SourceChannel;
};

/**
 * Structural subset of the Express request, declared locally because the API
 * does not depend on @types/express directly.
 */
export type RequestMetaSource = {
  ip?: unknown;
  headers?: Record<string, unknown>;
};

export function readRequestMeta(req: RequestMetaSource): RequestMeta {
  const rawIp = typeof req.ip === 'string' ? req.ip.trim() : '';
  const rawUserAgent = readHeader(req, 'user-agent')?.trim() ?? '';
  const channel = readHeader(req, CLIENT_CHANNEL_HEADER)?.trim().toLowerCase();

  return {
    ipAddress: rawIp ? rawIp.slice(0, IP_MAX_LENGTH) : null,
    userAgent: rawUserAgent ? rawUserAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
    sourceChannel:
      channel === 'web'
        ? SourceChannel.WEB
        : channel === 'mobile'
          ? SourceChannel.MOBILE
          : SourceChannel.UNKNOWN,
  };
}

function readHeader(req: RequestMetaSource, name: string): string | undefined {
  const value = req.headers?.[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}
