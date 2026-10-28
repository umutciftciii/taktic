import { ConflictException, NotFoundException } from '@nestjs/common';
import { isSandboxIntegrationPermitted } from '../../common/app-environment';

/**
 * Where the `mock` provider's in-app card form may run (RELEASE-GAP-001 G-02).
 *
 * `mock` settles a purchase from a form the provider fills in themselves: no
 * money moves, yet credits load and vitrin rights are granted. That is the
 * point of it on a developer's stack, in the test suite and on staging, and the
 * reason it must not exist on production — where `mock` is also the only
 * provider the boot accepts, so the boot cannot be what closes it.
 *
 * The rule is the sandbox rule every stand-in integration already follows
 * ({@link isSandboxIntegrationPermitted}): never on APP_ENVIRONMENT=production,
 * always on staging, and on a local or undeclared stack only outside
 * NODE_ENV=production. Read on every call, so a test sees the environment it
 * set.
 */
export function isMockPaymentPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSandboxIntegrationPermitted(env);
}

/** The API code a refused mock checkout or mock settlement carries. */
export const MOCK_PAYMENT_UNAVAILABLE = 'MOCK_PAYMENT_UNAVAILABLE';

/**
 * Refuses to open a purchase that only the mock form could settle.
 *
 * 409 rather than 404: the package and the route are real, payments are what
 * this deployment does not have. Thrown before anything is written.
 */
export function assertMockCheckoutPermitted(): void {
  if (isMockPaymentPermitted()) {
    return;
  }

  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: MOCK_PAYMENT_UNAVAILABLE,
    message: 'Payments are not available on this deployment',
  });
}

/**
 * Refuses the mock settlement endpoint itself.
 *
 * 404: on a deployment where the form may not run, the endpoint does not
 * exist. Checked before the purchase is read, so the answer is the same for a
 * purchase that exists, one that does not and one that belongs to someone else.
 */
export function assertMockSettlementPermitted(): void {
  if (isMockPaymentPermitted()) {
    return;
  }

  throw new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: MOCK_PAYMENT_UNAVAILABLE,
    message: 'Mock payment is not available on this deployment',
  });
}
