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
