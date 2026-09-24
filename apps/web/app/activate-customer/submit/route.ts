import { formPostRoute } from '@taktic/shared';
import { submitCustomerActivation } from '../activate';

/**
 * `POST /activate-customer/submit` — setting the first password on an account
 * the platform opened for a guest request.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../activate.ts.
 */
export const POST = formPostRoute(submitCustomerActivation, '/activate-customer');
