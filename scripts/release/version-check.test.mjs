// node --test scripts/release/version-check.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkVersion } from './version-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'version-check.mjs');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** A miniature of this repository's layout, consistent at `version`. */
function fixture(version = '1.2.3', { changelog } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'taktic-version-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  };
  write('package.json', { name: 'taktic', version, private: true });
  write('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n  # comment\n  - "e2e"\n');
  for (const dir of ['apps/web', 'apps/admin', 'packages/shared', 'e2e']) {
    write(`${dir}/package.json`, { name: `@taktic/${dir.split('/').pop()}`, version: '0.0.0', private: true });
  }
  write('apps/web/app/footer.tsx', 'export const v = process.env.TAKTIC_RELEASE_VERSION;\n');
  write('CHANGELOG.md', changelog ?? `# Changelog\n\n## Unreleased\n\n## ${version} - 2026-10-10\n\n- first\n`);
  return { root, write };
}

function gitInit(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return git;
}

test('a consistent tree passes', () => {
  const { root } = fixture();
  assert.deepEqual(checkVersion(root), { version: '1.2.3', failures: [] });
});

test('the root version must be MAJOR.MINOR.PATCH', () => {
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-rc.1', '', null]) {
    const { root, write } = fixture();
    write('package.json', bad === null ? { name: 'taktic', private: true } : { name: 'taktic', version: bad, private: true });
    const { failures } = checkVersion(root);
    assert.equal(failures.length, 1, String(bad));
    assert.match(failures[0], /MAJOR\.MINOR\.PATCH/);
  }
});

test('a workspace with a version of its own, or not private, fails', () => {
  const { root, write } = fixture();
  write('apps/admin/package.json', { name: '@taktic/admin', version: '1.2.3', private: true });
  write('e2e/package.json', { name: '@taktic/e2e', version: '0.0.0' });
  const { failures } = checkVersion(root);
  assert.equal(failures.length, 2);
  assert.match(failures.join('\n'), /apps\/admin\/package\.json: version must stay 0\.0\.0/);
  assert.match(failures.join('\n'), /e2e\/package\.json: must be private/);
});

test('the changelog needs Unreleased and a dated section for this version', () => {
  const missing = checkVersion(fixture('1.2.3', { changelog: '# Changelog\n\n## 1.2.2 - 2026-01-01\n' }).root).failures;
  assert.equal(missing.length, 2);
  assert.match(missing.join('\n'), /Unreleased/);
  assert.match(missing.join('\n'), /## 1\.2\.3 - YYYY-MM-DD/);
  const undated = checkVersion(fixture('1.2.3', { changelog: '## Unreleased\n\n## 1.2.3\n' }).root).failures;
  assert.equal(undated.length, 1);
});

test('an app that writes the version itself fails', () => {
  const { root, write } = fixture();
  write('apps/admin/components/footer.tsx', "export const label = 'Taktick v1.2.3';\n");
  write('apps/web/lib/version.ts', "export const VERSION = '1.2.3';\n");
  write('apps/web/app/ok.ts', "export const other = '11.2.3';\n");
  const { failures } = checkVersion(root);
  assert.equal(failures.length, 2, failures.join('\n'));
});

test('a tag must be exactly v<version> and annotated', () => {
  const { root } = fixture();
  assert.deepEqual(checkVersion(root, { tag: 'v1.2.3' }).failures, []);
  assert.match(checkVersion(root, { tag: 'v1.2.4' }).failures[0], /does not match package version 1\.2\.3/);

  const git = gitInit(root);
  git('tag', 'v1.2.3');
  assert.match(checkVersion(root).failures[0], /must be annotated/);
  git('tag', '-d', 'v1.2.3');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'tag', '-a', 'v1.2.3', '-m', 'Taktick v1.2.3');
  assert.deepEqual(checkVersion(root).failures, []);
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'tag', '-a', 'v9.9.9', '-m', 'wrong');
  assert.match(checkVersion(root).failures.join('\n'), /tag v9\.9\.9: does not match/);
});

test('the CLI prints the version, and exits 1 on a failure', () => {
  const { root, write } = fixture('2.0.0');
  const print = spawnSync(process.execPath, [SCRIPT, '--root', root, '--print'], { encoding: 'utf8' });
  assert.equal(print.status, 0);
  assert.equal(print.stdout, '2.0.0\n');
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'version-check: OK 2.0.0\n');
  write('apps/web/package.json', { name: '@taktic/web', version: '2.0.0', private: true });
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /version-check: 1 failure\(s\)/);
});

test('this repository is consistent', () => {
  const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const { failures } = checkVersion(REPO);
  assert.deepEqual(failures, []);
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
