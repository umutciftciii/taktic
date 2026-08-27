import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailBrandingService } from '../src/modules/notifications/email-branding.service';
import { classifyNotificationError } from '../src/modules/notifications/notification-errors';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import {
  ResendFetch,
  ResendNotificationAdapter,
  ResendResponse,
} from '../src/modules/notifications/resend-notification.adapter';
import { RESEND_EMAILS_ENDPOINT } from '../src/modules/notifications/resend.config';

/**
 * The Resend adapter, against a stand-in for `fetch`.
 *
 * No test in this file may reach the network: the adapter is constructed with a
 * fake transport in every case, and the key below is a syntactically valid
 * placeholder that was never issued.
 */
const TEST_API_KEY = 're_TESTKEY_not_a_real_credential';
const RECIPIENT = 'applicant@example.com';
const ACTION_URL = 'https://taktick.example/claim-provider?token=single-use-secret';

const CLAIM_MESSAGE: NotificationMessage = {
  template: 'provider-claim',
  to: RECIPIENT,
  subject: 'TakTic hizmet veren başvurunuzu hesabınıza bağlayın',
  actionUrl: ACTION_URL,
  data: {
    businessName: 'Örnek <Yapı> & Tesisat',
    expiresAt: '2026-09-01T09:00:00.000Z',
  },
};

type Call = { input: string; init: Parameters<ResendFetch>[1] };

/**
 * A branding resolver that always answers "complete".
 *
 * Every message in this file is `provider-claim`, one of the three legacy
 * templates that print no company footer, so the adapter never consults it —
 * the stub exists so the constructor can be satisfied without a database. The
 * cases that *do* exercise the branding gate live in
 * email-branding-settings.spec.ts, against real settings rows.
 */
const brandingStub = {
  resolve: async () => ({
    complete: true as const,
    branding: {
      supportEmail: 'destek@ornek-sirket.example',
      companyName: 'Örnek Şirket A.Ş.',
      companyAddress: null,
      logoUrl: 'https://app.example.test/brand/logo-email.png',
    },
  }),
} as unknown as EmailBrandingService;

function adapter(fetchImpl: ResendFetch) {
  return new ResendNotificationAdapter(brandingStub, fetchImpl);
}

function recordingFetch(respond: () => ResendResponse | Promise<ResendResponse>) {
  const calls: Call[] = [];
  const fetchImpl: ResendFetch = async (input, init) => {
    calls.push({ input, init });
    return respond();
  };

  return { calls, fetchImpl };
}

/** The single request the adapter made, under the index checks tsconfig asks for. */
function onlyCall(calls: Call[]): Call {
  const [call] = calls;
  if (!call) {
    throw new Error('the adapter made no request');
  }

  return call;
}

function jsonResponse(status: number, body: unknown): ResendResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** What a provider would answer for a rejected send: it echoes the address. */
function leakyErrorResponse(status: number): ResendResponse {
  return {
    ok: false,
    status,
    json: async () => ({
      name: 'validation_error',
      message: `Invalid \`to\` field: ${RECIPIENT} is not a valid address`,
    }),
  };
}

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    RESEND_TIMEOUT_MS: process.env.RESEND_TIMEOUT_MS,
  };

  process.env.RESEND_API_KEY = TEST_API_KEY;
  process.env.EMAIL_FROM = 'Taktick <noreply@notify.taktick.com.tr>';
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('ResendNotificationAdapter', () => {
  it('posts one transactional message and reports the provider id', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' }),
    );

    const result = await adapter(fetchImpl).send(CLAIM_MESSAGE);

    expect(result.providerMessageId).toBe('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    expect(calls).toHaveLength(1);

    const call = onlyCall(calls);
    expect(call.input).toBe(RESEND_EMAILS_ENDPOINT);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);

    const body = JSON.parse(call.init.body) as Record<string, unknown>;
    expect(body.from).toBe('Taktick <noreply@notify.taktick.com.tr>');
    expect(body.to).toEqual([RECIPIENT]);
    expect(body.subject).toBe(CLAIM_MESSAGE.subject);
    // Both bodies, so a text-only client is not shown a degraded message, and
    // the link is the application's own URL rather than a tracking redirect.
    expect(String(body.text)).toContain(ACTION_URL);
    expect(String(body.html)).toContain(ACTION_URL);
  });

  it('escapes applicant-supplied values in the HTML body', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await adapter(fetchImpl).send(CLAIM_MESSAGE);

    const body = JSON.parse(onlyCall(calls).init.body) as { html: string };
    expect(body.html).toContain('Örnek &lt;Yapı&gt; &amp; Tesisat');
    expect(body.html).not.toContain('<Yapı>');
  });

  it('asks for no open or click tracking', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { id: 'msg_1' }));

    await adapter(fetchImpl).send(CLAIM_MESSAGE);

    const body = JSON.parse(onlyCall(calls).init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
  });

  it('keeps the send SENT when the success body carries no usable id', async () => {
    for (const payload of [{}, { id: 42 }, { id: `${RECIPIENT} queued` }]) {
      const { fetchImpl } = recordingFetch(() => jsonResponse(200, payload));
      const result = await adapter(fetchImpl).send(CLAIM_MESSAGE);

      expect(result.providerMessageId).toBeNull();
    }

    const unparsable: ResendResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    };

    const { fetchImpl } = recordingFetch(() => unparsable);
    await expect(adapter(fetchImpl).send(CLAIM_MESSAGE)).resolves.toEqual({
      providerMessageId: null,
    });
  });

  describe('failure classification', () => {
    const cases: Array<{ status: number; expected: string }> = [
      { status: 400, expected: 'REJECTED' },
      { status: 401, expected: 'TRANSPORT_UNAVAILABLE' },
      { status: 403, expected: 'TRANSPORT_UNAVAILABLE' },
      { status: 404, expected: 'REJECTED' },
      { status: 408, expected: 'TIMEOUT' },
      { status: 422, expected: 'INVALID_RECIPIENT' },
      { status: 429, expected: 'TRANSPORT_UNAVAILABLE' },
      { status: 500, expected: 'TRANSPORT_UNAVAILABLE' },
      { status: 503, expected: 'TRANSPORT_UNAVAILABLE' },
    ];

    for (const { status, expected } of cases) {
      it(`maps HTTP ${status} to ${expected}`, async () => {
        const { fetchImpl } = recordingFetch(() => leakyErrorResponse(status));

        const error = await adapter(fetchImpl)
          .send(CLAIM_MESSAGE)
          .then(
            () => null,
            (thrown: unknown) => thrown,
          );

        expect(error).toBeInstanceOf(Error);
        expect(classifyNotificationError(error)).toBe(expected);
      });
    }

    it('maps an aborted request to TIMEOUT', async () => {
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });

      const { fetchImpl } = recordingFetch(() => {
        throw timeout;
      });

      const error = await adapter(fetchImpl)
        .send(CLAIM_MESSAGE)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(classifyNotificationError(error)).toBe('TIMEOUT');
    });

    it('maps a network failure to TRANSPORT_UNAVAILABLE', async () => {
      const { fetchImpl } = recordingFetch(() => {
        throw new TypeError('fetch failed');
      });

      const error = await adapter(fetchImpl)
        .send(CLAIM_MESSAGE)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(classifyNotificationError(error)).toBe('TRANSPORT_UNAVAILABLE');
    });

    it('passes a timeout signal to the transport', async () => {
      process.env.RESEND_TIMEOUT_MS = '1500';
      const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { id: 'msg_1' }));

      await adapter(fetchImpl).send(CLAIM_MESSAGE);

      const { signal } = onlyCall(calls).init;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });
  });

  /**
   * The adapter's errors reach NotificationLog and the admin API. Anything that
   * travels with them is, in effect, stored — so nothing may.
   */
  describe('failure carries no secrets', () => {
    it('leaks neither the key, the recipient, the body nor the provider text', async () => {
      const { fetchImpl } = recordingFetch(() => leakyErrorResponse(422));

      const error = (await adapter(fetchImpl)
        .send(CLAIM_MESSAGE)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        )) as Error;

      const serialised = `${error.name} ${error.message} ${error.stack ?? ''} ${JSON.stringify(
        error,
        Object.getOwnPropertyNames(error),
      )}`;

      for (const secret of [
        TEST_API_KEY,
        RECIPIENT,
        ACTION_URL,
        'single-use-secret',
        'is not a valid address',
        'validation_error',
        CLAIM_MESSAGE.subject,
      ]) {
        expect(serialised).not.toContain(secret);
      }

      // The status is the one provider-side detail that is kept, because it is
      // what an operator needs and it says nothing about the message.
      expect(error.message).toContain('422');
    });

    it('never reads the body of a failed response', async () => {
      let bodyReads = 0;
      const { fetchImpl } = recordingFetch(() => ({
        ok: false,
        status: 500,
        json: async () => {
          bodyReads += 1;
          return { message: `Internal error for ${RECIPIENT}` };
        },
      }));

      await adapter(fetchImpl).send(CLAIM_MESSAGE).catch(() => undefined);

      expect(bodyReads).toBe(0);
    });
  });
});
