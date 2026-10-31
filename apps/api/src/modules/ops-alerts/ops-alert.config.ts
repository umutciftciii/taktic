import { Logger } from '@nestjs/common';
import { parseAppEnvironment } from '../../common/app-environment';
import { isWellFormedEmail } from '../company-settings/company-settings.rules';

/**
 * OBS-ALERT-001 — where operations alerts go.
 *
 * Two independent channels, each configured or not:
 *
 *   OPS_ALERT_EMAIL                     every notice, in full
 *   OPS_ALERT_TELEGRAM_BOT_TOKEN  ┐     critical notices and their recovery
 *   OPS_ALERT_TELEGRAM_CHAT_ID    ┘     — both or neither
 *
 * The rules a boot enforces ({@link assertOpsAlertConfig}): a malformed
 * value, or half of the Telegram pair, stops the process; APP_ENVIRONMENT=
 * production with neither channel stops it too, because a production that
 * cannot tell anyone it is failing is the failure this feature exists for.
 * Staging and local may run without a channel — the evaluator still records
 * alerts, and the system health screen says no channel is configured.
 *
 * No value is ever echoed: the bot token is a credential, the chat id and the
 * mailbox are where alerts land, and every message here names the variable
 * and nothing else. The token is read on each send and never held in a field
 * a serialiser could reach.
 */

export const OPS_ALERT_ENV = {
  email: 'OPS_ALERT_EMAIL',
  telegramBotToken: 'OPS_ALERT_TELEGRAM_BOT_TOKEN',
  telegramChatId: 'OPS_ALERT_TELEGRAM_CHAT_ID',
  telegramTimeoutMs: 'OPS_ALERT_TELEGRAM_TIMEOUT_MS',
} as const;

export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;
const MAX_TELEGRAM_TIMEOUT_MS = 30_000;

/** Telegram's own shape: "<bot id>:<secret>". */
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
/** A numeric chat (negative for groups and channels) or a public @channel. */
const TELEGRAM_CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export type TelegramChannelConfig = { botToken: string; chatId: string; timeoutMs: number };

export type OpsAlertConfig = {
  email: string | null;
  telegram: TelegramChannelConfig | null;
};

/** What the health screen may know about the channels: whether, never what. */
export type OpsAlertChannelStatus = { email: boolean; telegram: boolean };

export class OpsAlertConfigError extends Error {
  override name = 'OpsAlertConfigError';
}

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** Throws on anything unusable; the message names the variable only. */
export function readOpsAlertConfig(env: NodeJS.ProcessEnv = process.env): OpsAlertConfig {
  const rawEmail = read(env, OPS_ALERT_ENV.email);
  const email = rawEmail === null ? null : rawEmail.toLowerCase();
  if (email !== null && !isWellFormedEmail(email)) {
    throw new OpsAlertConfigError(`${OPS_ALERT_ENV.email} is not a plain e-mail address.`);
  }

  const botToken = read(env, OPS_ALERT_ENV.telegramBotToken);
  const chatId = read(env, OPS_ALERT_ENV.telegramChatId);
  if ((botToken === null) !== (chatId === null)) {
    throw new OpsAlertConfigError(
      `${OPS_ALERT_ENV.telegramBotToken} and ${OPS_ALERT_ENV.telegramChatId} are set together or not at all.`,
    );
  }
  if (botToken !== null && !TELEGRAM_TOKEN_PATTERN.test(botToken)) {
    throw new OpsAlertConfigError(`${OPS_ALERT_ENV.telegramBotToken} is not a Telegram bot token.`);
  }
  if (chatId !== null && !TELEGRAM_CHAT_ID_PATTERN.test(chatId)) {
    throw new OpsAlertConfigError(`${OPS_ALERT_ENV.telegramChatId} is not a Telegram chat id.`);
  }

  const rawTimeout = read(env, OPS_ALERT_ENV.telegramTimeoutMs);
  let timeoutMs = DEFAULT_TELEGRAM_TIMEOUT_MS;
  if (rawTimeout !== null) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_TELEGRAM_TIMEOUT_MS) {
      throw new OpsAlertConfigError(
        `${OPS_ALERT_ENV.telegramTimeoutMs} must be a whole number of milliseconds between 1000 and ${MAX_TELEGRAM_TIMEOUT_MS}.`,
      );
    }
    timeoutMs = parsed;
  }

  return {
    email,
    telegram: botToken !== null && chatId !== null ? { botToken, chatId, timeoutMs } : null,
  };
}

/**
 * The channel switch as the evaluator and the health screen read it: a
 * configuration the boot would refuse reads as "no channel" rather than
 * throwing in the middle of a tick.
 */
export function readOpsAlertConfigSafely(env: NodeJS.ProcessEnv = process.env): OpsAlertConfig {
  try {
    return readOpsAlertConfig(env);
  } catch {
    return { email: null, telegram: null };
  }
}

export function opsAlertChannelStatus(env: NodeJS.ProcessEnv = process.env): OpsAlertChannelStatus {
  const config = readOpsAlertConfigSafely(env);
  return { email: config.email !== null, telegram: config.telegram !== null };
}

const logger = new Logger('OpsAlertConfig');

/** The boot check (boot-config.ts). */
export function assertOpsAlertConfig(env: NodeJS.ProcessEnv = process.env): void {
  const config = readOpsAlertConfig(env);
  if (config.email !== null || config.telegram !== null) return;

  const environment = parseAppEnvironment(env.APP_ENVIRONMENT);
  if (environment === 'production') {
    throw new OpsAlertConfigError(
      `APP_ENVIRONMENT=production requires an operations alert channel: set ${OPS_ALERT_ENV.email}, ` +
        `or ${OPS_ALERT_ENV.telegramBotToken} and ${OPS_ALERT_ENV.telegramChatId}.`,
    );
  }
  if (environment === 'staging') {
    logger.warn(
      `No operations alert channel is configured (${OPS_ALERT_ENV.email}, ${OPS_ALERT_ENV.telegramBotToken}/` +
        `${OPS_ALERT_ENV.telegramChatId}); alerts are recorded but sent nowhere.`,
    );
  }
}
