import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OPS_ALERT_RECIPIENT_LIMIT, OPS_ALERT_RECIPIENT_LOCK_KEY } from '../src/modules/ops-alerts/ops-alert-recipient.constants';
import { OPS_ALERT_ADVISORY_LOCK_KEY } from '../src/modules/ops-alerts/ops-alert.rules';
import { createUser, resetDatabase } from './harness';

/**
 * OBS-ALERT-002 — what the database itself enforces for managed alert
 * recipients: per-recipient delivery uniqueness next to the legacy per-channel
 * one, the crypto-shred shape, the live-recipient limit and the append-only
 * audit table. Application code is deliberately not involved: these are the
 * guarantees that must hold even when it is wrong.
 */
describe('OBS-ALERT-002 schema', () => {
  const prisma = new PrismaClient();
  let actorId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    actorId = (await createUser(prisma, { role: UserRole.ADMIN })).id;
  });

  let counter = 0;
  const bytes = () => Buffer.from([1, 2, 3]);

  async function recipient(overrides: Record<string, unknown> = {}) {
    counter += 1;
    return prisma.opsAlertRecipient.create({
      data: {
        label: `Recipient ${counter}`,
        addressCiphertext: bytes(),
        addressNonce: bytes(),
        addressTag: bytes(),
        addressKeyId: 'v1',
        addressHmac: `hmac-${counter}-${Math.random()}`,
        addressHmacVersion: 1,
        maskedAddress: 'o***@example.test',
        notifyWarning: true,
        notifyCritical: true,
        notifyRecovery: true,
        createdById: actorId,
        updatedById: actorId,
        ...overrides,
      },
    });
  }

  async function alert() {
    counter += 1;
    const now = new Date();
    return prisma.opsAlert.create({
      data: {
        ref: `OPS-TEST-${counter}`,
        fingerprint: `fp-${counter}`,
        source: 'SCHEDULER',
        subjectKey: 'job',
        condition: 'OVERDUE',
        severity: 'CRITICAL',
        firstSeenAt: now,
        lastSeenAt: now,
        lastNotifiedAt: now,
      },
    });
  }

  const delivery = (alertId: string, recipientId: string | null, channel: 'EMAIL' | 'TELEGRAM' = 'EMAIL') => ({
    alertId,
    kind: 'OPENED' as const,
    sequence: 0,
    channel,
    recipientId,
    nextAttemptAt: new Date(),
  });

  async function sqlState(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
    try {
      await promise;
    } catch (error) {
      // Prisma reports a failed statement as an unknown-request error whose
      // text carries the PostgreSQL SQLSTATE and message.
      const message = String((error as Error).message);
      return { code: (error as { code?: string }).code ?? /code: "(\w{5})"/.exec(message)?.[1], message };
    }
    throw new Error('expected the statement to be refused');
  }

  it('legacy delivery rows keep the per-channel uniqueness', async () => {
    const a = await alert();
    const first = await prisma.opsAlertDelivery.createMany({ data: [delivery(a.id, null)], skipDuplicates: true });
    const second = await prisma.opsAlertDelivery.createMany({ data: [delivery(a.id, null)], skipDuplicates: true });
    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
  });

  it('two recipients may each have one row per notice', async () => {
    const a = await alert();
    const r1 = await recipient();
    const r2 = await recipient();
    const both = await prisma.opsAlertDelivery.createMany({
      data: [delivery(a.id, r1.id), delivery(a.id, r2.id)],
      skipDuplicates: true,
    });
    expect(both.count).toBe(2);
    const again = await prisma.opsAlertDelivery.createMany({ data: [delivery(a.id, r1.id)], skipDuplicates: true });
    expect(again.count).toBe(0);
  });

  it('telegram row cannot carry a recipient', async () => {
    const a = await alert();
    const r = await recipient();
    const refused = await sqlState(prisma.opsAlertDelivery.create({ data: delivery(a.id, r.id, 'TELEGRAM') }));
    expect(refused.code).toBe('23514');
    expect(refused.message).toContain('OpsAlertDelivery_recipient_channel_check');
  });

  it('a deleted recipient holds no ciphertext', async () => {
    const refused = await sqlState(recipient({ status: 'DELETED', deletedAt: new Date(), deletedById: actorId }));
    expect(refused.code).toBe('23514');
    expect(refused.message).toContain('OpsAlertRecipient_shred_check');

    const shredded = await recipient({
      status: 'DELETED',
      deletedAt: new Date(),
      deletedById: actorId,
      addressCiphertext: null,
      addressNonce: null,
      addressTag: null,
      addressKeyId: null,
      addressHmac: null,
      addressHmacVersion: null,
    });
    expect(shredded.status).toBe('DELETED');
  });

  it('a live recipient cannot be written without its ciphertext or hmac', async () => {
    const noHmac = await sqlState(recipient({ addressHmac: null, addressHmacVersion: null }));
    expect(noHmac.code).toBe('23514');
    const halfEncrypted = await sqlState(recipient({ addressTag: null }));
    expect(halfEncrypted.code).toBe('23514');
  });

  it('refuses the same address twice among live recipients only', async () => {
    const first = await recipient({ addressHmac: 'same-hmac' });
    const dup = await sqlState(recipient({ addressHmac: 'same-hmac' }));
    expect(dup.code).toBe('P2002');
    await prisma.opsAlertRecipient.update({
      where: { id: first.id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        deletedById: actorId,
        addressCiphertext: null,
        addressNonce: null,
        addressTag: null,
        addressKeyId: null,
        addressHmac: null,
        addressHmacVersion: null,
      },
    });
    await expect(recipient({ addressHmac: 'same-hmac' })).resolves.toBeTruthy();
  });

  it('refuses labels outside 1-80 characters', async () => {
    expect((await sqlState(recipient({ label: '' }))).code).toBe('23514');
    expect((await sqlState(recipient({ label: 'x'.repeat(81) }))).code).toBe('23514');
    await expect(recipient({ label: 'x'.repeat(80) })).resolves.toBeTruthy();
  });

  it('the 11th live recipient is refused by the database', async () => {
    expect(OPS_ALERT_RECIPIENT_LIMIT).toBe(10);
    const made = [];
    for (let i = 0; i < OPS_ALERT_RECIPIENT_LIMIT; i += 1) made.push(await recipient());

    const refused = await sqlState(recipient());
    expect(refused.code).toBe('23514');
    expect(refused.message).toContain('ops_alert_recipient_limit');

    // Prisma drops the SQLSTATE's constraint field, so ask PostgreSQL itself.
    await prisma.$executeRawUnsafe(`
      DO $$
      DECLARE named TEXT;
      BEGIN
        INSERT INTO "OpsAlertRecipient"
          ("id", "label", "addressCiphertext", "addressNonce", "addressTag", "addressKeyId", "addressHmac",
           "addressHmacVersion", "maskedAddress", "notifyWarning", "notifyCritical", "notifyRecovery",
           "createdById", "updatedById", "updatedAt")
        VALUES ('raw-11th', 'x', '\\x01', '\\x01', '\\x01', 'v1', 'raw-11th', 1, 'x***@y.test', true, true, true,
                '${actorId}', '${actorId}', CURRENT_TIMESTAMP);
        RAISE EXCEPTION 'the 11th recipient was accepted';
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS named = CONSTRAINT_NAME;
        IF named IS DISTINCT FROM 'ops_alert_recipient_limit' THEN
          RAISE EXCEPTION 'wrong constraint: %', named;
        END IF;
      END $$`);

    // A deleted recipient frees a slot ...
    await prisma.opsAlertRecipient.update({
      where: { id: made[0]!.id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        deletedById: actorId,
        addressCiphertext: null,
        addressNonce: null,
        addressTag: null,
        addressKeyId: null,
        addressHmac: null,
        addressHmacVersion: null,
      },
    });
    await expect(recipient()).resolves.toBeTruthy();

    // ... and leaving DELETED is counted like an insert.
    const out = await sqlState(
      prisma.opsAlertRecipient.update({
        where: { id: made[0]!.id },
        data: {
          status: 'ACTIVE',
          deletedAt: null,
          deletedById: null,
          addressCiphertext: bytes(),
          addressNonce: bytes(),
          addressTag: bytes(),
          addressKeyId: 'v1',
          addressHmac: 'revived',
          addressHmacVersion: 1,
        },
      }),
    );
    expect(out.message).toContain('ops_alert_recipient_limit');
  });

  it('keeps the recipient lock apart from the evaluator lock', () => {
    expect(BigInt(OPS_ALERT_RECIPIENT_LOCK_KEY)).not.toBe(BigInt(OPS_ALERT_ADVISORY_LOCK_KEY));
  });

  it('audit rows are append-only', async () => {
    const row = await prisma.opsAlertRecipientAuditLog.create({
      data: { recipientId: null, actorId, action: 'ROUTING_CUTOVER', after: { emailRouting: 'MANAGED' } },
    });
    const updated = await sqlState(
      prisma.opsAlertRecipientAuditLog.update({ where: { id: row.id }, data: { reason: 'edited' } }),
    );
    expect(updated.message).toContain('append-only');
    const deleted = await sqlState(prisma.opsAlertRecipientAuditLog.delete({ where: { id: row.id } }));
    expect(deleted.message).toContain('append-only');
  });

  it('routing settings start as ENV_LEGACY', async () => {
    const rows = await prisma.opsAlertRoutingSettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'ops-alert-routing', emailRouting: 'ENV_LEGACY', changedAt: null, changedById: null });
    const other = await sqlState(
      prisma.opsAlertRoutingSettings.create({ data: { id: 'second' } }),
    );
    expect(other.code).toBe('23514');
  });
});

/**
 * OBS-ALERT-002 rollback scripts (spec §0.13). The SQL is read from the very
 * files an operator runs with psql, so the test and the script cannot drift:
 * the cancel script's `set_config` line (with psql's `:'expected'` turned into
 * a bind parameter) and its DO block, and the report's single statement.
 */
describe('OBS-ALERT-002 rollback scripts', () => {
  const prisma = new PrismaClient();
  const scriptsDir = resolve(__dirname, '../../../scripts/ops');
  // Read when a test asks, so a missing script fails its tests and not the file.
  const script = (name: string) => readFileSync(resolve(scriptsDir, name), 'utf8');
  const cancelScript = () => script('obs-alert-002-rollback-cancel.sql');
  const reportScript = () => script('obs-alert-002-rollback-report.sql');

  function extract(source: string, pattern: RegExp, what: string): string {
    const match = pattern.exec(source);
    if (!match) throw new Error(`${what} not found in the script`);
    return match[0];
  }

  const setExpectedSql = () =>
    extract(cancelScript(), /SELECT set_config\('obs_alert_002\.expected', :'expected', false\);/, 'set_config line')
      .replace(":'expected'", '$1::text')
      .replace(/;$/, '');
  const cancelBody = () => extract(cancelScript(), /DO \$cancel\$[\s\S]*?\$cancel\$;/, 'cancel DO block').replace(/;$/, '');
  const reportBody = () =>
    extract(reportScript(), /-- report:begin\n([\s\S]*?)-- report:end/, 'report statement')
      .replace(/^-- report:begin\n/, '')
      .replace(/-- report:end$/, '')
      .trim()
      .replace(/;$/, '');

  /** One connection for both statements: a session setting does not cross the pool. */
  function runCancel(expected: string | null) {
    return prisma.$transaction(async (tx) => {
      if (expected === null) {
        // Clear whatever an earlier test left on this pooled connection.
        await tx.$queryRawUnsafe(`SELECT set_config('obs_alert_002.expected', '', false)`);
      } else {
        await tx.$queryRawUnsafe(setExpectedSql(), expected);
      }
      await tx.$executeRawUnsafe(cancelBody());
    });
  }

  type ReportRow = { section: string; item: string; value: string };
  function runReport(): Promise<ReportRow[]> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe<ReportRow[]>(reportBody());
    });
  }

  let actorId: string;
  let counter = 0;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    actorId = (await createUser(prisma, { role: UserRole.ADMIN })).id;
  });

  async function recipient(hmac: string, keyId = 'v1') {
    counter += 1;
    return prisma.opsAlertRecipient.create({
      data: {
        label: `Recipient ${counter}`,
        addressCiphertext: Buffer.from('cipher-bytes'),
        addressNonce: Buffer.from('nonce-bytes'),
        addressTag: Buffer.from('tag-bytes'),
        addressKeyId: keyId,
        addressHmac: hmac,
        addressHmacVersion: 1,
        maskedAddress: 'o***@rollback.test',
        notifyWarning: true,
        notifyCritical: true,
        notifyRecovery: true,
        createdById: actorId,
        updatedById: actorId,
      },
    });
  }

  async function alert() {
    counter += 1;
    const now = new Date();
    return prisma.opsAlert.create({
      data: {
        ref: `OPS-RB-${counter}`,
        fingerprint: `fp-rb-${counter}`,
        source: 'SCHEDULER',
        subjectKey: 'job',
        condition: 'OVERDUE',
        severity: 'CRITICAL',
        firstSeenAt: now,
        lastSeenAt: now,
        lastNotifiedAt: now,
      },
    });
  }

  type Status = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'ABANDONED' | 'CANCELLED';

  /** A fixture with managed rows in every status and legacy rows beside them. */
  async function fixture() {
    const a = await alert();
    const r1 = await recipient('hmac-secret-one');
    const r2 = await recipient('hmac-secret-two', 'v2');
    let sequence = 0;
    const row = (recipientId: string | null, status: Status, channel: 'EMAIL' | 'TELEGRAM' = 'EMAIL') =>
      prisma.opsAlertDelivery.create({
        data: {
          alertId: a.id,
          kind: 'REMINDER',
          sequence: (sequence += 1),
          channel,
          recipientId,
          status,
          nextAttemptAt: new Date(),
          ...(status === 'SENDING' ? { claimToken: `claim-${sequence}`, claimedAt: new Date() } : {}),
        },
        select: { id: true },
      });
    const managed = {
      pending: [await row(r1.id, 'PENDING'), await row(r2.id, 'PENDING')],
      failed: [await row(r1.id, 'FAILED')],
      sending: [await row(r2.id, 'SENDING')],
      settled: [await row(r1.id, 'SENT'), await row(r2.id, 'ABANDONED'), await row(r1.id, 'CANCELLED')],
    };
    const legacy = [await row(null, 'PENDING'), await row(null, 'FAILED'), await row(null, 'SENDING', 'TELEGRAM')];
    return { managed, legacy, r1, r2 };
  }

  const statuses = () =>
    prisma.opsAlertDelivery.findMany({
      orderBy: { sequence: 'asc' },
      select: { id: true, status: true, errorCode: true, claimToken: true, claimedAt: true, recipientId: true },
    });

  it('rollback cancel refuses without expected counts', async () => {
    await fixture();
    const before = await statuses();
    await expect(runCancel(null)).rejects.toThrow(/expected counts are required/);
    await expect(runCancel('PENDING=2,FAILED=1')).rejects.toThrow(/expected counts are required/);
    await expect(runCancel('PENDING=two,FAILED=1,SENDING=1')).rejects.toThrow(/expected counts are required/);
    expect(await statuses()).toEqual(before);
  });

  it('rollback cancel refuses when counts differ', async () => {
    await fixture();
    const before = await statuses();
    await expect(runCancel('PENDING=1,FAILED=1,SENDING=1')).rejects.toThrow(/counts changed/);
    await expect(runCancel('PENDING=2,FAILED=1,SENDING=0')).rejects.toThrow(/counts changed/);
    expect(await statuses()).toEqual(before);
  });

  it('rollback cancel cancels exactly the reported rows', async () => {
    const { managed, legacy } = await fixture();
    const report = await runReport();
    const expected = report.find((row) => row.section === 'expected')?.value;
    expect(expected).toBe('PENDING=2,FAILED=1,SENDING=1');

    const before = await statuses();
    await runCancel(expected!);
    const after = await statuses();

    const open = new Set([...managed.pending, ...managed.failed, ...managed.sending].map((r) => r.id));
    for (const row of after) {
      const was = before.find((b) => b.id === row.id)!;
      if (open.has(row.id)) {
        expect(row).toMatchObject({ status: 'CANCELLED', errorCode: 'ROLLED_BACK', claimToken: null, claimedAt: null });
        expect(row.recipientId).toBe(was.recipientId);
      } else {
        expect(row).toEqual(was);
      }
    }
    expect(after.filter((r) => legacy.some((l) => l.id === r.id)).map((r) => r.status)).toEqual([
      'PENDING',
      'FAILED',
      'SENDING',
    ]);

    // Run again with the old numbers: nothing is open any more, so it refuses.
    await expect(runCancel(expected!)).rejects.toThrow(/counts changed/);
    await runCancel('PENDING=0,FAILED=0,SENDING=0');
  });

  it('rollback cancel refuses while routing is MANAGED', async () => {
    await fixture();
    await prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting: 'MANAGED' } });
    const before = await statuses();
    await expect(runCancel('PENDING=2,FAILED=1,SENDING=1')).rejects.toThrow(/routing is MANAGED.*revert/i);
    expect(await statuses()).toEqual(before);
  });

  it('report prints counts only', async () => {
    const { r1 } = await fixture();
    await recipient('hmac-secret-paused').then((r) =>
      prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { status: 'PAUSED' } }),
    );
    const rows = await runReport();
    const value = (section: string, item: string) => rows.find((r) => r.section === section && r.item === item)?.value;

    expect(value('open_recipient_deliveries', 'PENDING')).toBe('2');
    expect(value('open_recipient_deliveries', 'FAILED')).toBe('1');
    expect(value('open_recipient_deliveries', 'SENDING')).toBe('1');
    expect(value('routing', 'emailRouting')).toBe('ENV_LEGACY');
    expect(value('recipients_by_status', 'ACTIVE')).toBe('2');
    expect(value('recipients_by_status', 'PAUSED')).toBe('1');
    expect(value('recipients_by_status', 'DELETED')).toBe('0');
    expect(value('live_recipients_by_key_id', 'v1')).toBe('2');
    expect(value('live_recipients_by_key_id', 'v2')).toBe('1');
    expect(value('live_recipients_by_hmac_version', '1')).toBe('3');

    const text = JSON.stringify(rows);
    for (const secret of ['hmac-secret', 'rollback.test', '***', 'cipher-bytes', Buffer.from('cipher-bytes').toString('hex'), r1.id]) {
      expect(text).not.toContain(secret);
    }
    // Every value is a count, a mode name or the expected line.
    for (const row of rows) {
      if (row.section === 'routing' || row.section === 'expected') continue;
      expect(row.value).toMatch(/^\d+$/);
    }
  });

  it('report statement is read-only', () => {
    expect(reportBody()).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i);
    expect(reportScript()).toMatch(/BEGIN TRANSACTION READ ONLY;/);
  });
});
