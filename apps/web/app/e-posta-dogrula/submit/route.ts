import { formPostRoute } from '@taktic/shared';
import { submitEmailVerification } from '../verify';

/**
 * `POST /e-posta-dogrula/submit` — the "E-postamı doğrula" button.
 *
 * The one place the link is spent (STAGING-UAT-001 B3): opening the page only
 * reads it, so a mail scanner or a link preview can no longer use it up. A fixed
 * URL rather than a Server Action id, so the button survives a deploy. See
 * @taktic/shared's form-post and ../verify.ts.
 */
export const POST = formPostRoute(submitEmailVerification, '/e-posta-dogrula');
