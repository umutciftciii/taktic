import { Injectable, Logger } from '@nestjs/common';
import { OpsAlertRecipientStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { OPS_ALERT_RECIPIENT_LOCK_KEY } from './ops-alert-recipient.constants';
import { recordRotationAudit } from './ops-alert-recipient.audit';
import { RecipientDecryptError, addressHmac, decryptAddress, encryptAddress, normalizeAddress } from './recipient-crypto';
import { resolveRecipientCryptoConfig } from './recipient-crypto.config';

/**
 * OBS-ALERT-002 — online key rotation.
 *
 * `rewrap` re-seals every live (ACTIVE / PAUSED) address under the active
 * encryption key; `rehash` recomputes the identity HMAC of every live row
 * whose stored version is not the current one. Each row runs in its own short
 * transaction under the recipient lock, guarded by `version` and the old
 * key id / hmac version, so a concurrent edit or delete wins and the row is
 * simply left for the next run. A row that cannot be processed (its key left
 * the keyring, or a new HMAC collides with another live row's) counts as
 * `failed`, stays untouched, and the run goes on.
 *
 * The crypto config is resolved on every run: rotating means changing the
 * environment, and nothing here caches the old keys. The audit rows carry
 * only `{ keyId }` / `{ hmacVersion }`.
 */

export type RewrapResult = { rewrapped: number; failed: number };
export type RehashResult = { rehashed: number; failed: number };

const LIVE: OpsAlertRecipientStatus[] = [OpsAlertRecipientStatus.ACTIVE, OpsAlertRecipientStatus.PAUSED];

/** Thrown by rehashOne when the new HMAC equals another live row's. */
class HmacCollisionError extends Error {
  constructor() {
    super('hmac collision');
  }
}

/**
 * The coarse reason a row failed, for the log line. Never the error message:
 * a driver error can quote row values.
 */
export type RotationFailureReason = 'no-key' | 'collision' | 'other';

function failureReason(error: unknown): RotationFailureReason {
  if (error instanceof RecipientDecryptError) return 'no-key';
  if (error instanceof HmacCollisionError) return 'collision';
  return 'other';
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const meta = error.meta as { code?: unknown } | undefined;
  return error.code === 'P2002' || meta?.code === '23505';
}

@Injectable()
export class OpsAlertKeyRotationService {
  private readonly logger = new Logger(OpsAlertKeyRotationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** One line per failed row: the recipient id and a coarse reason — never an address, a key or an error message. */
  private logFailure(operation: 'rewrap' | 'rehash', id: string, error: unknown): void {
    this.logger.warn(`ops-alert recipient ${operation} failed: recipient=${id} reason=${failureReason(error)}`);
  }

  async rewrap(actor: AuthUser): Promise<RewrapResult> {
    const config = resolveRecipientCryptoConfig();
    const ids = await this.prisma.opsAlertRecipient.findMany({
      where: { status: { in: LIVE }, OR: [{ addressKeyId: null }, { addressKeyId: { not: config.activeKeyId } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const result: RewrapResult = { rewrapped: 0, failed: 0 };
    for (const { id } of ids) {
      try {
        if (await this.rewrapOne(actor, id)) result.rewrapped += 1;
      } catch (error) {
        this.logFailure('rewrap', id, error);
        result.failed += 1;
      }
    }
    return result;
  }

  async rehash(actor: AuthUser): Promise<RehashResult> {
    const config = resolveRecipientCryptoConfig();
    const ids = await this.prisma.opsAlertRecipient.findMany({
      where: { status: { in: LIVE }, OR: [{ addressHmacVersion: null }, { addressHmacVersion: { not: config.hmacVersion } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const result: RehashResult = { rehashed: 0, failed: 0 };
    for (const { id } of ids) {
      try {
        if (await this.rehashOne(actor, id)) result.rehashed += 1;
      } catch (error) {
        this.logFailure('rehash', id, error);
        result.failed += 1;
      }
    }
    return result;
  }

  private locked<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPS_ALERT_RECIPIENT_LOCK_KEY}::bigint)`;
      return work(tx);
    });
  }

  /** True when the row moved; false when it no longer needed to (changed or deleted meanwhile). Throws when it cannot. */
  private rewrapOne(actor: AuthUser, id: string): Promise<boolean> {
    return this.locked(async (tx) => {
      const config = resolveRecipientCryptoConfig();
      const row = await tx.opsAlertRecipient.findUnique({
        where: { id },
        select: {
          status: true,
          version: true,
          addressCiphertext: true,
          addressNonce: true,
          addressTag: true,
          addressKeyId: true,
        },
      });
      if (
        !row ||
        !LIVE.includes(row.status) ||
        row.addressKeyId === config.activeKeyId
      ) {
        return false;
      }
      if (!row.addressCiphertext || !row.addressNonce || !row.addressTag || !row.addressKeyId) {
        throw new Error('recipient has no sealed address');
      }
      const address = decryptAddress(config, id, {
        ciphertext: Buffer.from(row.addressCiphertext),
        nonce: Buffer.from(row.addressNonce),
        tag: Buffer.from(row.addressTag),
        keyId: row.addressKeyId,
      });
      const sealed = encryptAddress(config, id, address);
      const updated = await tx.opsAlertRecipient.updateMany({
        where: { id, version: row.version, status: { in: LIVE }, addressKeyId: row.addressKeyId },
        data: {
          addressCiphertext: new Uint8Array(sealed.ciphertext),
          addressNonce: new Uint8Array(sealed.nonce),
          addressTag: new Uint8Array(sealed.tag),
          addressKeyId: sealed.keyId,
          version: { increment: 1 },
          updatedById: actor.id,
        },
      });
      if (updated.count !== 1) return false;
      await recordRotationAudit(tx, {
        recipientId: id,
        actorId: actor.id,
        action: 'REWRAPPED',
        before: { keyId: row.addressKeyId },
        after: { keyId: sealed.keyId },
      });
      return true;
    });
  }

  private async rehashOne(actor: AuthUser, id: string): Promise<boolean> {
    try {
      return await this.locked(async (tx) => {
        const config = resolveRecipientCryptoConfig();
        const row = await tx.opsAlertRecipient.findUnique({
          where: { id },
          select: {
            status: true,
            version: true,
            addressCiphertext: true,
            addressNonce: true,
            addressTag: true,
            addressKeyId: true,
            addressHmacVersion: true,
          },
        });
        if (!row || !LIVE.includes(row.status) || row.addressHmacVersion === config.hmacVersion) return false;
        if (!row.addressCiphertext || !row.addressNonce || !row.addressTag || !row.addressKeyId) {
          throw new Error('recipient has no sealed address');
        }
        const address = decryptAddress(config, id, {
          ciphertext: Buffer.from(row.addressCiphertext),
          nonce: Buffer.from(row.addressNonce),
          tag: Buffer.from(row.addressTag),
          keyId: row.addressKeyId,
        });
        const identity = addressHmac(config, normalizeAddress(address));
        const updated = await tx.opsAlertRecipient.updateMany({
          where: { id, version: row.version, status: { in: LIVE }, addressHmacVersion: row.addressHmacVersion },
          data: {
            addressHmac: identity.hmac,
            addressHmacVersion: identity.version,
            version: { increment: 1 },
            updatedById: actor.id,
          },
        });
        if (updated.count !== 1) return false;
        await recordRotationAudit(tx, {
          recipientId: id,
          actorId: actor.id,
          action: 'REHASHED',
          before: { hmacVersion: row.addressHmacVersion ?? 0 },
          after: { hmacVersion: identity.version },
        });
        return true;
      });
    } catch (error) {
      // Two live rows of one address now hash equal: that row stays on the old hash.
      if (isUniqueViolation(error)) throw new HmacCollisionError();
      throw error;
    }
  }
}
