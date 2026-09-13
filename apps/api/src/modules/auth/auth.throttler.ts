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
 *
 * AuthModule's `ThrottlerModule.forRoot` now carries a second named throttler
 * (`request-drafts`, for RequestDraftThrottlerGuard below) alongside `auth`,
 * because `@nestjs/throttler` v6 does not merge two separate `forRoot` calls —
 * see the comment on that `forRoot` for why they have to share one. The base
 * `ThrottlerGuard.canActivate` enforces *every* named throttler it is handed
 * unless a route opts out with `@SkipThrottle`. Throttler storage keys are
 * class + handler + throttler name + tracker, so this is not shared
 * consumption with the draft endpoint — it is every one of this guard's
 * routes, including the ones this file's own author does not remember exist
 * next month, silently gaining a second, independent `request-drafts` counter
 * (5 per 10 minutes) on top of the `auth` one it already enforces. `onModuleInit`
 * below narrows `this.throttlers` to this guard's own name right after the
 * base class populates it, once, at startup: a structural fix that does not
 * depend on every present and future caller of `@UseGuards(AuthThrottlerGuard)`
 * remembering a decorator.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  /**
   * Which of AuthModule's named throttlers this guard class enforces.
   * RequestDraftThrottlerGuard overrides this to scope itself to the other
   * one, off the same shared options.
   */
  protected readonly throttlerName: string = 'auth';

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((throttler) => throttler.name === this.throttlerName);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = typeof req?.ip === 'string' && req.ip ? req.ip : null;
    const socketIp = req?.socket?.remoteAddress ?? null;
    return ip ?? socketIp ?? 'unknown';
  }
}
