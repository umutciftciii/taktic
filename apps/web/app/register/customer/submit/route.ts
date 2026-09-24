import { formPostRoute } from '@taktic/shared';
import { registerCustomer } from '../../register';

/**
 * `POST /register/customer/submit` — the customer sign-up form.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../../register.ts.
 */
export const POST = formPostRoute(registerCustomer, '/register/customer');
