import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const AUTH_THROTTLE_TTL_MS = positiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 60) * 1000;
export const AUTH_THROTTLE_LIMIT = positiveInt(process.env.AUTH_RATE_LIMIT_MAX, 10);

/**
 * Rate limiter for the credential endpoints only (login / register).
 *
 * It is deliberately *not* registered as an APP_GUARD: throttling every route
 * would break admin list screens and provider dashboards that legitimately
 * issue many requests per minute.
 *
 * Client identity comes from Express `req.ip`. Express only derives that from
 * `X-Forwarded-For` when `trust proxy` is enabled, which main.ts does solely
 * when TRUST_PROXY is set — so a spoofed header cannot dodge the limit in a
 * default deployment.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = typeof req?.ip === 'string' && req.ip ? req.ip : null;
    const socketIp = req?.socket?.remoteAddress ?? null;
    return ip ?? socketIp ?? 'unknown';
  }
}
