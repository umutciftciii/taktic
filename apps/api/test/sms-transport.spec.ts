import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSmsAdapter, SmsTransportUnavailableError } from '../src/modules/notifications/console-sms.adapter';
import { NotificationDispatcher } from '../src/modules/notifications/notification-dispatcher.service';
import { NotificationPort } from '../src/modules/notifications/notification.port';
import {
  assertSmsTransportConfig,
  isConsoleSmsPermitted,
  resolveSmsTransportKind,
} from '../src/modules/notifications/sms-transport';
import { SmsMessage } from '../src/modules/notifications/sms.port';

/**
 * The SMS stand-in contract (sms-transport.ts): staging runs the immutable
 * production build (NODE_ENV=production) without an SMS provider, so its
 * console adapter prints the one-time code to the API log — and production
 * never does. No database: the dispatcher's audit rows go to an in-memory
 * stand-in, which is also how these cases prove the code is never stored.
 */
const MANAGED_KEYS = ['NODE_ENV', 'APP_ENVIRONMENT', 'NOTIFICATION_OUTBOX_DIR'] as const;
const CODE = '482913';
const PHONE = '+905551112233';

const message: SmsMessage = {
  template: 'phone-verification-code',
  to: PHONE,
  code: CODE,
  expiresInMinutes: 5,
};

let original: Record<string, string | undefined>;
let logged: string[];

beforeEach(() => {
  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_KEYS) delete process.env[key];

  // Everything any Nest logger writes during a case, whatever the level.
  logged = [];
  for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function deploy(appEnvironment: string | undefined, nodeEnv: string) {
  if (appEnvironment === undefined) delete process.env.APP_ENVIRONMENT;
  else process.env.APP_ENVIRONMENT = appEnvironment;
  process.env.NODE_ENV = nodeEnv;
}

describe('where the console SMS adapter may print a code', () => {
  it.each([
    ['staging', 'production', true],
    ['staging', 'development', true],
    ['production', 'production', false],
    ['production', 'development', false],
    ['local', 'development', true],
    ['local', 'production', false],
    [undefined, 'development', true],
    [undefined, 'test', true],
    [undefined, 'production', false],
  ] as const)('APP_ENVIRONMENT=%s, NODE_ENV=%s → %s', (appEnvironment, nodeEnv, permitted) => {
    deploy(appEnvironment, nodeEnv);
    expect(isConsoleSmsPermitted()).toBe(permitted);
  });

  it('refuses an APP_ENVIRONMENT outside the three, at boot', () => {
    deploy('prod', 'production');
    expect(() => assertSmsTransportConfig()).toThrow(/APP_ENVIRONMENT must be one of/);
  });
});

describe('ConsoleSmsAdapter', () => {
  it('on staging under the production build: prints the code to the API log and reports it sent', async () => {
    deploy('staging', 'production');

    await expect(new ConsoleSmsAdapter().send(message)).resolves.toEqual({ providerMessageId: null });
    expect(logged.join('\n')).toContain(CODE);
  });

  it('on production: refuses, and writes neither the code nor the number anywhere', async () => {
    deploy('production', 'production');

    await expect(new ConsoleSmsAdapter().send(message)).rejects.toBeInstanceOf(SmsTransportUnavailableError);
    const text = logged.join('\n');
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(PHONE);
    expect(text).toMatch(/not delivered/);
  });

  it('keeps a local stack as it was: prints in development, refuses under NODE_ENV=production', async () => {
    deploy('local', 'development');
    await expect(new ConsoleSmsAdapter().send(message)).resolves.toBeDefined();
    expect(logged.join('\n')).toContain(CODE);

    logged.length = 0;
    deploy(undefined, 'production');
    await expect(new ConsoleSmsAdapter().send(message)).rejects.toBeInstanceOf(SmsTransportUnavailableError);
    expect(logged.join('\n')).not.toContain(CODE);
  });
});

describe('the recorder transport', () => {
  it('is never selectable under NODE_ENV=production, staging included', () => {
    deploy('staging', 'production');
    process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/outbox';

    expect(() => resolveSmsTransportKind()).toThrow(/test-only transport/);
    expect(() => assertSmsTransportConfig()).toThrow(/test-only transport/);
  });

  it('selects the console adapter everywhere else it is not configured', () => {
    deploy('staging', 'production');
    expect(resolveSmsTransportKind()).toBe('console');
    expect(() => assertSmsTransportConfig()).not.toThrow();
  });
});

/**
 * The phone-verification dispatch path with the real console adapter: the
 * services call NotificationDispatcher.sendSms and return its outcome status,
 * never the code. The audit row is the only thing written, and it holds the
 * masked number and no code.
 */
describe('phone-verification dispatch through the console adapter', () => {
  function dispatcher() {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      notificationLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push({ ...data });
          return { id: 'log-1' };
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(rows[0] ?? {}, data);
          return {};
        }),
      },
    };
    const email = { send: vi.fn() } as unknown as NotificationPort;
    const service = new NotificationDispatcher(prisma as never, email, new ConsoleSmsAdapter());
    return { service, rows };
  }

  it('staging + NODE_ENV=production: SENT, code only in the API log, never in the audit row or the outcome', async () => {
    deploy('staging', 'production');
    const { service, rows } = dispatcher();

    const outcome = await service.sendSms(message, { userId: 'user-1' });

    expect(outcome).toEqual({ logId: 'log-1', status: 'SENT', errorCode: null });
    expect(JSON.stringify(outcome)).not.toContain(CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'SMS', template: 'phone-verification-code', status: 'SENT' });
    expect(JSON.stringify(rows)).not.toContain(CODE);
    expect(JSON.stringify(rows)).not.toContain(PHONE);
    expect(logged.join('\n')).toContain(CODE);
  });

  it('production: FAILED as TRANSPORT_UNAVAILABLE, and the code appears nowhere', async () => {
    deploy('production', 'production');
    const { service, rows } = dispatcher();

    const outcome = await service.sendSms(message, { userId: 'user-1' });

    expect(outcome).toEqual({ logId: 'log-1', status: 'FAILED', errorCode: 'TRANSPORT_UNAVAILABLE' });
    expect(rows[0]).toMatchObject({ status: 'FAILED', errorCode: 'TRANSPORT_UNAVAILABLE' });
    expect(JSON.stringify(rows)).not.toContain(CODE);
    expect(logged.join('\n')).not.toContain(CODE);
    expect(logged.join('\n')).not.toContain(PHONE);
  });
});
