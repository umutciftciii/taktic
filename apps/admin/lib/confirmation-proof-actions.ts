'use server';

import { isConfirmationProofKey } from './confirmation-proof-keys';
import { issueConfirmationProof } from './confirmation-proof-server';

/**
 * Called by `ConfirmDialog` when its confirm button is pressed, and by nothing
 * else: the proof exists only once a person has said yes. Before hydration the
 * handler that calls this does not exist, so a queued or JavaScript-less
 * submission reaches its action without one and is refused there.
 *
 * Answers null for an unknown key or a request with no session; the dialog
 * then stays open and says so rather than submitting.
 */
export async function mintConfirmationProof(key: string): Promise<string | null> {
  if (!isConfirmationProofKey(key)) return null;
  return issueConfirmationProof(key);
}
