/**
 * Opt-in switch for the file outbox transport (see file-outbox-sms.adapter.ts).
 *
 * A browser end-to-end suite has to be able to read the one-time code the
 * application decided to send: it drives the real verification screen, and the
 * API deliberately never returns the code over HTTP. Scraping stdout would tie
 * the tests to a log format and race the process's own buffering, so the
 * transport itself is swapped for one that records what it sent.
 *
 * It exists only when NOTIFICATION_OUTBOX_DIR is set, and it refuses to exist
 * in production at all: writing live one-time codes to a file is exactly the
 * "credential in a log" problem the console adapter already refuses to create.
 * The check runs at import time, so a production process configured this way
 * fails to boot instead of running with a leaky transport.
 */
export function notificationOutboxDir(): string | null {
  const dir = process.env.NOTIFICATION_OUTBOX_DIR?.trim();
  if (!dir) {
    return null;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NOTIFICATION_OUTBOX_DIR is a test-only transport and must never be set in production: ' +
        'it writes one-time codes to disk.',
    );
  }

  return dir;
}

export function isNotificationOutboxEnabled(): boolean {
  return notificationOutboxDir() !== null;
}
