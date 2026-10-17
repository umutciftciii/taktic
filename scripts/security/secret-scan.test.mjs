import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { entropy, redact, scanFiles, scanText } from './secret-scan.mjs';

// Every secret-shaped value below is assembled at run time, so this file never
// contains one itself — the scan runs over it in CI like over every other.
const join2 = (...parts) => parts.join('');
const RANDOM = 'q8Zr2LmT0vXk4NbY7sWc1PdH';
const rules = (text, path = 'apps/x/file.ts') => scanText(path, text).map((finding) => finding.rule);

test('flags the retired seed password in code, markdown and prose, whatever its case', () => {
  const seed = join2('Change', 'Me', '123', '!');
  assert.deepEqual(rules(`password: '${seed}',`), ['known-initial-password']);
  assert.deepEqual(rules(`- Password: \`${seed}\``, 'README.md'), ['known-initial-password']);
  assert.deepEqual(rules(`login with ${seed.toLowerCase()}.`, 'docs/a.md'), ['known-initial-password']);
  assert.deepEqual(rules(`fill('${join2('Pass', 'word', '123!')}')`), ['known-initial-password']);
});

test('flags provider token formats and private keys', () => {
  assert.deepEqual(rules(join2('AKIA', 'Q7ZK3M5N2P4R6T8V')), ['aws-access-key']);
  assert.deepEqual(rules(join2('ghp_', RANDOM, 'abcdefghijkl')), ['github-token']);
  assert.deepEqual(rules(join2('sk_', 'live_', RANDOM)), ['stripe-live-key']);
  assert.deepEqual(rules(join2('re_', 'Ab3dE6gH', '_', RANDOM)), ['resend-key']);
  assert.deepEqual(rules(join2('0x4', 'AAAAAAA', RANDOM)), ['turnstile-secret']);
  assert.deepEqual(rules(join2('eyJ', 'hbGciOiJIUzI1', '.eyJ', 'zdWIiOiIxMjM0', '.', RANDOM)), ['jwt']);
  assert.deepEqual(rules(join2('-----BEGIN ', 'RSA PRIVATE KEY-----')), ['private-key']);
});

test('leaves the repository\'s deliberate placeholders alone', () => {
  assert.deepEqual(rules(`RESEND_API_KEY: '${join2('re_', 'placeholderNotARealKey')}'`), []);
  assert.deepEqual(rules(`const SITE_KEY = '${join2('0x4', 'AAAAAAA', '-not-a-real-site-key')}';`), []);
  assert.deepEqual(rules(`TURNSTILE_SECRET_KEY: '1x${'0'.repeat(33)}AA'`), []);
  assert.deepEqual(rules(join2('eyJ', '0eXAiOiJKV1QiLCJh', '.placeholderNotARealCredential')), []);
});

test('flags a literal credential assignment, not an expression or an environment reference', () => {
  assert.deepEqual(rules(`ADMIN_SECRET: '${RANDOM}'`), ['credential-assignment']);
  assert.deepEqual(rules(`LEMON_SQUEEZY_API_KEY=${RANDOM}`, '.env.staging'), ['credential-assignment']);
  assert.deepEqual(rules(`      LEMON_SQUEEZY_API_KEY: ${RANDOM}`, 'docker-compose.yml'), ['credential-assignment']);
  // Bare values in code are expressions.
  assert.deepEqual(rules('const NEW_PASSWORD = generateFixturePassword();'), []);
  assert.deepEqual(rules(`LEMON_SQUEEZY_API_KEY=${RANDOM}`, 'apps/x/file.ts'), []);
  // Environment references, shell defaults, described placeholders.
  assert.deepEqual(rules('RESEND_API_KEY: ${RESEND_API_KEY:-}', 'docker-compose.yml'), []);
  assert.deepEqual(rules('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-taktic_password}', 'docker-compose.yml'), []);
  assert.deepEqual(rules('# LEMON_SQUEEZY_API_KEY=<sandbox api key — never commit this>', '.env.example'), []);
  assert.deepEqual(rules("SECRET_FINGERPRINT = 'placeholder-fingerprint-key-not-a-secret-0001'"), []);
});

test('flags a long literal database password, not the local stack\'s', () => {
  assert.deepEqual(rules(`postgresql://taktic_user:${RANDOM}@db:5432/taktic`), ['database-url-password']);
  assert.deepEqual(rules('postgresql://taktic_user:taktic_password@localhost:5433/taktic'), []);
  assert.deepEqual(rules('postgresql://u:${POSTGRES_PASSWORD}@postgres:5432/taktic'), []);
});

test('never prints what it found', () => {
  const [finding] = scanText('x.ts', `ADMIN_SECRET: '${RANDOM}'`);
  assert.equal(finding.preview, `ADMIN_SECRET=${redact(RANDOM)}`);
  assert.ok(!JSON.stringify(finding).includes(RANDOM));
  assert.equal(redact(RANDOM), `${RANDOM.slice(0, 4)}… (${RANDOM.length} chars)`);
});

test('entropy separates generated values from repeated ones', () => {
  assert.ok(entropy(RANDOM) > 4);
  assert.ok(entropy('0'.repeat(32)) < 1);
});

test('scans files, skipping binaries and lockfiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  try {
    const text = join(dir, 'a.ts');
    const binary = join(dir, 'b.bin');
    writeFileSync(text, `const x = '${join2('Change', 'Me', '123', '!')}';\n`);
    writeFileSync(binary, Buffer.from([0, 1, 2, 0x41, 0x4b, 0x49, 0x41]));
    const { scanned, findings } = scanFiles([text, binary, join(dir, 'missing.ts'), 'pnpm-lock.yaml']);
    assert.equal(scanned, 1);
    assert.deepEqual(findings.map((finding) => [finding.line, finding.rule]), [[1, 'known-initial-password']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
