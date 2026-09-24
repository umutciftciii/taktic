import { formPostRoute } from '@taktic/shared';
import { signIn } from '../sign-in';

/**
 * `POST /login/submit` — the sign-in form's target.
 *
 * A fixed URL instead of a Server Action id, so a sign-in form left open across
 * a deploy still reaches the code that handles it. See @taktic/shared's
 * form-post for the origin check and the `303`, and sign-in.ts for the rest.
 */
export const POST = formPostRoute(signIn, '/login');
