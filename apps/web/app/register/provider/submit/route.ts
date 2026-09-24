import { formPostRoute } from '@taktic/shared';
import { registerProvider } from '../../register';

/**
 * `POST /register/provider/submit` — the provider sign-up form.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../../register.ts.
 */
export const POST = formPostRoute(registerProvider, '/register/provider');
