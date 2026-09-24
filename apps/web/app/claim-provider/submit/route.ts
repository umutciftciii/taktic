import { formPostRoute } from '@taktic/shared';
import { submitProviderClaim } from '../claim';

/**
 * `POST /claim-provider/submit` — claiming a business application.
 *
 * A fixed URL rather than a Server Action id, so the form survives a deploy.
 * See @taktic/shared's form-post and ../claim.ts.
 */
export const POST = formPostRoute(submitProviderClaim, '/claim-provider');
