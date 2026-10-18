import { formPostRoute } from '@taktic/shared';
import { confirmPasswordReset } from '../confirm-reset';

/**
 * `POST /sifre-sifirla/submit` — an operator setting a new password.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../confirm-reset.ts.
 */
export const POST = formPostRoute(confirmPasswordReset, '/sifre-sifirla');
