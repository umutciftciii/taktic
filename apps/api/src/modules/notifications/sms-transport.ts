import { isSandboxIntegrationPermitted, parseAppEnvironment } from '../../common/app-environment';
import { notificationOutboxDir } from './notification-outbox';

/**
 * Which SMS transport this process is wired to, and where each may run.
 *
 * The build has no SMS provider. There are two stand-ins, and neither delivers
 * a message to a phone:
 *
 *   file-outbox  NOTIFICATION_OUTBOX_DIR is set: the browser suite's recorder.
 *                Refused at boot under NODE_ENV=production
 *                (notification-outbox.ts), so never on a deployed host.
 *   console      Everything else. The one-time code is written to the API
 *                process's own log — on a deployed host, `docker logs
 *                taktic-api`, readable only by whoever operates the host — and
 *                to nowhere else: not to a response, not to the database, not
 *                to an endpoint.
 *
 * Where the console adapter may print a code is the shared sandbox rule
 * ({@link isSandboxIntegrationPermitted}), the same one that decides the Lemon
 * Squeezy sandbox:
 *
 *   APP_ENVIRONMENT=production   never. The adapter refuses every send, logs
 *                                no code, and the attempt is audited as
 *                                TRANSPORT_UNAVAILABLE. A code in a production
 *                                log is a credential in a log.
 *   APP_ENVIRONMENT=staging      yes, under NODE_ENV=production too: staging
 *                                runs the immutable production images and has
 *                                no SMS provider by decision, so its testers
 *                                read codes from the API log.
 *   local, or not declared       only outside NODE_ENV=production, exactly as
 *                                before.
 */
export type SmsTransportKind = 'console' | 'file-outbox';

export function resolveSmsTransportKind(): SmsTransportKind {
  // Throws under NODE_ENV=production when the recorder is configured.
  return notificationOutboxDir() !== null ? 'file-outbox' : 'console';
}

/** Whether the console adapter may print a one-time code in this process. */
export function isConsoleSmsPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSandboxIntegrationPermitted(env);
}

/**
 * Called once at boot. Refuses what cannot be right — a recorder in
 * production, an APP_ENVIRONMENT that is none of the three — and nothing else.
 *
 * A production deployment on the console adapter still boots: SMS is one
 * channel of a marketplace that otherwise works, and the adapter's refusal
 * (audited, code never logged) is what keeps it closed. The deploy preflight's
 * runtime contract says so in a warning (scripts/ops/runtime-contract.mjs).
 */
export function assertSmsTransportConfig(): void {
  parseAppEnvironment(process.env.APP_ENVIRONMENT);
  resolveSmsTransportKind();
}
