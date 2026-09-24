'use server';

import { safeRedirectPathOrNull } from '@taktic/shared';
import { redirect } from 'next/navigation';
import { endSession } from '../session/end-session';

/*
 * The sign-in and sign-out forms no longer post here: they post to the
 * `/login/submit` and `/logout` route handlers, whose URLs do not change from one
 * build to the next (see @taktic/shared's form-post). What is left is the one
 * account action the request forms call from their own client code.
 */

/**
 * "Hesap değiştir": ends this session and goes to sign-in, carrying the form
 * the customer was on so the next account lands back there.
 *
 * Invoked from a request form that found a draft belonging to another account.
 * The draft itself is left alone — it is the *other* account's to continue,
 * and it is what the customer is switching accounts to reach.
 */
export async function switchAccountAction(redirectTo: string) {
  await endSession();
  // Whatever the form handed over passes the same check the sign-in form's
  // own `redirectTo` does; `null` falls back to the home page.
  const target = safeRedirectPathOrNull(redirectTo) ?? '/';
  redirect(`/login?redirectTo=${encodeURIComponent(target)}`);
}
