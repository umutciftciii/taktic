import { formPostRoute } from '@taktic/shared';
import { requestPasswordReset } from '../request-reset';

/**
 * `POST /sifre-unuttum/submit` — "şifremi unuttum".
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../request-reset.ts.
 */
export const POST = formPostRoute(requestPasswordReset, '/sifre-unuttum');
