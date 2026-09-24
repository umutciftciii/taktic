import { formPostRoute } from '@taktic/shared';
import { endSession } from '../session/end-session';

/**
 * `POST /logout` — every sign-out form in the web app.
 *
 * A fixed URL for the same reason as `/login/submit`: "Çıkış yap" in a tab
 * rendered by a previous build has to sign the person out, not show them an
 * error. The same origin check applies, so another site cannot sign anybody
 * out either.
 *
 * Where to land is one of two fixed places. The public header returns to the
 * sign-in screen; the customer and provider panels send `after=home`, which is
 * where their Server Actions used to go. Nothing the form posts can name any
 * other destination.
 */
export const POST = formPostRoute(async (formData) => {
  await endSession();
  return formData.get('after') === 'home' ? '/' : '/login';
}, '/login');
