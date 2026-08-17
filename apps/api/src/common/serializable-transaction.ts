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
 * reports a write conflict / deadlock (P2034).
 *
 * Only P2034 is retried: that error guarantees the transaction was rolled back
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

export function isWriteConflictError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === PRISMA_WRITE_CONFLICT_ERROR_CODE;
  }

  // Prisma errors can cross module-instance boundaries where `instanceof` fails,
  // so fall back to the error code itself.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PRISMA_WRITE_CONFLICT_ERROR_CODE
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
