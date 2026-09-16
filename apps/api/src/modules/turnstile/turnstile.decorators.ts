import { SetMetadata } from '@nestjs/common';
import type { TurnstileAction as TurnstileActionName } from './turnstile.constants';

export const TURNSTILE_ACTION_KEY = 'turnstile:action';

/**
 * Names the operation a protected route performs, for the guard to hold the
 * token's `action` against. Always paired with `@UseGuards(TurnstileGuard)`;
 * a guard that finds no name refuses the request rather than guessing one.
 */
export const TurnstileAction = (action: TurnstileActionName) => SetMetadata(TURNSTILE_ACTION_KEY, action);
