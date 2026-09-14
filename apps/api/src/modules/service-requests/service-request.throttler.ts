import { Injectable } from '@nestjs/common';
import { AuthThrottlerGuard } from '../auth/auth.throttler';

/**
 * The creation endpoint's own budget: the `service-requests` named throttler
 * on AuthModule's shared `forRoot` (see the comments there and on
 * AuthThrottlerGuard), using the same IP tracker as login and the request
 * draft endpoint.
 *
 * Deliberately a subclass and not a second IP resolver, for the same reason
 * RequestDraftThrottlerGuard is: client identity is whatever Express `req.ip`
 * says under `trust proxy`, exactly as for login, so a forged
 * X-Forwarded-For buys nothing here that it does not buy there.
 * `throttlerName` is the only thing this overrides — `onModuleInit` on the
 * base class does the actual narrowing, so this guard enforces only
 * `service-requests` and never the credential or draft endpoints' budgets.
 */
@Injectable()
export class ServiceRequestThrottlerGuard extends AuthThrottlerGuard {
  protected readonly throttlerName = 'service-requests';
}
