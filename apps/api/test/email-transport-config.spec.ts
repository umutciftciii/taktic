import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertEmailTransportConfig,
  isDeliveringEmailTransportConfigured,
  resolveEmailTransportKind,
} from '../src/modules/notifications/email-transport';
import {
  DEFAULT_EMAIL_FROM,
  DEFAULT_RESEND_TIMEOUT_MS,
  readResendConfig,
} from '../src/modules/notifications/resend.config';
import { assertProviderClaimConfig } from '../src/modules/provider-claim/provider-claim.config';

/**
 * The boot-time configuration matrix.
 *
 * Nothing here performs a send: these are the checks that decide whether a
 * process is allowed to exist at all, and the whole point of running them at
 * boot is that a misconfigured deployment never reaches its first message.
 *
 * The key below is a syntactically valid placeholder that was never issued.
 */
const PLACEHOLDER_KEY = 're_TESTKEY_not_a_real_credential';

const MANAGED_KEYS = [
  'NODE_ENV',
  'EMAIL_TRANSPORT',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  'RESEND_TIMEOUT_MS',
  'NOTIFICATION_OUTBOX_DIR',
  'PROVIDER_CLAIM_ENABLED',
] as const;

let original: Record<string, string | undefined>;

beforeEach(() => {
  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));

  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }

  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function configureResend() {
  process.env.EMAIL_TRANSPORT = 'resend';
  process.env.RESEND_API_KEY = PLACEHOLDER_KEY;
  process.env.EMAIL_FROM = DEFAULT_EMAIL_FROM;
}

describe('EMAIL_TRANSPORT allow-list', () => {
  it('defaults to the console adapter, which delivers nothing', () => {
    expect(resolveEmailTransportKind()).toBe('console');
    expect(isDeliveringEmailTransportConfigured()).toBe(false);
  });

  it('keeps the recording transport as the default when the outbox dir is set', () => {
    process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/taktic-outbox';

    expect(resolveEmailTransportKind()).toBe('file-outbox');
    expect(isDeliveringEmailTransportConfigured()).toBe(false);
  });

  it('accepts each allowed value', () => {
    process.env.EMAIL_TRANSPORT = 'console';
    expect(resolveEmailTransportKind()).toBe('console');

    process.env.EMAIL_TRANSPORT = 'file-outbox';
    process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/taktic-outbox';
    expect(resolveEmailTransportKind()).toBe('file-outbox');

    delete process.env.NOTIFICATION_OUTBOX_DIR;
    configureResend();
    expect(resolveEmailTransportKind()).toBe('resend');
    expect(isDeliveringEmailTransportConfigured()).toBe(true);
  });

  it('refuses a value outside the allow-list without echoing it', () => {
    process.env.EMAIL_TRANSPORT = PLACEHOLDER_KEY;

    expect(() => resolveEmailTransportKind()).toThrow(/must be exactly one of/);

    try {
      resolveEmailTransportKind();
      expect.unreachable('an unknown transport must not be accepted');
    } catch (error) {
      expect((error as Error).message).not.toContain(PLACEHOLDER_KEY);
    }
  });

  it('refuses the two switches disagreeing', () => {
    process.env.EMAIL_TRANSPORT = 'file-outbox';
    expect(() => resolveEmailTransportKind()).toThrow(/NOTIFICATION_OUTBOX_DIR/);

    process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/taktic-outbox';
    process.env.EMAIL_TRANSPORT = 'console';
    expect(() => resolveEmailTransportKind()).toThrow(/Unset one of the two/);

    configureResend();
    expect(() => resolveEmailTransportKind()).toThrow(/Unset one of the two/);
  });
});

describe('production boot matrix', () => {
  it('refuses the console adapter', () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_TRANSPORT = 'console';

    expect(() => assertEmailTransportConfig()).toThrow(/requires an e-mail transport that actually delivers/);
  });

  it('refuses an unconfigured process, which is the console adapter by default', () => {
    process.env.NODE_ENV = 'production';

    expect(() => assertEmailTransportConfig()).toThrow(/requires an e-mail transport that actually delivers/);
  });

  it('refuses the recording outbox transport', () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_TRANSPORT = 'file-outbox';
    process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/taktic-outbox';

    // The outbox switch refuses to exist in production before the transport
    // question is even asked.
    expect(() => assertEmailTransportConfig()).toThrow(/test-only transport/i);
  });

  it('accepts a fully configured Resend transport', () => {
    process.env.NODE_ENV = 'production';
    configureResend();

    expect(() => assertEmailTransportConfig()).not.toThrow();
    expect(isDeliveringEmailTransportConfigured()).toBe(true);
  });

  it('lets PROVIDER_CLAIM_ENABLED be turned on once Resend is configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.PROVIDER_CLAIM_ENABLED = 'true';

    expect(() => assertProviderClaimConfig()).toThrow(/e-mail transport/i);

    configureResend();
    expect(() => assertProviderClaimConfig()).not.toThrow();
  });
});

describe('Resend credentials', () => {
  it('is required only when the transport is Resend', () => {
    process.env.EMAIL_TRANSPORT = 'console';
    expect(() => assertEmailTransportConfig()).not.toThrow();

    process.env.EMAIL_TRANSPORT = 'resend';
    expect(() => assertEmailTransportConfig()).toThrow(/RESEND_API_KEY is required/);
  });

  it('refuses a key that does not have the documented shape, without echoing it', () => {
    process.env.EMAIL_TRANSPORT = 'resend';
    process.env.RESEND_API_KEY = 'paste-your-key-here';

    try {
      readResendConfig();
      expect.unreachable('a malformed key must not be accepted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/shape of a Resend API key/);
      expect(message).not.toContain('paste-your-key-here');
    }
  });

  it('defaults the sender outside production and pins it inside', () => {
    configureResend();
    delete process.env.EMAIL_FROM;

    expect(readResendConfig().from).toBe(DEFAULT_EMAIL_FROM);
    expect(readResendConfig().timeoutMs).toBe(DEFAULT_RESEND_TIMEOUT_MS);

    process.env.NODE_ENV = 'production';
    expect(() => readResendConfig()).toThrow(/EMAIL_FROM is required in production/);
  });

  it('refuses a sender outside the verified domain', () => {
    configureResend();

    process.env.EMAIL_FROM = 'Taktick <noreply@taktick.com.tr>';
    expect(() => readResendConfig()).toThrow(/verified Resend domain notify\.taktick\.com\.tr/);

    process.env.EMAIL_FROM = 'noreply@notify.taktick.com.tr.evil.example';
    expect(() => readResendConfig()).toThrow(/verified Resend domain/);

    process.env.EMAIL_FROM = 'Taktick';
    expect(() => readResendConfig()).toThrow(/must be an e-mail address/);
  });

  it('accepts the shipped sender and its bare form', () => {
    configureResend();

    expect(readResendConfig().from).toBe(DEFAULT_EMAIL_FROM);

    process.env.EMAIL_FROM = 'noreply@notify.taktick.com.tr';
    expect(readResendConfig().from).toBe('noreply@notify.taktick.com.tr');
  });

  it('refuses another mailbox on the verified domain in production', () => {
    configureResend();
    process.env.EMAIL_FROM = 'Taktick <destek@notify.taktick.com.tr>';

    expect(readResendConfig().from).toBe('Taktick <destek@notify.taktick.com.tr>');

    process.env.NODE_ENV = 'production';
    expect(() => readResendConfig()).toThrow(/must send as noreply@notify\.taktick\.com\.tr/);
  });

  it('bounds the send timeout', () => {
    configureResend();

    process.env.RESEND_TIMEOUT_MS = '2500';
    expect(readResendConfig().timeoutMs).toBe(2500);

    for (const invalid of ['0', '999', '60001', 'soon', '1500.5']) {
      process.env.RESEND_TIMEOUT_MS = invalid;
      expect(() => readResendConfig()).toThrow(/RESEND_TIMEOUT_MS/);
    }
  });
});
