import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleNotificationAdapter } from '../src/modules/notifications/console-notification.adapter';
import { EmailBrandingService } from '../src/modules/notifications/email-branding.service';
import { FileOutboxNotificationAdapter } from '../src/modules/notifications/file-outbox-notification.adapter';
import { RECIPIENT_HIDDEN_LABEL, maskEmail } from '../src/modules/notifications/mask';
import type { NotificationMessage } from '../src/modules/notifications/notification.port';
import { ResendNotificationAdapter, type ResendFetch } from '../src/modules/notifications/resend-notification.adapter';

/**
 * OBS-ALERT-002 — an alert recipient is never written to a log, in any form
 * (not the address, its local part, its domain or the masked address). Every
 * other template keeps the historical masked form.
 */
const ADDRESS = 'sorumlu.kisi@gizli-alan.example';
const LOCAL = 'sorumlu.kisi';
const DOMAIN = 'gizli-alan.example';
const MASKED = maskEmail(ADDRESS);

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

function message(template: NotificationMessage['template'], extra: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    template,
    to: ADDRESS,
    subject: 'Konu',
    data: { fullName: 'Operasyon Ekibi', businessName: 'Örnek' },
    ...extra,
  };
}

describe('recipient log policy', () => {
  let lines: string[];
  let dirs: string[];

  beforeEach(() => {
    lines = [];
    dirs = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((text: unknown) => {
        lines.push(String(text));
      });
    }
    vi.stubEnv('WEB_APP_URL', 'https://app.example.test');
    vi.stubEnv('RESEND_API_KEY', 're_TESTKEY_not_a_real_credential');
    vi.stubEnv('RESEND_FROM', 'TakTic <no-reply@mail.example.test>');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const everything = () => lines.join('\n');
  function expectNoRecipient() {
    const text = everything();
    for (const forbidden of [ADDRESS, LOCAL, DOMAIN, MASKED]) expect(text).not.toContain(forbidden);
  }

  describe('Resend (against a stand-in HTTP server)', () => {
    let server: Server;
    let origin: string;

    beforeEach(async () => {
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'resend-msg-1' }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const adapter = () =>
      new ResendNotificationAdapter(brandingStub, (input, init) =>
        globalThis.fetch(input.replace('https://api.resend.com', origin), init) as unknown as ReturnType<ResendFetch>,
      );

    it('hidden: no log line names the recipient in any form', async () => {
      await adapter().send(message('ops-alert', { recipientLogPolicy: 'hidden', idempotencyKey: 'k-1' }));
      expect(everything()).toContain(RECIPIENT_HIDDEN_LABEL);
      expectNoRecipient();
    });

    it('other templates keep the masked form', async () => {
      await adapter().send(message('provider-claim', { actionUrl: 'https://app.example.test/claim?token=t' }));
      expect(everything()).toContain(MASKED);
      expect(everything()).not.toContain(ADDRESS);
    });
  });

  describe('console adapter', () => {
    it('hidden: no recipient, and no "to" line, outside production too', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      await new ConsoleNotificationAdapter().send(message('ops-alert', { recipientLogPolicy: 'hidden' }));
      expectNoRecipient();
      expect(everything()).not.toMatch(/^to\s*:/m);
      expect(everything()).toContain('template : ops-alert');
    });

    it('hidden in production: the warning uses the label', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      await new ConsoleNotificationAdapter().send(message('ops-alert', { recipientLogPolicy: 'hidden' }));
      expect(everything()).toContain(RECIPIENT_HIDDEN_LABEL);
      expectNoRecipient();
    });

    it('other templates are unchanged: full address in development, masked in production', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      await new ConsoleNotificationAdapter().send(message('provider-claim'));
      expect(everything()).toContain(`to       : ${ADDRESS}`);
      lines.length = 0;
      vi.stubEnv('NODE_ENV', 'production');
      await new ConsoleNotificationAdapter().send(message('provider-claim'));
      expect(everything()).toContain(MASKED);
    });
  });

  describe('file outbox adapter', () => {
    function outbox() {
      const dir = mkdtempSync(join(tmpdir(), 'ops-alert-outbox-'));
      dirs.push(dir);
      vi.stubEnv('NOTIFICATION_OUTBOX_DIR', dir);
      return dir;
    }

    it('hidden: the log line uses the label, the outbox file still carries the address', async () => {
      const dir = outbox();
      await new FileOutboxNotificationAdapter().send(message('ops-alert', { recipientLogPolicy: 'hidden' }));
      expect(everything()).toContain(RECIPIENT_HIDDEN_LABEL);
      expectNoRecipient();
      expect(readFileSync(join(dir, 'email.jsonl'), 'utf8')).toContain(ADDRESS);
    });

    it('other templates keep the masked form', async () => {
      outbox();
      await new FileOutboxNotificationAdapter().send(message('provider-claim'));
      expect(everything()).toContain(MASKED);
      expect(everything()).not.toContain(ADDRESS);
    });
  });
});
