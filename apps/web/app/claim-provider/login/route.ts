import { formPostRoute } from '@taktic/shared';
import { startClaimLogin } from '../claim';

/**
 * `POST /claim-provider/login` — "giriş yaparak sahiplen": keeps the claim
 * token in its cookie and sends the applicant to sign in.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../claim.ts.
 */
export const POST = formPostRoute(startClaimLogin, '/claim-provider');
