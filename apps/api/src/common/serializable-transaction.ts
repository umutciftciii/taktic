import { ConflictException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Machine-readable code returned to clients when a Serializable transaction
 * could not be committed within the retry budget. Clients may safely retry.
 */
export const CONCURRENT_MODIFICATION_CODE = 'CONCURRENT_MODIFICATION';

/**
 * Prisma error code for "Transaction failed due to a write conflict or a
 * deadlock". PostgreSQL raises it (SQLSTATE 40001) when a Serializable
 * transaction cannot be serialized against a concurrent one. The failing
 * transaction is always rolled back, so re-running the whole callback is safe.
 */
export const PRISMA_WRITE_CONFLICT_ERROR_CODE = 'P2034';

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 15;

/**
 * Structural subset of `PrismaClient` used by {@link runSerializable}, so the
 * helper can be unit tested without a database connection.
 */
export type SerializableTransactionHost = {
  $transaction<T>(
    handler: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T>;
};

export type RunSerializableOptions = {
  /** Short, non-sensitive identifier used for logging (e.g. `offers.refundOfferCredit`). */
  label: string;
  /** Total attempts including the first one. Defaults to 3 (initial + 2 retries). */
  maxAttempts?: number;
  logger?: Pick<Logger, 'warn' | 'error'>;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultLogger = new Logger('SerializableTransaction');

/**
 * Runs `handler` inside a Serializable transaction, retrying only when Prisma
 * reports a write conflict (P2034, or the same 40001 abort raised by a raw
 * query — see {@link isWriteConflictError}).
 *
 * Only those are retried: they guarantee the transaction was rolled back
 * without committing anything, so replaying the callback cannot duplicate work.
 * Every other failure (business exceptions, unique constraint violations, and
 * any other Prisma error) is rethrown untouched, because it either carries a
 * deliberate HTTP status or may have left partial state we must not replay.
 *
 * When the retry budget is exhausted the caller gets an HTTP 409 carrying the
 * `CONCURRENT_MODIFICATION` code instead of an HTTP 500 leaking Prisma internals.
 */
export async function runSerializable<T>(
  host: SerializableTransactionHost,
  handler: (tx: Prisma.TransactionClient) => Promise<T>,
  options: RunSerializableOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const logger = options.logger ?? defaultLogger;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await host.$transaction(handler, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

      if (attempt > 1) {
        logger.warn(
          `${options.label}: serializable transaction committed on attempt ${attempt}/${maxAttempts}`,
        );
      }

      return result;
    } catch (error) {
      if (!isWriteConflictError(error)) {
        throw error;
      }

      if (attempt >= maxAttempts) {
        logger.error(
          `${options.label}: serializable write conflict unresolved after ${maxAttempts} attempts`,
        );
        throw concurrentModificationException();
      }

      logger.warn(
        `${options.label}: serializable write conflict on attempt ${attempt}/${maxAttempts}, retrying`,
      );
      await sleep(nextDelayMs(attempt, random));
    }
  }
}

/**
 * Prisma error code for a failed raw query (`$queryRaw` / `$executeRaw`). It
 * carries the database's own SQLSTATE in `meta.code`.
 */
const PRISMA_RAW_QUERY_FAILED_ERROR_CODE = 'P2010';

/**
 * SQLSTATE `serialization_failure`. Through a model query Prisma reports it as
 * P2034, but through a raw query (such as a `SELECT … FOR NO KEY UPDATE` row
 * lock) it reports it as P2010 with this code. It is the same abort, the
 * transaction rolled back, so it is retried the same way. A deadlock (40P01)
 * is deliberately not on this list: it means two writers lock in opposite
 * orders, and that is fixed in the lock order, not by retrying.
 */
const POSTGRES_SERIALIZATION_FAILURE_SQLSTATE = '40001';

export function isWriteConflictError(error: unknown): boolean {
  // Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`:
  // Prisma errors can cross module-instance boundaries where `instanceof` fails.
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code === PRISMA_WRITE_CONFLICT_ERROR_CODE) {
    return true;
  }

  return (
    code === PRISMA_RAW_QUERY_FAILED_ERROR_CODE &&
    typeof meta === 'object' &&
    meta !== null &&
    (meta as { code?: unknown }).code === POSTGRES_SERIALIZATION_FAILURE_SQLSTATE
  );
}

/**
 * True for the exception {@link runSerializable} raises when its retry budget is
 * exhausted.
 *
 * The seam exists because "we could not commit" and "we refused" are different
 * answers, and only the caller knows which of the two its own protocol should
 * report. Most callers want the 409 to travel: a person pressing a button can
 * press it again. A caller whose peer is a machine that retries on any non-2xx
 * — the payment webhook — has to decide from committed state instead, and it
 * cannot decide what it cannot recognise.
 *
 * Duck-typed on the response body rather than `instanceof ConflictException`,
 * for the reason {@link isWriteConflictError} gives about Prisma errors: a
 * second copy of a module makes `instanceof` lie, and this predicate guards a
 * branch where lying means answering the wrong thing to a payment provider.
 */
export function isConcurrentModificationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const getResponse = (error as { getResponse?: unknown }).getResponse;
  if (typeof getResponse !== 'function') {
    return false;
  }

  const response = (getResponse as () => unknown).call(error);

  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === CONCURRENT_MODIFICATION_CODE
  );
}

export function concurrentModificationException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: CONCURRENT_MODIFICATION_CODE,
    message: 'İşlem eşzamanlı bir güncellemeyle çakıştı. Lütfen birkaç saniye içinde tekrar deneyin.',
  });
}

function nextDelayMs(attempt: number, random: () => number) {
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.round(base + random() * RETRY_BASE_DELAY_MS);
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
