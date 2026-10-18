/**
 * The admin screens reached without a session.
 *
 * One list for the two places that have to agree on it: the middleware lets
 * these through without a cookie, and the shell renders them bare — no menu, no
 * session probe, whose "your session ended" redirect would loop on a page that
 * never had one. A screen added to one and not the other is either unreachable
 * or wrapped in a sidebar that cannot load.
 *
 * ADMIN-AUTH-001 added the two password-reset screens.
 */
export const SIGNED_OUT_SCREENS: ReadonlySet<string> = new Set([
  '/login',
  '/admin-invite',
  '/sifre-unuttum',
  '/sifre-sifirla',
]);

/** Each screen's fixed form target (see @taktic/shared's form-post). */
export const SIGNED_OUT_FORM_TARGETS: ReadonlySet<string> = new Set(
  [...SIGNED_OUT_SCREENS].map((screen) => `${screen}/submit`),
);
