// node --test .github/scripts/playwright-install.test.mjs
//
// playwright-install.sh against stand-ins for apt-get, dpkg and the Playwright
// CLI, under the real `timeout`: the cache paths (miss, hit, tampered, foreign
// files), a hung first attempt of each phase and the clean-up between the two
// attempts, a slow, a stalled and a failing mirror and the install-deps
// fallback, and every way the step must fail rather than pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./playwright-install.sh', import.meta.url));
const hasTimeout = spawnSync('timeout', ['--version']).status === 0;
const linuxOnly = { skip: hasTimeout && process.platform === 'linux' ? false : 'needs GNU timeout and stat (Linux)' };

const PACKAGES = ['fonts-unifont', 'libx264-164', 'xfonts-utils'];

// apt-get: update, --print-uris, --download-only and install, each able to
// hang once (a `hang-<phase>` file) the way a slow mirror or dpkg does.
const APT = `#!/usr/bin/env bash
set -u
S=$STUB_STATE
echo "apt-get $*" >>"$S/calls"
dir=; pkgs=(); mode=install; print=0; dl=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) [[ "$2" == Dir::Cache::Archives=* ]] && dir=\${2#*=}; shift 2; continue ;;
    -*) [ "$1" = --print-uris ] && print=1; [ "$1" = --download-only ] && dl=1; shift; continue ;;
    update) mode=update ;;
    install) ;;
    *) pkgs+=("$1") ;;
  esac
  shift
done
content() { printf 'deb:%s:%s\\n' "$1" "\${STUB_VERSION:-1.0}"; }
file() { echo "$1_\${STUB_VERSION:-1.0}_amd64.deb"; }
hang() { if [ -f "$S/hang-$1" ]; then rm "$S/hang-$1"; [ -n "\${2:-}" ] && eval "$2"; sleep 60; fi; }
if [ $mode = update ]; then hang update; exit 0; fi
if [ $print = 1 ]; then
  for p in "\${pkgs[@]}"; do c=$(content "$p"); printf "'http://mirror/%s' %s %s SHA256:%s\\n" "$(file "$p")" "$(file "$p")" "$(printf '%s' "$c" | wc -c | tr -d ' ')" "$(printf '%s' "$c" | sha256sum | cut -d' ' -f1)"; done
  exit 0
fi
if [ $dl = 1 ]; then
  hang download "printf half >'$dir/partial-file'"
  [ -f "$S/stall-download" ] && sleep 60
  [ -f "$S/fail-download" ] && { echo "E: Failed to fetch http://mirror/x  503" >&2; exit 100; }
  [ -f "$S/hashsum-download" ] && { echo "E: Failed to fetch http://mirror/x  Hash Sum mismatch" >&2; exit 100; }
  mkdir -p "$dir/partial"
  for p in "\${pkgs[@]}"; do
    f="$dir/$(file "$p")"
    [ -f "$f" ] && [ "$(cat "$f")" = "$(content "$p")" ] && continue
    [ -f "$S/extra-download" ] && printf 'x' >"$dir/stowaway_1.0_amd64.deb"
    if [ -f "$S/corrupt-download" ]; then printf 'tampered' >"$f"; else printf '%s' "$(content "$p")" >"$f"; fi
    echo "$p" >>"$S/downloaded"
    # A mirror that delivers one file per connection before it slows to nothing.
    [ -f "$S/slow-download" ] && sleep 60
  done
  exit 0
fi
hang install "touch '$S/half-configured'"
[ -f "$S/half-configured" ] && { echo "E: dpkg was interrupted, you must manually run 'dpkg --configure -a'" >&2; exit 100; }
for p in "\${pkgs[@]}"; do [ -f "$dir/$(file "$p")" ] || { echo "E: missing $p" >&2; exit 100; }; touch "$S/installed-$p"; done
`;

const DPKG = `#!/usr/bin/env bash
echo "dpkg $*" >>"$STUB_STATE/calls"
[[ "$*" == *"--configure -a"* ]] && rm -f "$STUB_STATE/half-configured"
exit 0
`;

// Playwright: --version, install-deps --dry-run (missing = needed − installed,
// exit 1 with its list, as Playwright prints it) and install <browser>.
const PW = `#!/usr/bin/env bash
S=$STUB_STATE
echo "playwright $*" >>"$S/calls"
case "$1" in
  --version) echo "Version \${STUB_PW_VERSION:-9.9.9}" ;;
  install-deps)
    if [ "$2" != --dry-run ]; then
      # The fallback: Playwright's own apt-get update && apt-get install.
      ls "\${PW_APT_SYSTEM_ARCHIVES}" >"$S/seeded" 2>/dev/null
      [ -f "$S/hang-fallback" ] && sleep 60
      [ -f "$S/broken-fallback" ] && { echo "E: Unable to fetch some archives" >&2; exit 1; }
      for p in $(cat "$S/needed"); do touch "$S/installed-$p"; done
      exit 0
    fi
    [ -f "$S/broken-dry-run" ] && { echo "Error: something else"; exit 3; }
    missing=()
    for p in $(cat "$S/needed"); do [ -f "$S/installed-$p" ] && [ ! -f "$S/never-installs" ] || missing+=("$p"); done
    if [ \${#missing[@]} -eq 0 ]; then echo "All system dependencies are installed."; exit 0; fi
    echo "Missing system dependencies (\${#missing[@]}):"; printf "\${STUB_INDENT:-  }%s\\n" "\${missing[@]}"; exit 1 ;;
  install)
    if [ -f "$S/hang-browser" ]; then rm "$S/hang-browser"; sleep 60; fi
    touch "$S/browser-$2" ;;
esac
`;

function setup({ needed = PACKAGES, flags = [], cached = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pw-install-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const debs = join(root, 'debs');
  const archives = join(root, 'archives');
  for (const d of [bin, state, debs]) mkdirSync(d, { recursive: true });
  for (const [name, body] of [['apt-get', APT], ['dpkg', DPKG], ['pw', PW], ['pkill', '#!/usr/bin/env bash\necho "pkill $*" >>"$STUB_STATE/calls"; exit 1\n'], ['sudo', '#!/usr/bin/env bash\nexec "$@"\n']]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(state, 'needed'), needed.join('\n') + (needed.length ? '\n' : ''));
  writeFileSync(join(state, 'calls'), '');
  for (const f of flags) writeFileSync(join(state, f), '');
  for (const [name, body] of Object.entries(cached)) writeFileSync(join(debs, name), body);
  return { root, bin, state, debs, archives };
}

function run(ctx, mode, env = {}) {
  const res = spawnSync('bash', [SCRIPT, mode, 'webkit'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH}`,
      STUB_STATE: ctx.state,
      PLAYWRIGHT_CLI: join(ctx.bin, 'pw'),
      PW_APT_CACHE_DIR: ctx.debs,
      PW_APT_SYSTEM_ARCHIVES: ctx.archives,
      PW_APT_SANDBOX_USER: '',
      PW_INSTALL_WORK_DIR: join(ctx.root, 'work'),
      PW_INSTALL_FIRST_ATTEMPT_TIMEOUT_SECONDS: '2',
      PW_INSTALL_TIMEOUT_SECONDS: '20',
      GITHUB_OUTPUT: join(ctx.root, 'output'),
      GITHUB_STEP_SUMMARY: join(ctx.root, 'summary'),
      ImageOS: 'ubuntu24',
      ImageVersion: '20261026.1',
      ...env,
    },
  });
  return { ...res, out: res.stdout + res.stderr };
}

const outputs = (ctx) =>
  Object.fromEntries(
    (existsSync(join(ctx.root, 'output')) ? readFileSync(join(ctx.root, 'output'), 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const calls = (ctx) => readFileSync(join(ctx.state, 'calls'), 'utf8');
const downloaded = (ctx) =>
  existsSync(join(ctx.state, 'downloaded')) ? readFileSync(join(ctx.state, 'downloaded'), 'utf8').split('\n').filter(Boolean) : [];
const installed = (ctx) => PACKAGES.filter((p) => existsSync(join(ctx.state, `installed-${p}`)));
const deb = (p, v = '1.0') => [`${p}_${v}_amd64.deb`, `deb:${p}:${v}`];
const fellBack = (ctx) => calls(ctx).split('\n').some((l) => /^playwright install-deps webkit$/.test(l));
const seeded = (ctx) =>
  existsSync(join(ctx.state, 'seeded')) ? readFileSync(join(ctx.state, 'seeded'), 'utf8').split('\n').filter(Boolean) : [];

function resolveAndInstall(ctx, env = {}) {
  const r = run(ctx, 'resolve', env);
  assert.equal(r.status, 0, r.out);
  return run(ctx, 'install', env);
}

test('cache miss: downloads every file, installs, and Playwright confirms nothing is missing', linuxOnly, () => {
  const ctx = setup();
  const r = run(ctx, 'resolve');
  assert.equal(r.status, 0, r.out);
  const o = outputs(ctx);
  assert.match(o.key, /^playwright-apt-webkit-ubuntu24-20261026\.1-pw9\.9\.9-[0-9a-f]{16}$/);
  assert.equal(o['restore-prefix'], 'playwright-apt-webkit-');
  assert.equal(o.packages, '3');
  assert.equal(o.dir, ctx.debs);

  const i = run(ctx, 'install', { PW_CACHE_RESULT: 'miss' });
  assert.equal(i.status, 0, i.out);
  assert.deepEqual(installed(ctx), PACKAGES);
  assert.deepEqual(downloaded(ctx).sort(), PACKAGES);
  assert.ok(existsSync(join(ctx.state, 'browser-webkit')));
  assert.match(i.out, /playwright-install install: browser=webkit cache=miss path=fast packages=3 files=3 from-cache=0 discarded=0 downloaded=3/);
  assert.equal(outputs(ctx).cacheable, 'true');
  assert.equal(fellBack(ctx), false);
  // What actions/cache/save stores: the manifest's files and nothing else.
  assert.deepEqual(readdirSync(ctx.debs).sort(), PACKAGES.map((p) => deb(p)[0]).sort());
  assert.match(readFileSync(join(ctx.root, 'summary'), 'utf8'), /\| miss \| fast \| 3 \| 0 \/ 3 \| 0 \|/);
});

test('the key changes with a package version, the runner image and the Playwright version', linuxOnly, () => {
  const keyFor = (env) => {
    const ctx = setup();
    assert.equal(run(ctx, 'resolve', env).status, 0);
    return outputs(ctx).key;
  };
  const base = keyFor({});
  assert.notEqual(keyFor({ STUB_VERSION: '1.1' }), base);
  assert.notEqual(keyFor({ ImageVersion: '20261102.1' }), base);
  assert.notEqual(keyFor({ STUB_PW_VERSION: '9.9.10' }), base);
  assert.equal(keyFor({}), base);
});

test('exact cache hit: every file is verified and nothing is downloaded', linuxOnly, () => {
  const ctx = setup({ cached: Object.fromEntries(PACKAGES.map((p) => deb(p))) });
  const i = resolveAndInstall(ctx, { PW_CACHE_RESULT: 'exact' });
  assert.equal(i.status, 0, i.out);
  assert.deepEqual(downloaded(ctx), []);
  assert.deepEqual(installed(ctx), PACKAGES);
  assert.match(i.out, /cache=exact path=fast packages=3 files=3 from-cache=3 discarded=0 downloaded=0/);
});

test('a cached file whose content differs from the package index is discarded, reported and fetched again', linuxOnly, () => {
  const [name] = deb('libx264-164');
  const ctx = setup({ cached: { ...Object.fromEntries(PACKAGES.map((p) => deb(p))), [name]: 'deb:libx264-164:1.0' + 'X' } });
  const i = resolveAndInstall(ctx, { PW_CACHE_RESULT: 'exact' });
  assert.equal(i.status, 0, i.out);
  assert.match(i.out, /::warning::playwright-install: cached libx264-164_1\.0_amd64\.deb does not match the package index; discarded/);
  assert.deepEqual(downloaded(ctx), ['libx264-164']);
  assert.equal(readFileSync(join(ctx.debs, name), 'utf8'), 'deb:libx264-164:1.0');
  assert.match(i.out, /from-cache=2 discarded=1 downloaded=1/);
});

test('files the manifest does not list (an older version, anything else) are deleted, never installed', linuxOnly, () => {
  const ctx = setup({ cached: { [deb('fonts-unifont', '0.9')[0]]: 'old', 'evil.sh': 'rm -rf /' } });
  const i = resolveAndInstall(ctx, { PW_CACHE_RESULT: 'partial' });
  assert.equal(i.status, 0, i.out);
  assert.ok(!existsSync(join(ctx.debs, 'evil.sh')));
  assert.ok(!existsSync(join(ctx.debs, deb('fonts-unifont', '0.9')[0])));
  assert.match(i.out, /from-cache=0 discarded=2 downloaded=3/);
});

for (const phase of ['update', 'download', 'install', 'browser']) {
  test(`a hung first ${phase} attempt times out, is cleaned up, and the retry completes the install`, linuxOnly, () => {
    const ctx = setup({ flags: [`hang-${phase}`] });
    const r = run(ctx, 'resolve');
    assert.equal(r.status, 0, r.out);
    const i = run(ctx, 'install');
    const out = r.out + i.out;
    assert.equal(i.status, 0, out);
    const label = phase === 'update' ? 'apt-get update' : phase;
    // A download attempt that brought something is resumed, not "retried".
    const warning = phase === 'download' ? 'download timed out after 2s with 4 bytes new \\(0 of 3 files\\); resuming' : `${label} timed out after 2s; retrying once`;
    assert.match(out, new RegExp(`::warning::playwright-install: ${warning}`));
    assert.match(out, new RegExp(`${label.replace(' ', ' ')}=\\d+s#2`));
    // The clean-up ran between the attempts, and nothing it left behind
    // reached dpkg: every file is the index's, every package is installed.
    assert.match(calls(ctx), /dpkg --force-confdef --force-confold --configure -a/);
    assert.deepEqual(installed(ctx), PACKAGES);
    assert.ok(!existsSync(join(ctx.debs, 'partial-file')));
    assert.ok(!existsSync(join(ctx.state, 'half-configured')));
    assert.equal(fellBack(ctx), false);
  });
}

test('a dpkg phase that fails on its retry too fails the step, with no fallback', linuxOnly, () => {
  // The clean-up between the attempts re-arms the hang, so the retry hangs too.
  const ctx = setup({ flags: ['hang-install'] });
  writeFileSync(join(ctx.bin, 'dpkg'), '#!/usr/bin/env bash\necho "dpkg $*" >>"$STUB_STATE/calls"\nrm -f "$STUB_STATE/half-configured"; touch "$STUB_STATE/hang-install"\n');
  assert.equal(run(ctx, 'resolve').status, 0);
  const i = run(ctx, 'install', { PW_INSTALL_TIMEOUT_SECONDS: '2' });
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /::error::playwright-install: install failed on its retry too \(exit 124\)/);
  assert.deepEqual(installed(ctx), []);
  assert.equal(fellBack(ctx), false);
});

// ── a slow, stalled or failing mirror ───────────────────────────────────────

const quick = { PW_INSTALL_TIMEOUT_SECONDS: '2', PW_FALLBACK_TIMEOUT_SECONDS: '20' };

test('a slow mirror that keeps delivering is resumed attempt after attempt and stays on the fast path', linuxOnly, () => {
  const ctx = setup({ flags: ['slow-download'] });
  const i = resolveAndInstall(ctx, quick);
  assert.equal(i.status, 0, i.out);
  assert.equal((i.out.match(/download timed out after 2s with \d+ bytes new \(\d of 3 files\); resuming/g) ?? []).length, 3);
  assert.match(i.out, /download=\d+s#4/);
  assert.deepEqual(installed(ctx), PACKAGES);
  assert.equal(fellBack(ctx), false);
  assert.equal(outputs(ctx).cacheable, 'true');
  assert.equal(outputs(ctx).path, 'fast');
});

test('a stalled download falls back to install-deps, handing over only the files it verified', linuxOnly, () => {
  const [good, goodBody] = deb('fonts-unifont');
  const ctx = setup({ flags: ['stall-download'], cached: { [good]: goodBody, [deb('libx264-164')[0]]: 'tampered' } });
  const i = resolveAndInstall(ctx, quick);
  assert.equal(i.status, 0, i.out);
  assert.match(i.out, /::warning::playwright-install: the download stalled: attempt 1 brought nothing in 2s; falling back to Playwright's install-deps/);
  assert.ok(fellBack(ctx));
  assert.deepEqual(seeded(ctx), [good]);
  assert.equal(readFileSync(join(ctx.archives, good), 'utf8'), goodBody);
  // The fallback did the install; the final check still decides, and the
  // incomplete directory is never offered to the cache.
  assert.deepEqual(installed(ctx), PACKAGES);
  assert.ok(existsSync(join(ctx.state, 'browser-webkit')));
  assert.equal(outputs(ctx).cacheable, 'false');
  assert.equal(outputs(ctx).path, 'fallback');
  assert.match(i.out, /playwright-install install: browser=webkit cache=none path=fallback .* fallback=\d+s#1/);
});

test('an apt error on the download is retried once, then falls back', linuxOnly, () => {
  const ctx = setup({ flags: ['fail-download'] });
  const i = resolveAndInstall(ctx, quick);
  assert.equal(i.status, 0, i.out);
  assert.match(i.out, /::warning::playwright-install: download exited 100; retrying once/);
  assert.match(i.out, /apt-get failed to download a second time \(exit 100\); falling back/);
  assert.ok(fellBack(ctx));
  assert.equal(outputs(ctx).cacheable, 'false');
});

test('a mirror too slow for the download budget falls back once the budget is spent', linuxOnly, () => {
  const ctx = setup({ flags: ['slow-download'] });
  const i = resolveAndInstall(ctx, { ...quick, PW_DOWNLOAD_BUDGET_SECONDS: '3' });
  assert.equal(i.status, 0, i.out);
  assert.match(i.out, /the download budget of 3s is spent \(\d of 3 files here\); falling back/);
  assert.ok(fellBack(ctx));
  assert.deepEqual(installed(ctx), PACKAGES);
});

test('a fallback that fails fails the step', linuxOnly, () => {
  const ctx = setup({ flags: ['stall-download', 'broken-fallback'] });
  const i = resolveAndInstall(ctx, quick);
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /::error::playwright-install: the install-deps fallback failed too \(exit 1, limit 20s\)/);
  assert.ok(!existsSync(join(ctx.state, 'browser-webkit')));
});

test('a fallback that hangs is bounded by its own timeout', linuxOnly, () => {
  const ctx = setup({ flags: ['stall-download', 'hang-fallback'] });
  const i = resolveAndInstall(ctx, { ...quick, PW_FALLBACK_TIMEOUT_SECONDS: '2' });
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /the install-deps fallback failed too \(exit 124, limit 2s\)/);
});

test('even after the fallback, a dependency Playwright still reports missing fails the step', linuxOnly, () => {
  const ctx = setup({ flags: ['stall-download', 'never-installs'] });
  const i = resolveAndInstall(ctx, quick);
  assert.notEqual(i.status, 0, i.out);
  assert.ok(fellBack(ctx));
  assert.match(i.out, /Playwright still reports missing system dependencies for webkit/);
});

test('apt rejecting a download for its hash fails the step at once, with no retry and no fallback', linuxOnly, () => {
  const ctx = setup({ flags: ['hashsum-download'] });
  const i = resolveAndInstall(ctx, quick);
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /::error::playwright-install: apt rejected a download whose hash does not match the signed index; not falling back/);
  assert.equal(calls(ctx).split('\n').filter((l) => /--download-only/.test(l)).length, 1);
  assert.equal(fellBack(ctx), false);
  assert.deepEqual(installed(ctx), []);
});

test('prefetch never falls back: a stalled download fails it and leaves nothing to cache', linuxOnly, () => {
  const ctx = setup({ flags: ['stall-download'] });
  assert.equal(run(ctx, 'resolve').status, 0);
  const p = run(ctx, 'prefetch', quick);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, /::error::playwright-install: the download stalled: attempt 1 brought nothing in 2s; nothing to cache/);
  assert.equal(fellBack(ctx), false);
  assert.deepEqual(installed(ctx), []);
});

test('a download that does not match the package index stops before dpkg', linuxOnly, () => {
  const ctx = setup({ flags: ['corrupt-download'] });
  const i = resolveAndInstall(ctx);
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /::error::playwright-install: fonts-unifont_1\.0_amd64\.deb is missing or does not match the package index/);
  assert.deepEqual(installed(ctx), []);
  const dpkgInstalls = calls(ctx).split('\n').filter((l) => / install /.test(l) && !/--download-only|--print-uris/.test(l));
  assert.deepEqual(dpkgInstalls, []);
  // A disagreement with the package index is not a slow mirror: no fallback.
  assert.equal(fellBack(ctx), false);
});

test('the step fails if Playwright still reports a missing dependency after the install', linuxOnly, () => {
  const ctx = setup({ flags: ['never-installs'] });
  const i = resolveAndInstall(ctx);
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /::error::playwright-install: Playwright still reports missing system dependencies for webkit/);
});

test('a dependency list Playwright worded differently fails, rather than reading as nothing missing', linuxOnly, () => {
  const ctx = setup();
  const r = run(ctx, 'resolve', { STUB_INDENT: '    ' });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /::error::playwright-install: Playwright announced 3 missing packages but 0 could be read/);
});

test('the final check fails the same way if the list it gets back cannot be read', linuxOnly, () => {
  const ctx = setup({ flags: ['never-installs'] });
  assert.equal(run(ctx, 'resolve').status, 0);
  const i = run(ctx, 'install', { STUB_INDENT: '\t' });
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /announced 3 missing packages but 0 could be read/);
});

test('hidden files in the cache are verified like any other and discarded', linuxOnly, () => {
  const ctx = setup({ cached: { '.hidden': 'x' } });
  const i = resolveAndInstall(ctx);
  assert.equal(i.status, 0, i.out);
  assert.ok(!existsSync(join(ctx.debs, '.hidden')));
  assert.match(i.out, /discarded=1/);
});

test('nothing missing: no apt work, no files, the browser still installed and checked', linuxOnly, () => {
  const ctx = setup({ needed: [] });
  const i = resolveAndInstall(ctx, { PW_CACHE_RESULT: 'miss' });
  assert.equal(i.status, 0, i.out);
  assert.equal(outputs(ctx).packages, '0');
  assert.doesNotMatch(calls(ctx), /--download-only|--print-uris/);
  assert.ok(existsSync(join(ctx.state, 'browser-webkit')));
  assert.match(i.out, /packages=0 files=0/);
});

test("an unreadable dependency check fails resolve instead of installing nothing", linuxOnly, () => {
  const ctx = setup({ flags: ['broken-dry-run'] });
  const r = run(ctx, 'resolve');
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /::error::playwright-install: could not read Playwright's dependency check \(exit 3\)/);
});

test('prefetch (main): verified files for the cache, nothing installed, no browser', linuxOnly, () => {
  const ctx = setup({ cached: { [deb('fonts-unifont')[0]]: deb('fonts-unifont')[1], 'evil.sh': 'x' } });
  assert.equal(run(ctx, 'resolve').status, 0);
  const p = run(ctx, 'prefetch', { PW_CACHE_RESULT: 'partial' });
  assert.equal(p.status, 0, p.out);
  assert.deepEqual(installed(ctx), []);
  assert.ok(!existsSync(join(ctx.state, 'browser-webkit')));
  assert.deepEqual(readdirSync(ctx.debs).sort(), PACKAGES.map((x) => deb(x)[0]).sort());
  assert.match(p.out, /playwright-install prefetch: browser=webkit cache=partial path=fast packages=3 files=3 from-cache=1 discarded=1 downloaded=2/);
});

test('install without resolve fails', linuxOnly, () => {
  const ctx = setup();
  const i = run(ctx, 'install');
  assert.notEqual(i.status, 0);
  assert.match(i.out, /run 'resolve webkit' first/);
});

test('install after a resolve that failed half-way fails, rather than installing unverified packages', linuxOnly, () => {
  const ctx = setup();
  // apt answers --print-uris without a SHA256 (what it does unless forced).
  writeFileSync(join(ctx.bin, 'apt-get'), APT.replace('SHA256:%s', 'MD5Sum:%s'));
  chmodSync(join(ctx.bin, 'apt-get'), 0o755);
  const r = run(ctx, 'resolve');
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /apt listed no files with a SHA256/);
  const i = run(ctx, 'install');
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /run 'resolve webkit' first \(or it did not finish\)/);
  assert.deepEqual(installed(ctx), []);
});

test('a file apt fetched that the manifest does not list stops before dpkg', linuxOnly, () => {
  const ctx = setup({ flags: ['extra-download'] });
  const i = resolveAndInstall(ctx);
  assert.notEqual(i.status, 0, i.out);
  assert.match(i.out, /stowaway_1\.0_amd64\.deb was downloaded but is not in the manifest/);
  assert.deepEqual(installed(ctx), []);
  assert.equal(fellBack(ctx), false);
});

test('every apt call verifies by SHA256', linuxOnly, () => {
  const ctx = setup();
  assert.equal(resolveAndInstall(ctx).status, 0);
  const apt = calls(ctx).split('\n').filter((l) => l.startsWith('apt-get'));
  assert.ok(apt.length >= 4);
  for (const l of apt) assert.match(l, /-o Acquire::ForceHash=SHA256/);
});

test('an unknown browser is refused', () => {
  const r = spawnSync('bash', [SCRIPT, 'resolve', 'firefox'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
