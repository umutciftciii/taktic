import { formPostRoute } from '@taktic/shared';
import { changePassword } from '../../change-password';

/**
 * `POST /account/password/submit` — the signed-in password change.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../../change-password.ts.
 */
export const POST = formPostRoute(changePassword, '/account/password');
