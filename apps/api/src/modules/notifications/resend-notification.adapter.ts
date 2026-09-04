import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isPublicUrlDeliverable, publicUrlIssues } from '../../common/public-urls';
import { EmailBrandingService } from './email-branding.service';
import { renderEmail } from './email-template';
import { maskEmail } from './mask';
import { NotificationErrorCode } from './notification-errors';
import {
  NotificationMessage,
  NotificationPort,
  NotificationSendResult,
} from './notification.port';
import { RESEND_EMAILS_ENDPOINT, readResendConfig } from './resend.config';

/** The slice of `fetch` this adapter uses. Kept narrow so a test can stand in. */
export type ResendFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<ResendResponse>;

export type ResendResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

/** Injection token for the fetch implementation; unbound in the real graph. */
export const RESEND_FETCH = Symbol('RESEND_FETCH');

/**
 * The delivering e-mail transport: a typed HTTP client for Resend's
 * `POST /emails`.
 *
 * Written against `fetch` rather than the official SDK on purpose. This
 * repository carries no HTTP client and no provider SDK; one endpoint, one JSON
 * body and one header is not enough surface to justify a dependency that would
 * bring its own retry, logging and error-shape opinions into a path whose whole
 * design is about what must *not* be logged.
 *
 * What this adapter refuses to do is as much of its contract as what it does:
 *
 * - The API key exists in one place, the Authorization header. It is never
 *   logged, never put in an error and never returned.
 * - A failed response's body is never read. Providers echo the destination
 *   address, the subject and sometimes the payload back in validation errors,
 *   and this adapter's errors travel to NotificationLog. Only the HTTP status
 *   is used, and only to pick one of the closed error classes.
 * - The recipient appears in a log line only masked, and the rendered bodies —
 *   which contain the single-use action URL — are never logged at all.
 *
 * Open and click tracking are off for this domain in Resend, and nothing here
 * asks for them: no tracking fields are sent and the action link is a plain
 * anchor to the application's own URL, so a security link is never rewritten
 * through a redirector.
 */
@Injectable()
export class ResendNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('ResendNotification');
  private readonly fetchImpl: ResendFetch;

  constructor(
    @Inject(EmailBrandingService) private readonly branding: EmailBrandingService,
    @Optional() @Inject(RESEND_FETCH) fetchImpl?: ResendFetch,
  ) {
    super();
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => globalThis.fetch(input, init) as unknown as Promise<ResendResponse>);
  }

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    // Read per send, like every other configuration switch in this module, so a
    // rotated key takes effect without a redeploy of the process's assumptions.
    const config = readResendConfig();

    // Two refusals, in the order the defects nest: a message whose links cannot
    // be opened is unusable whatever the footer says.
    this.requireUsablePublicUrls(message);
    const rendered = renderEmail(message, await this.resolveBranding(message.template));

    const response = await this.post(
      config.apiKey,
      config.timeoutMs,
      {
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: rendered.text,
        html: rendered.html,
        // Omitted rather than sent empty when the message names none: the field
        // is absent from every payload but the support-ticket family, and a
        // present-but-empty header is a header a provider may still act on.
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      },
      message.idempotencyKey,
    );

    if (!response.ok) {
      throw new ResendSendError(classifyStatus(response.status), response.status);
    }

    const providerMessageId = await readMessageId(response);

    this.logger.log(`[${message.template}] accepted by resend for ${maskEmail(message.to)}`);

    return { providerMessageId };
  }

  /**
   * Refuses a message whose links a recipient could not open.
   *
   * Every template embeds the logo, and most carry a call to action as well, so
   * a deployment whose public address cannot be put in front of a recipient has
   * nothing it can render honestly. The check used to exempt the one link-free
   * legacy message; that message prints the logo now like every other, so the
   * exemption is gone with it.
   *
   * The log line names the variable and the class of defect and stops there —
   * no recipient, no token, no URL. A base URL is not a credential, but this
   * line sits next to a masked recipient in the same stream, and a value that
   * turned out to be a pasted secret must not be the thing that writes it down.
   */
  private requireUsablePublicUrls(message: NotificationMessage): void {
    if (isPublicUrlDeliverable()) {
      return;
    }

    const issues = publicUrlIssues();
    this.logger.error(
      `[${message.template}] not sent: this deployment's public address cannot be used in a ` +
        `message (${issues.map(({ source, issue }) => `${source}=${issue}`).join(', ')}). ` +
        'Set WEB_APP_URL to the https origin the application is served from.',
    );

    throw new EmailPublicUrlInvalidError(issues.map(({ issue }) => issue));
  }

  /**
   * The footer, or a refusal.
   *
   * This is the last point at which a half-filled message can still be stopped.
   * Every template prints the company footer, so an unpublishable settings row
   * ends the send here — before the request body is built, before anything
   * reaches Resend, and therefore before anybody can receive an e-mail telling
   * them to write to a placeholder.
   *
   * The three formerly-plain templates are gated by this too now. They used to
   * be exempt because they printed no company details and gating them would
   * have taken a mailbox-ownership flow offline over a value they never showed;
   * they show it today, so the exemption no longer describes anything true.
   *
   * The thrown error carries only the class and the named issues. Those are a
   * closed vocabulary about this deployment's own configuration — no address,
   * no company value, nothing a recipient supplied — so they are safe to record
   * on the audit row the dispatcher is about to mark FAILED.
   */
  private async resolveBranding(template: NotificationMessage['template']) {
    const resolution = await this.branding.resolve();
    if (!resolution.complete) {
      this.logger.error(
        `[${template}] not sent: company e-mail settings are incomplete (${resolution.issues.join(', ')}). ` +
          'Set them in the admin panel under Şirket ve E-posta Ayarları.',
      );
      throw new EmailBrandingIncompleteError(resolution.issues);
    }

    return resolution.branding;
  }

  /**
   * `idempotencyKey` travels as Resend's `Idempotency-Key` header. Resend
   * answers a repeat of the same key with the original response rather than
   * sending again, which is what makes a retry of a timed-out send safe: the
   * one case where "it failed" and "it was delivered" are indistinguishable
   * locally is resolved by the provider, not guessed at here.
   *
   * The header is a plain opaque id (see NotificationMessage.idempotencyKey).
   * It is omitted rather than invented when the caller has none.
   */
  private async post(
    apiKey: string,
    timeoutMs: number,
    body: ResendEmailRequest,
    idempotencyKey?: string,
  ): Promise<ResendResponse> {
    try {
      return await this.fetchImpl(RESEND_EMAILS_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        // A hung socket must not hold a scheduler run or the HTTP request that
        // triggered the send.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ResendSendError(classifyTransportFailure(error));
    }
  }
}

type ResendEmailRequest = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** Resend's own spelling. Present only for messages that expect an answer. */
  reply_to?: string;
};

/**
 * Carries a failure class and, when there was one, the HTTP status. Deliberately
 * nothing else: no recipient, no body, no key. {@link classifyNotificationError}
 * reads `errorCode` off it and the dispatcher stores only that.
 */
/**
 * Raised instead of sending, when this deployment's public address cannot be
 * put in front of a recipient.
 *
 * Deliberately a different class and a different code from the branding
 * refusal: one is fixed in the admin panel, the other in the environment, and
 * an operator reading NotificationLog should not have to guess which.
 */
export class EmailPublicUrlInvalidError extends Error {
  readonly errorCode: NotificationErrorCode = 'EMAIL_PUBLIC_URL_INVALID';

  constructor(readonly issues: readonly string[]) {
    super('The public base URL cannot be used in a delivered message; nothing was sent.');
    this.name = 'EmailPublicUrlInvalidError';
  }
}

/**
 * Raised instead of sending, when the company footer cannot be filled in.
 *
 * `errorCode` is what NotificationLog records, so the audit row names the cause
 * an operator can actually fix rather than a generic UNKNOWN. `issues` is the
 * same closed vocabulary the admin screen shows, kept on the error for the log
 * line — it is never returned over HTTP and never reaches a recipient.
 */
export class EmailBrandingIncompleteError extends Error {
  readonly errorCode: NotificationErrorCode = 'EMAIL_BRANDING_INCOMPLETE';

  constructor(readonly issues: readonly string[]) {
    super('Company e-mail settings are incomplete; nothing was sent.');
    this.name = 'EmailBrandingIncompleteError';
  }
}

export class ResendSendError extends Error {
  readonly errorCode: NotificationErrorCode;
  readonly status: number | null;

  constructor(errorCode: NotificationErrorCode, status: number | null = null) {
    super(status === null ? `Resend send failed (${errorCode})` : `Resend send failed (HTTP ${status})`);
    this.errorCode = errorCode;
    this.status = status;
    this.name = 'ResendSendError';
  }
}

/**
 * Maps a response status onto the closed set of failure classes.
 *
 * The mapping is coarse on purpose: it separates "this deployment is
 * misconfigured or the provider is down" from "this particular address will
 * never work", because that is the only distinction an operator reading
 * NotificationLog can act on.
 */
function classifyStatus(status: number): NotificationErrorCode {
  if (status === 408 || status === 504) {
    return 'TIMEOUT';
  }

  // 401/403 is a bad or revoked key, 429 is the account's own rate limit, 5xx
  // is the provider. All three mean "try again once somebody fixes something",
  // which is what TRANSPORT_UNAVAILABLE tells the operator.
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return 'TRANSPORT_UNAVAILABLE';
  }

  // Resend answers 422 for a payload it validated and refused, and the only
  // caller-supplied field that can be invalid here is the address.
  if (status === 422) {
    return 'INVALID_RECIPIENT';
  }

  if (status >= 400) {
    return 'REJECTED';
  }

  return 'UNKNOWN';
}

function classifyTransportFailure(error: unknown): NotificationErrorCode {
  const name = (error as { name?: unknown } | null)?.name;

  // AbortSignal.timeout aborts with a TimeoutError; an explicit abort would be
  // an AbortError. Both mean the send ran out of time.
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'TIMEOUT';
  }

  // DNS failure, refused connection, TLS problem. Nothing about the message.
  return 'TRANSPORT_UNAVAILABLE';
}

/**
 * Reads the provider's identifier for the accepted message.
 *
 * A success body that is missing, malformed or shaped unexpectedly is not a
 * failure — the mail was accepted — so the send stays SENT with no id rather
 * than being reported as unsent. Anything that is not a plain opaque identifier
 * is dropped: the id is stored and later shown to an operator, and a provider
 * that echoed the address back must not be able to put it there.
 */
async function readMessageId(response: ResendResponse): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') {
    return null;
  }

  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : null;
}
