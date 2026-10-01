/**
 * Stands in for `lib/confirmation-proof-actions.ts` in the browser harness,
 * which has no Next server to run a server action on. The component harness
 * (e2e/src/component-harness.ts) resolves the real module to this one.
 *
 * It hands out a recognisable proof per request — `harness-proof-<n>` — so a
 * test can see that the dialog asked for one, sent it, and sent it once; or
 * answers null in `refuse` mode, as the server does with no session.
 */
export async function mintConfirmationProof(key: string): Promise<string | null> {
  const harness = window.__harness;
  harness.minted.push(key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return harness.mintMode === 'refuse' ? null : `harness-proof-${harness.minted.length}`;
}
