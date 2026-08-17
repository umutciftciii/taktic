import { ConflictException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_MODIFICATION_CODE,
  isWriteConflictError,
  runSerializable,
  type SerializableTransactionHost,
} from '../src/common/serializable-transaction';

/**
 * Unit coverage for the retry helper. It needs no database: a P2034 abort is
 * expensive and non-deterministic to provoke for real, so the outcome of each
 * attempt is scripted here. The integration suite proves the same contract
 * end-to-end over HTTP; this file proves the parts that only fire when the
 * retry budget actually runs out.
 */

function writeConflictError() {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: 'test' },
  );
}

/** Replays one queued outcome per attempt and records how many ran. */
function fakeHost(outcomes: Array<() => unknown>) {
  const state = { attempts: 0 };
  const host: SerializableTransactionHost = {
    async $transaction(handler) {
      const outcome = outcomes[state.attempts];
      state.attempts += 1;
      if (!outcome) {
        throw new Error('fake host ran out of queued outcomes');
      }
      // Irrelevant here, but it must stay callable so the signature matches the
      // real client.
      void handler;
      return outcome() as never;
    },
  };

  return { host, state };
}

const throws = (error: unknown) => () => {
  throw error;
};

// Deterministic: no real sleeping, no jitter randomness.
const silentOptions = {
  label: 'test.path',
  logger: { warn: () => {}, error: () => {} },
  sleep: async () => {},
  random: () => 0,
};

describe('runSerializable', () => {
  it('returns the result without retrying when the transaction commits', async () => {
    const { host, state } = fakeHost([() => 'ok']);

    await expect(runSerializable(host, async () => 'ok', silentOptions)).resolves.toBe('ok');
    expect(state.attempts).toBe(1);
  });

  it('retries a P2034 write conflict and returns the eventual success', async () => {
    const { host, state } = fakeHost([
      throws(writeConflictError()),
      throws(writeConflictError()),
      () => 'ok',
    ]);

    await expect(runSerializable(host, async () => 'ok', silentOptions)).resolves.toBe('ok');
    expect(state.attempts).toBe(3);
  });

  it('gives up after 3 attempts with a 409 CONCURRENT_MODIFICATION response', async () => {
    const { host, state } = fakeHost([
      throws(writeConflictError()),
      throws(writeConflictError()),
      throws(writeConflictError()),
    ]);

    const error = await runSerializable(host, async () => 'ok', silentOptions).catch(
      (err: unknown) => err,
    );

    expect(state.attempts).toBe(3);
    expect(error).toBeInstanceOf(ConflictException);

    const conflict = error as ConflictException;
    expect(conflict.getStatus()).toBe(HttpStatus.CONFLICT);

    const response = conflict.getResponse() as Record<string, unknown>;
    expect(response.code).toBe(CONCURRENT_MODIFICATION_CODE);
    expect(response.statusCode).toBe(HttpStatus.CONFLICT);
    // The client-facing message must not leak Prisma internals.
    expect(String(response.message)).not.toContain('P2034');
    expect(String(response.message).toLowerCase()).not.toContain('deadlock');
  });

  it('does not retry a P2002 unique constraint violation', async () => {
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { host, state } = fakeHost([throws(uniqueViolation)]);

    await expect(runSerializable(host, async () => 'ok', silentOptions)).rejects.toBe(
      uniqueViolation,
    );
    // Rethrown untouched so createOffer's catch can still map it to a 409.
    expect(state.attempts).toBe(1);
  });

  it('does not retry business-rule exceptions', async () => {
    const businessError = new ConflictException('Offer credit already refunded');
    const { host, state } = fakeHost([throws(businessError)]);

    await expect(runSerializable(host, async () => 'ok', silentOptions)).rejects.toBe(businessError);
    expect(state.attempts).toBe(1);
  });

  it('does not retry the category pricing conflicts raised inside the transaction', async () => {
    const priceUnset = new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: 'CATEGORY_PRICE_UNSET',
      message: 'Bu kategori için teklif kredisi tanımlı değil.',
    });
    const { host, state } = fakeHost([throws(priceUnset)]);

    await expect(runSerializable(host, async () => 'ok', silentOptions)).rejects.toBe(priceUnset);
    expect(state.attempts).toBe(1);
  });

  it('honours a custom attempt budget', async () => {
    const { host, state } = fakeHost([throws(writeConflictError()), throws(writeConflictError())]);

    await expect(
      runSerializable(host, async () => 'ok', { ...silentOptions, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state.attempts).toBe(2);
  });
});

describe('isWriteConflictError', () => {
  it('detects P2034 Prisma errors', () => {
    expect(isWriteConflictError(writeConflictError())).toBe(true);
  });

  it('detects P2034 shaped errors that fail instanceof across module instances', () => {
    expect(isWriteConflictError({ code: 'P2034' })).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isWriteConflictError(new Error('boom'))).toBe(false);
    expect(isWriteConflictError({ code: 'P2002' })).toBe(false);
    expect(isWriteConflictError(null)).toBe(false);
  });
});
