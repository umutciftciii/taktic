import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../lib/password-policy';
import { accountFetch, readFormString } from './account-fetch';

/**
 * Changes the password, and never writes one anywhere it could be read back.
 *
 * Runs from the `/account/password/submit` route handler — a fixed URL, so the
 * form still works in a tab rendered by a previous build (see @taktic/shared's
 * form-post). It answers the path to send the browser to.
 *
 * The refusals travel as codes rather than as text, and the screen owns the
 * sentence each one prints. That is not only tidier: it is what guarantees no
 * fragment of what was typed can end up in a URL, in browser history, or in a
 * referrer header on the way to the next page.
 *
 * The three checks made here are the same ones the API makes, in the same
 * order. They are a courtesy that saves a round trip, not the rule — the server
 * repeats every one of them against the stored hash, which is the only place
 * "is this really your password" can be answered.
 */
export async function changePassword(formData: FormData): Promise<string> {
  const currentPassword = readFormString(formData, 'currentPassword');
  const newPassword = readFormString(formData, 'password');
  const newPasswordConfirm = readFormString(formData, 'passwordConfirm');

  if (!currentPassword) {
    return '/account/password?error=current';
  }

  if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
    return '/account/password?error=policy';
  }

  if (newPassword !== newPasswordConfirm) {
    return '/account/password?error=mismatch';
  }

  if (newPassword === currentPassword) {
    return '/account/password?error=same';
  }

  const response = await accountFetch('/account/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword, newPasswordConfirm }),
  });

  if (!response.ok) {
    return `/account/password?error=${await passwordErrorCode(response)}`;
  }

  // The session this browser holds survived the change on purpose — every
  // other one was revoked — so the person stays where they are and is told so.
  return '/account/password?success=1';
}

/**
 * Which refusal it was, as a code the screen can print a sentence for.
 *
 * Everything the API can say at this point has already been narrowed by the
 * checks above: a 409 is an account with no password to change, and the only
 * 400 left is the current password not matching.
 */
async function passwordErrorCode(response: Response): Promise<string> {
  if (response.status === 409) {
    return 'nopassword';
  }

  if (response.status === 400) {
    return 'current';
  }

  if (response.status === 429) {
    return 'throttled';
  }

  return 'submit';
}
