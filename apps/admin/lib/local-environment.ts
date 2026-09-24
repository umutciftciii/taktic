/**
 * Whether this admin process runs on a developer's machine.
 *
 * The same word the API and the web app read (`APP_ENVIRONMENT`), read at
 * request time. Only the exact value `local` counts. Unset, empty, `staging`,
 * `production` or anything else is not local. A deployment that forgets to set
 * the variable therefore never shows the local sign-in hint.
 */
export function isLocalEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.APP_ENVIRONMENT?.trim() === 'local';
}
