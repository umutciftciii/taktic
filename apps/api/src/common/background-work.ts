/**
 * Work a service starts on its own after the call that asked for it has
 * returned — an outbox sweep fired after a commit, a cleanup scheduled after a
 * save — and that nobody on the request path awaits.
 *
 * Such work is deliberately fire-and-forget in production, and nothing here
 * changes that. What every owner of it owes is a way to *wait* for it: the
 * owner's own shutdown waits for it so a sweep is not cut off under a closing
 * database client, and the test harness waits for it before it empties the
 * database between cases, so a sweep left over from one case never reads
 * tables while the next case's TRUNCATE is locking them (TEST-FLAKE-003).
 */
export interface BackgroundWorkOwner {
  /**
   * Resolves once nothing this owner started is still running — including
   * work that was started while an earlier wait was in progress. Never
   * rejects: a failed run is its owner's to report, not the waiter's.
   */
  whenIdle(): Promise<void>;
}

/**
 * The runs one owner started and has not seen finish.
 *
 * A run is held from the moment it is started, not from the moment it gets
 * going: an outbox's `deliverSoon` first queues behind the sweep already in
 * flight, and a waiter that only looked at "the sweep in flight" could see
 * none in the gap between the two and return while the second was about to
 * begin. Holding the whole call closes that gap.
 */
export class BackgroundRuns {
  private readonly running = new Set<Promise<void>>();

  /**
   * Starts `run` now — synchronously, exactly as calling it directly would —
   * without awaiting it. Its outcome is the caller's to handle inside `run`;
   * here it only marks the end of the run.
   */
  start(run: () => Promise<unknown>): void {
    let started: Promise<unknown>;
    try {
      started = run();
    } catch (error) {
      started = Promise.reject(error);
    }

    const settled: Promise<void> = started
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.running.delete(settled);
      });
    this.running.add(settled);
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  async whenIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all(this.running);
    }
  }
}

export function isBackgroundWorkOwner(value: unknown): value is BackgroundWorkOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<BackgroundWorkOwner>).whenIdle === 'function'
  );
}
