import { Injectable, Logger } from '@nestjs/common';
import { readOpsAlertConfig } from './ops-alert.config';

/**
 * OBS-ALERT-001 — Telegram, outbound only.
 *
 * One call and nothing else: `sendMessage` to the configured chat. No
 * webhook is registered and `getUpdates` is never called, so nothing a chat
 * member types reaches this application — the bot cannot be commanded.
 *
 * The bot token sits in the request path (Telegram's API has no other place
 * for it), so the URL is never logged, never put in an error, and a failure
 * is reduced to one closed code. The response body is read only for the
 * message id; nothing Telegram says back is kept or printed.
 */
export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/** Telegram's own limit on one message. */
export const TELEGRAM_MESSAGE_MAX = 4096;

export type TelegramSendResult = { providerMessageId: string | null };

export abstract class TelegramAlertPort {
  abstract send(text: string): Promise<TelegramSendResult>;
}

export type TelegramErrorCode = 'NOT_CONFIGURED' | 'TIMEOUT' | 'TRANSPORT_UNAVAILABLE' | 'REJECTED' | 'RATE_LIMITED';

/**
 * Carries a closed code and, when one came back, the HTTP status. `code`
 * mirrors the notification errors' shape, so the delivery worker classifies
 * both channels the same way.
 */
export class TelegramSendError extends Error {
  override name = 'TelegramSendError';
  constructor(
    readonly code: TelegramErrorCode,
    readonly httpStatus: number | null = null,
  ) {
    super(`Telegram send failed (${code})`);
  }
}

type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

@Injectable()
export class TelegramBotApiAdapter extends TelegramAlertPort {
  private readonly logger = new Logger('TelegramAlert');

  /** `baseUrl` and `fetchImpl` are test seams; production uses the defaults. */
  constructor(
    private readonly baseUrl: string = TELEGRAM_API_BASE_URL,
    private readonly fetchImpl: TelegramFetch = (url, init) => globalThis.fetch(url, init),
  ) {
    super();
  }

  async send(text: string): Promise<TelegramSendResult> {
    const telegram = readOpsAlertConfig().telegram;
    if (!telegram) throw new TelegramSendError('NOT_CONFIGURED');

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Plain text: no parse_mode, so nothing in a label can turn into
        // markup or a link, and no preview is fetched for the one link.
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text: text.slice(0, TELEGRAM_MESSAGE_MAX),
          disable_web_page_preview: true,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(telegram.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new TelegramSendError(timedOut ? 'TIMEOUT' : 'TRANSPORT_UNAVAILABLE');
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const code: TelegramErrorCode =
        response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT_UNAVAILABLE' : 'REJECTED';
      this.logger.warn(`Telegram refused an operations alert (${code}, HTTP ${response.status})`);
      throw new TelegramSendError(code, response.status);
    }

    return { providerMessageId: await readMessageId(response) };
  }
}

async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { result?: { message_id?: unknown } };
    const id = body?.result?.message_id;
    return typeof id === 'number' || typeof id === 'string' ? String(id).slice(0, 64) : null;
  } catch {
    return null;
  }
}
