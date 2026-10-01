import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  CONFIRMATION_PROOF_FIELD,
  mintProof,
  verifyAndSpendProof,
  type ConfirmationProofKey,
  type ProofLedger,
  type ProofVerdict,
} from './confirmation-proof';

/**
 * The confirmation proof's server half: where the secret, the clock, the
 * session and the spent-nonce ledger come from (design: `confirmation-proof.ts`).
 *
 * **Secret.** `ADMIN_CONFIRMATION_PROOF_SECRET` when it is set — the same value
 * on every instance lets a proof minted by one be verified by another. Unset,
 * each process draws its own random secret at first use, which is all a single
 * panel process needs and leaves the local stack bootable with no new value.
 *
 * **Ledger.** In the process's memory, for the proof's lifetime. Several panel
 * instances behind a load balancer each keep their own: a proof stays bound to
 * its session, key and two-minute expiry everywhere, and single use holds per
 * instance.
 *
 * Both sit on `globalThis` so that `next dev`, which may evaluate a module once
 * per route bundle, still has one secret and one ledger per process.
 */

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

type ProofStore = { secret: Buffer; ledger: ProofLedger };

const holder = globalThis as typeof globalThis & { __takticConfirmationProof?: ProofStore };

function proofStore(): ProofStore {
  if (!holder.__takticConfirmationProof) {
    const configured = process.env.ADMIN_CONFIRMATION_PROOF_SECRET?.trim();
    holder.__takticConfirmationProof = {
      secret: configured ? Buffer.from(configured, 'utf8') : randomBytes(32),
      ledger: new Map(),
    };
  }
  return holder.__takticConfirmationProof;
}

async function currentSessionValue(): Promise<string | null> {
  return (await cookies()).get(AUTH_COOKIE_NAME)?.value ?? null;
}

/** A fresh proof for this session, or null when there is no session to bind it to. */
export async function issueConfirmationProof(key: ConfirmationProofKey): Promise<string | null> {
  const sessionValue = await currentSessionValue();
  if (!sessionValue) return null;
  return mintProof({ key, sessionValue, secret: proofStore().secret, now: Date.now() });
}

/**
 * Whether this submission carries a good, unspent proof for `key` — and if it
 * does, spends it. A guarded server action calls this **before** any write and
 * refuses the submission when it answers false.
 */
export async function verifyConfirmationProof(
  source: FormData | string | null | undefined,
  key: ConfirmationProofKey,
): Promise<ProofVerdict> {
  const token = source instanceof FormData ? source.get(CONFIRMATION_PROOF_FIELD) : source;
  const { secret, ledger } = proofStore();
  return verifyAndSpendProof({ token, key, sessionValue: await currentSessionValue(), secret, ledger, now: Date.now() });
}

export async function hasConfirmationProof(
  source: FormData | string | null | undefined,
  key: ConfirmationProofKey,
): Promise<boolean> {
  return (await verifyConfirmationProof(source, key)).ok;
}
