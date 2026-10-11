import { Injectable } from '@nestjs/common';
import { AuthThrottlerGuard } from '../auth/auth.throttler';

/**
 * REL-002 Faz 3: the attempt budget of `POST /service-requests/:id/service-issue`
 * — the `service-issues` named throttler on AuthModule's shared `forRoot`,
 * scoped to its own name like the other subclasses.
 *
 * Tracked by the signed-in customer, not by IP: the route sits behind
 * AuthGuard (which runs first), and the abuse it guards against — one account
 * burning through providers — is an account's, wherever it connects from.
 * Successful reports have a second, persistent budget in the service itself
 * (incidents per customer per window).
 */
@Injectable()
export class ServiceIssueThrottlerGuard extends AuthThrottlerGuard {
  protected readonly throttlerName = 'service-issues';

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = typeof req?.user?.id === 'string' ? req.user.id : null;
    return userId ? `user:${userId}` : super.getTracker(req);
  }
}
