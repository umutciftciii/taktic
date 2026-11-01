import { Logger } from '@nestjs/common';
import { OpsAlertEmailRouting, OpsAlertRecipientStatus, UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/modules/auth/auth.types';
import { OPERATIONS_SETTINGS_ID } from '../src/modules/operations-settings/operations-settings.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../src/modules/offers/refund-policy';
import { OpsAlertEvaluator } from '../src/modules/ops-alerts/ops-alert-evaluator.service';
import { OpsAlertKeyRotationService } from '../src/modules/ops-alerts/ops-alert-key-rotation.service';
import { DuplicateRecipientError, OpsAlertRecipientsService } from '../src/modules/ops-alerts/ops-alert-recipients.service';
import { OpsAlertRoutingService } from '../src/modules/ops-alerts/ops-alert-routing.service';
import { TelegramAlertPort } from '../src/modules/ops-alerts/telegram-alert.port';
import { SystemHealthService } from '../src/modules/system-health/system-health.service';
import { createTestApp, createUser, resetDatabase, type TestContext } from './harness';
import {
  DEVELOPMENT_RECIPIENT_ENC_KEYS,
  DEVELOPMENT_RECIPIENT_HMAC_KEY,
  OpsAlertRecipientCryptoConfigError,
  assertOpsAlertRecipientCryptoConfig,
  resolveRecipientCryptoConfig,
  type RecipientCryptoConfig,
} from '../src/modules/ops-alerts/recipient-crypto.config';
import {
  InvalidRecipientAddressError,
  RecipientDecryptError,
  addressHmac,
  decryptAddress,
  encryptAddress,
  normalizeAddress,
} from '../src/modules/ops-alerts/recipient-crypto';

/**
 * Keys are generated here from repeated bytes and characters, never typed as
 * literals: nothing in this file may look like a secret to a scanner.
 */
const keyOf = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const HMAC_KEY = 'h'.repeat(40);
const OTHER_HMAC_KEY = 'k'.repeat(40);

const STAGING = { NODE_ENV: 'production', APP_ENVIRONMENT: 'staging' } as const;

function stagingEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...STAGING,
    OPS_ALERT_RECIPIENT_ENC_KEYS: `v1:${keyOf(1)},v2:${keyOf(2)}`,
    OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v2',
    OPS_ALERT_RECIPIENT_HMAC_KEY: HMAC_KEY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function config(overrides: Record<string, string | undefined> = {}): RecipientCryptoConfig {
  return resolveRecipientCryptoConfig(stagingEnv(overrides));
}

/**
 * The error `work` throws. Outside any try/catch, so a call that does not
 * throw fails the test here instead of being swallowed with the assertions
 * that were meant for the error.
 */
function thrownBy(work: () => unknown): Error {
  let thrown: unknown = null;
  try {
    work();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) expect.unreachable('expected a refusal');
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
}

describe('recipient address encryption', () => {
  it('round-trips an address under the active key', () => {
    const c = config();
    const sealed = encryptAddress(c, 'recipient-1', 'ops@example.test');
    expect(sealed.keyId).toBe('v2');
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('ops@example.test');
    expect(decryptAddress(c, 'recipient-1', sealed)).toBe('ops@example.test');
  });

  it('uses a fresh nonce per encryption', () => {
    const c = config();
    const a = encryptAddress(c, 'recipient-1', 'ops@example.test');
    const b = encryptAddress(c, 'recipient-1', 'ops@example.test');
    expect(a.nonce.equals(b.nonce)).toBe(false);
  });

  it('refuses ciphertext moved to another recipient id', () => {
    const c = config();
    const sealed = encryptAddress(c, 'recipient-1', 'ops@example.test');
    expect(() => decryptAddress(c, 'recipient-2', sealed)).toThrow(RecipientDecryptError);
  });

  it('refuses a tampered tag and tampered ciphertext', () => {
    const c = config();
    const sealed = encryptAddress(c, 'recipient-1', 'ops@example.test');
    const tag = Buffer.from(sealed.tag);
    tag[0] = (tag[0] ?? 0) ^ 1;
    expect(() => decryptAddress(c, 'recipient-1', { ...sealed, tag })).toThrow(RecipientDecryptError);
    const ciphertext = Buffer.from(sealed.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    expect(() => decryptAddress(c, 'recipient-1', { ...sealed, ciphertext })).toThrow(RecipientDecryptError);
  });

  it('decrypts with an older key still in the keyring', () => {
    const before = config({ OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v1' });
    const sealed = encryptAddress(before, 'recipient-1', 'ops@example.test');
    expect(sealed.keyId).toBe('v1');
    const after = config({ OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v2' });
    expect(decryptAddress(after, 'recipient-1', sealed)).toBe('ops@example.test');
  });

  it('fails when the key id left the keyring, without naming the address', () => {
    const before = config();
    const sealed = encryptAddress(before, 'recipient-1', 'ops@example.test');
    const after = config({ OPS_ALERT_RECIPIENT_ENC_KEYS: `v1:${keyOf(1)},v3:${keyOf(3)}`, OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v3' });
    let message = '';
    try {
      decryptAddress(after, 'recipient-1', sealed);
    } catch (error) {
      expect(error).toBeInstanceOf(RecipientDecryptError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('ops@example.test');
  });

  it('a decrypt failure message carries no value', () => {
    const c = config();
    const sealed = encryptAddress(c, 'recipient-1', 'ops@example.test');
    const error = thrownBy(() => decryptAddress(c, 'recipient-9', sealed));
    expect(error).toBeInstanceOf(RecipientDecryptError);
    expect(error.message).not.toContain('ops@example.test');
    expect(error.message).not.toContain('recipient-9');
  });
});

describe('recipient keyed identity', () => {
  it('hmac is stable across case and whitespace, and is 64 hex', () => {
    const c = config();
    const a = addressHmac(c, normalizeAddress('  Ops@Example.TEST '));
    const b = addressHmac(c, normalizeAddress('ops@example.test'));
    expect(a).toEqual(b);
    expect(a.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version).toBe(1);
  });

  it('hmac changes with the key; the version is recorded, not hashed', () => {
    const base = addressHmac(config(), 'ops@example.test');
    const otherKey = addressHmac(config({ OPS_ALERT_RECIPIENT_HMAC_KEY: OTHER_HMAC_KEY }), 'ops@example.test');
    expect(otherKey.hmac).not.toBe(base.hmac);
    const otherVersion = addressHmac(config({ OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION: '7' }), 'ops@example.test');
    expect(otherVersion.version).toBe(7);
    expect(otherVersion.hmac).toBe(base.hmac);
    expect(addressHmac(config(), 'other@example.test').hmac).not.toBe(base.hmac);
  });
});

describe('normalizeAddress', () => {
  it('trims and lowercases', () => {
    expect(normalizeAddress('  Ops@Example.TEST ')).toBe('ops@example.test');
  });

  it.each([
    ['a display-name form', 'Ad <a@x.com>'],
    ['255 characters', `${'a'.repeat(243)}@example.com`],
    ['a host without a dot', 'a@x'],
    ['inner whitespace', 'a b@example.com'],
    ['an angle bracket', 'a@example.com>'],
    ['an empty string', '   '],
  ])('rejects %s', (_label, raw) => {
    expect(() => normalizeAddress(raw)).toThrow(InvalidRecipientAddressError);
  });

  it('accepts exactly 254 characters and carries no value in the error', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(long).toHaveLength(254);
    expect(normalizeAddress(long)).toBe(long);
    const error = thrownBy(() => normalizeAddress('Ad <secret-value@x.com>'));
    expect(error).toBeInstanceOf(InvalidRecipientAddressError);
    expect(error.message).not.toContain('secret-value');
  });
});

describe('recipient crypto configuration', () => {
  it('staging without keys refuses to boot; message names the variable, not the value', () => {
    expect(() => resolveRecipientCryptoConfig({ ...STAGING } as NodeJS.ProcessEnv)).toThrow(OpsAlertRecipientCryptoConfigError);
    expect(() => resolveRecipientCryptoConfig({ ...STAGING } as NodeJS.ProcessEnv)).toThrow(/OPS_ALERT_RECIPIENT_ENC_KEYS/);

    const noHmac = stagingEnv({ OPS_ALERT_RECIPIENT_HMAC_KEY: undefined });
    expect(() => resolveRecipientCryptoConfig(noHmac)).toThrow(/OPS_ALERT_RECIPIENT_HMAC_KEY is required/);

    const short = stagingEnv({ OPS_ALERT_RECIPIENT_HMAC_KEY: 's'.repeat(31) });
    const error = thrownBy(() => resolveRecipientCryptoConfig(short));
    expect(error.message).toMatch(/at least 32 characters/);
    expect(error.message).not.toContain('s'.repeat(31));
  });

  it('an undeclared environment is as strict as staging', () => {
    expect(() => resolveRecipientCryptoConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /OPS_ALERT_RECIPIENT_ENC_KEYS is required/,
    );
  });

  it('development keys are refused on staging and production', () => {
    for (const env of [{ ...STAGING }, { NODE_ENV: 'production', APP_ENVIRONMENT: 'production' }]) {
      expect(() =>
        resolveRecipientCryptoConfig({
          ...env,
          OPS_ALERT_RECIPIENT_ENC_KEYS: DEVELOPMENT_RECIPIENT_ENC_KEYS,
          OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v1',
          OPS_ALERT_RECIPIENT_HMAC_KEY: HMAC_KEY,
        } as NodeJS.ProcessEnv),
      ).toThrow(/OPS_ALERT_RECIPIENT_ENC_KEYS is the published development keyring/);
      expect(() =>
        resolveRecipientCryptoConfig(
          stagingEnv({ APP_ENVIRONMENT: env.APP_ENVIRONMENT, OPS_ALERT_RECIPIENT_HMAC_KEY: DEVELOPMENT_RECIPIENT_HMAC_KEY }),
        ),
      ).toThrow(/OPS_ALERT_RECIPIENT_HMAC_KEY is the published development key/);
    }
  });

  it('a keyring that merely contains a development key is refused too', () => {
    const devKey = DEVELOPMENT_RECIPIENT_ENC_KEYS.split(',')[0]!.split(':')[1]!;
    expect(() =>
      resolveRecipientCryptoConfig(stagingEnv({ OPS_ALERT_RECIPIENT_ENC_KEYS: `v1:${devKey},v2:${keyOf(2)}` })),
    ).toThrow(/published development keyring/);
  });

  it('development keys work under NODE_ENV=test and on a declared local stack', () => {
    for (const env of [{ NODE_ENV: 'test' }, { NODE_ENV: 'production', APP_ENVIRONMENT: 'local' }]) {
      const c = resolveRecipientCryptoConfig(env as NodeJS.ProcessEnv);
      expect(c.source).toBe('development');
      expect(c.activeKeyId).toBe('v1');
      expect(c.hmacKey).toContain('not-secret');
      for (const key of c.encKeys.values()) expect(key).toHaveLength(32);
      expect(decryptAddress(c, 'r', encryptAddress(c, 'r', 'ops@example.test'))).toBe('ops@example.test');
    }
  });

  it('an explicit environment value is used and marked as such', () => {
    const c = config();
    expect(c.source).toBe('environment');
    expect([...c.encKeys.keys()]).toEqual(['v1', 'v2']);
    expect(c.activeKeyId).toBe('v2');
    expect(c.hmacVersion).toBe(1);
  });

  it('keyring rejects a 31-byte key, a duplicate id, an active id not in the ring, and bad shapes', () => {
    const short = Buffer.alloc(31, 1).toString('base64');
    expect(() => config({ OPS_ALERT_RECIPIENT_ENC_KEYS: `v1:${short}`, OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v1' })).toThrow(/32 bytes/);
    expect(() => config({ OPS_ALERT_RECIPIENT_ENC_KEYS: `v1:${keyOf(1)},v1:${keyOf(2)}`, OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v1' })).toThrow(
      /duplicate/,
    );
    expect(() => config({ OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v9' })).toThrow(/OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE/);
    expect(() => config({ OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: undefined })).toThrow(/OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE is required/);
    expect(() => config({ OPS_ALERT_RECIPIENT_ENC_KEYS: `one:${keyOf(1)}`, OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'one' })).toThrow(/v<n>:<base64 key>/);
    expect(() => config({ OPS_ALERT_RECIPIENT_ENC_KEYS: 'v1:@@@', OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v1' })).toThrow(/base64/);
  });

  it('a keyring refusal never prints a key', () => {
    const short = Buffer.alloc(31, 1).toString('base64');
    const error = thrownBy(() => config({ OPS_ALERT_RECIPIENT_ENC_KEYS: `v1:${short}`, OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE: 'v1' }));
    expect(error).toBeInstanceOf(OpsAlertRecipientCryptoConfigError);
    expect(error.message).not.toContain(short);
  });

  it('the hmac key version is a whole number from 1 to 1000', () => {
    for (const bad of ['0', '1001', '1.5', 'x']) {
      expect(() => config({ OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION: bad })).toThrow(/OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION/);
    }
    expect(config({ OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION: '1000' }).hmacVersion).toBe(1000);
  });

  it('assertOpsAlertRecipientCryptoConfig passes in the test environment', () => {
    expect(() => assertOpsAlertRecipientCryptoConfig()).not.toThrow();
  });
});

describe('OpsAlertKeyRotationService', () => {
  let ctx: TestContext;
  let actor: AuthUser;
  const recipients = () => ctx.app.get(OpsAlertRecipientsService);
  const rotation = () => ctx.app.get(OpsAlertKeyRotationService);
  const prefs = { notifyWarning: true, notifyCritical: true, notifyRecovery: false };

  /** Selects the keyring for what follows; the crypto config is resolved per call. */
  function useKeys(env: { keys: string; active: string; hmacKey?: string; hmacVersion?: string }) {
    vi.stubEnv('OPS_ALERT_RECIPIENT_ENC_KEYS', env.keys);
    vi.stubEnv('OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE', env.active);
    vi.stubEnv('OPS_ALERT_RECIPIENT_HMAC_KEY', env.hmacKey ?? HMAC_KEY);
    vi.stubEnv('OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION', env.hmacVersion ?? '1');
  }
  const V1 = { keys: `v1:${keyOf(1)}`, active: 'v1' };
  const V1_V2 = { keys: `v1:${keyOf(1)},v2:${keyOf(2)}`, active: 'v2' };
  const V2_ONLY = { keys: `v2:${keyOf(2)}`, active: 'v2' };

  const add = (address: string) => recipients().create(actor, { address, label: 'Nöbetçi', ...prefs });
  const row = (id: string) => ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.notifications.clear();
    const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'Kök' });
    actor = { id: user.id, email: user.email, phone: user.phone, name: user.name, role: user.role, isActive: true };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('rewrap moves every live recipient to the active key and leaves deleted ones alone', async () => {
    useKeys(V1);
    const a = await add('a@example.test');
    const b = await add('b@example.test');
    const paused = await add('p@example.test');
    const gone = await add('g@example.test');
    await recipients().pause(actor, paused.id, { version: paused.version, confirmLastCritical: true });
    await recipients().remove(actor, gone.id, { version: gone.version, reason: 'Ayrıldı', confirmLastCritical: true });
    const goneBefore = await row(gone.id);
    const nonceBefore = (await row(a.id)).addressNonce;

    useKeys(V1_V2);
    expect(await rotation().rewrap(actor)).toEqual({ rewrapped: 3, failed: 0 });

    for (const [id, version] of [[a.id, 2], [b.id, 2], [paused.id, 3]] as const) {
      const after = await row(id);
      expect(after.addressKeyId).toBe('v2');
      expect(after.version).toBe(version);
      expect((await recipients().reveal(actor, id)).address).toBeTruthy();
    }
    expect((await recipients().reveal(actor, a.id)).address).toBe('a@example.test');
    expect(Buffer.from((await row(a.id)).addressNonce!).equals(Buffer.from(nonceBefore!))).toBe(false);
    expect(await row(gone.id)).toEqual(goneBefore);
    expect((await row(paused.id)).status).toBe(OpsAlertRecipientStatus.PAUSED);

    const audits = await ctx.prisma.opsAlertRecipientAuditLog.findMany({ where: { action: 'REWRAPPED' } });
    expect(audits).toHaveLength(3);
    expect(audits.every((entry) => JSON.stringify(entry.before) === '{"keyId":"v1"}' && JSON.stringify(entry.after) === '{"keyId":"v2"}')).toBe(true);

    expect(await rotation().rewrap(actor)).toEqual({ rewrapped: 0, failed: 0 });
  });

  it('rewrap reports a recipient whose key is missing as failed and changes nothing for it', async () => {
    useKeys(V1);
    const stuck = await add('stuck@example.test');
    useKeys(V1_V2);
    const fine = await add('fine@example.test');
    const other = await add('other@example.test');
    const stuckBefore = await row(stuck.id);

    useKeys(V2_ONLY);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await rotation().rewrap(actor)).toEqual({ rewrapped: 0, failed: 1 });
    expect(await row(stuck.id)).toEqual(stuckBefore);
    // A safe line per failed row: its id and a coarse reason, never an address or a key.
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([expect.stringContaining(stuck.id)]);
    expect(lines[0]).toContain('reason=no-key');
    expect(lines[0]).not.toContain('stuck@example.test');
    expect(lines[0]).not.toContain(keyOf(1));
    expect((await row(fine.id)).version).toBe(1);
    expect((await row(other.id)).addressKeyId).toBe('v2');
    expect(await ctx.prisma.opsAlertRecipientAuditLog.count({ where: { action: 'REWRAPPED' } })).toBe(0);
  });

  it('rehash updates hmac and version; dedupe still holds afterwards', async () => {
    useKeys({ ...V1, hmacKey: HMAC_KEY, hmacVersion: '1' });
    const a = await add('a@example.test');
    const b = await add('b@example.test');
    const before = await row(a.id);

    useKeys({ ...V1, hmacKey: OTHER_HMAC_KEY, hmacVersion: '2' });
    expect(await rotation().rehash(actor)).toEqual({ rehashed: 2, failed: 0 });

    const current = resolveRecipientCryptoConfig();
    const after = await row(a.id);
    expect(after.addressHmacVersion).toBe(2);
    expect(after.addressHmac).toBe(addressHmac(current, 'a@example.test').hmac);
    expect(after.addressHmac).not.toBe(before.addressHmac);
    expect(after.version).toBe(2);
    expect((await row(b.id)).addressHmacVersion).toBe(2);
    await expect(add('a@example.test')).rejects.toBeInstanceOf(DuplicateRecipientError);

    const audits = await ctx.prisma.opsAlertRecipientAuditLog.findMany({ where: { action: 'REHASHED' } });
    expect(audits).toHaveLength(2);
    expect(audits.every((entry) => JSON.stringify(entry.before) === '{"hmacVersion":1}' && JSON.stringify(entry.after) === '{"hmacVersion":2}')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(after.addressHmac!);
    expect(await rotation().rehash(actor)).toEqual({ rehashed: 0, failed: 0 });
  });

  it('rehash counts a unique-index collision as failed and carries on', async () => {
    useKeys({ ...V1, hmacKey: HMAC_KEY, hmacVersion: '1' });
    const old = await add('same@example.test');
    const other = await add('other@example.test');
    useKeys({ ...V1, hmacKey: OTHER_HMAC_KEY, hmacVersion: '2' });
    const twin = await add('same@example.test');

    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = await rotation().rehash(actor);
    expect(result).toEqual({ rehashed: 1, failed: 1 });
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([expect.stringContaining(old.id)]);
    expect(lines[0]).toContain('reason=collision');
    expect(lines[0]).not.toContain('same@example.test');
    expect((await row(old.id)).addressHmacVersion).toBe(1);
    expect((await row(other.id)).addressHmacVersion).toBe(2);
    expect((await row(twin.id)).addressHmacVersion).toBe(2);
  });

  it('state().keyIds reflects the distribution', async () => {
    useKeys(V1);
    await add('a@example.test');
    await add('b@example.test');
    useKeys(V1_V2);
    await add('c@example.test');
    const routing = ctx.app.get(OpsAlertRoutingService);
    expect((await routing.state()).keyIds).toEqual({ v1: 2, v2: 1 });
    await rotation().rewrap(actor);
    expect((await routing.state()).keyIds).toEqual({ v2: 3 });
  });

  it('a managed delivery after rewrap still decrypts and sends to the same address', async () => {
    useKeys(V1);
    const target = await add('after-rewrap@example.test');
    useKeys(V1_V2);
    await rotation().rewrap(actor);
    expect((await row(target.id)).addressKeyId).toBe('v2');

    vi.spyOn(ctx.app.get(TelegramAlertPort), 'send').mockResolvedValue({ providerMessageId: 'tg-1' });
    vi.stubEnv('OPS_ALERT_EMAIL', 'ops-alerts@example.test');
    ctx.app.get(SystemHealthService).clearCache();
    await ctx.prisma.opsAlertRoutingSettings.update({
      where: { id: 'ops-alert-routing' },
      data: { emailRouting: OpsAlertEmailRouting.MANAGED },
    });
    await ctx.prisma.operationsSettings.deleteMany();
    await ctx.prisma.operationsSettings.create({
      data: {
        id: OPERATIONS_SETTINGS_ID,
        unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
        unviewedOfferRefundSchedulerEnabled: true,
      },
    });
    const at = new Date(Date.now() - 5 * 60_000);
    await ctx.prisma.schedulerRun.create({
      data: {
        jobKey: 'unviewed-offer-refund',
        status: 'FAILED',
        startedAt: at,
        finishedAt: new Date(at.getTime() + 1000),
        errorCode: 'PrismaClientKnownRequestError',
      },
    });

    await ctx.app.get(OpsAlertEvaluator).evaluate();

    expect(ctx.notifications.ofTemplate('ops-alert').map((mail) => mail.to)).toEqual(['after-rewrap@example.test']);
  });
});
