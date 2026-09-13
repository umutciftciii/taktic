import { Injectable } from '@nestjs/common';
import { AuthThrottlerGuard } from '../auth/auth.throttler';

/**
 * The draft endpoint's own budget, on the credential endpoints' tracker.
 *
 * Deliberately a subclass and not a second IP resolver: client identity is
 * whatever Express `req.ip` says under `trust proxy`, exactly as for login, so
 * a forged X-Forwarded-For buys nothing here that it does not buy there.
 */
@Injectable()
export class RequestDraftThrottlerGuard extends AuthThrottlerGuard {}
