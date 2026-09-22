import { mayReachAdminPanel } from './admin-permissions';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthUser } from './auth.types';
import { getSessionIdFromRequest } from './cookie';

/** The little of a request this check reads: whatever carries a credential. */
export type CredentialCarryingRequest = {
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * The gate in front of a *public* endpoint's privileged view.
 *
 * Some endpoints serve everybody and additionally answer a wider question to an
 * operator — `GET /categories?includeInactive=true` is the case this exists
 * for. Those cannot sit behind {@link AuthGuard}, because the public form has to
 * stay reachable signed out; so the elevation is decided here, per request,
 * before the handler reaches the data.
 *
 * Two failures, deliberately distinguished:
 *
 * - A caller who presented no credential at all, or presented a good one that
 *   is not a SUPER_ADMIN's, is refused with 403. There is nothing to
 *   authenticate — they are simply not allowed to ask.
 * - A caller who *did* present a credential the API could not resolve — an
 *   expired session, a forged cookie, an Authorization header this API has no
 *   scheme for — gets 401, the same answer {@link AuthGuard} gives the same
 *   request. Silently demoting a broken credential to "anonymous" is how a
 *   client discovers its session died as a wrong answer rather than as a
 *   sign-in prompt.
 */
export function assertElevatedQueryAccess(
  request: CredentialCarryingRequest,
  user: AuthUser | null | undefined,
): void {
  /*
   * Any staff account with panel access (PR-0), not only a super admin.
   *
   * The elevated view here is the operator's catalogue — DRAFT and INACTIVE
   * categories — and "an operator" now means a staff account somebody has
   * given a role to. A staff account with no live role is refused exactly as a
   * customer is, because it cannot open the panel either.
   *
   * It is deliberately panel access rather than a named permission: these are
   * public routes that widen for an operator, so there is no handler-level
   * permission to name, and inventing one would put a value in the catalogue
   * that guards no route — the thing the closed catalogue exists to prevent.
   */
  if (mayReachAdminPanel(user ? { role: user.role, permissions: user.permissions ?? [] } : null)) {
    return;
  }

  if (!user && presentsUnusableCredential(request)) {
    throw new UnauthorizedException('Authentication required');
  }

  throw new ForbiddenException('Insufficient role');
}

/**
 * Whether the caller tried to authenticate and failed.
 *
 * The session cookie is this API's only credential, so a cookie that resolved
 * to no user is the ordinary case. An `Authorization` header is counted too:
 * nothing here accepts one, which is exactly why a request carrying one must
 * not be served as if it had asked anonymously.
 */
function presentsUnusableCredential(request: CredentialCarryingRequest): boolean {
  return (
    getSessionIdFromRequest(request) !== null || request.headers?.authorization !== undefined
  );
}
