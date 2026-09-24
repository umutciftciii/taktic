import { formPostRoute } from '@taktic/shared';
import { submitAdminInvite } from '../accept-invite';

/**
 * `POST /admin-invite/submit` — an invited operator choosing a password.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../accept-invite.ts.
 */
export const POST = formPostRoute(submitAdminInvite, '/admin-invite');
