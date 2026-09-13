import { Injectable } from '@nestjs/common';
import { AuthThrottlerGuard } from '../auth/auth.throttler';

/**
 * The draft endpoint's own budget: the `request-drafts` named throttler on
 * AuthModule's shared `forRoot` (see the comments there and on
 * AuthThrottlerGuard), using the same IP tracker as login.
 *
 * Deliberately a subclass and not a second IP resolver: client identity is
 * whatever Express `req.ip` says under `trust proxy`, exactly as for login, so
 * a forged X-Forwarded-For buys nothing here that it does not buy there.
 * `throttlerName` is the only thing this overrides — `onModuleInit` on the
 * base class does the actual narrowing, so this guard enforces only
 * `request-drafts` and never the credential endpoints' `auth` budget.
 */
@Injectable()
export class RequestDraftThrottlerGuard extends AuthThrottlerGuard {
  protected readonly throttlerName = 'request-drafts';
}
