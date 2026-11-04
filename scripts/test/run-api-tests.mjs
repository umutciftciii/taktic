// `pnpm test:api` (CI-PERF-005): the whole API suite on this machine, in
// parallel, against a PostgreSQL nobody else can reach and nothing outlives.
//
// One run owns one container: a unique name and run-id label, a port Docker
// picks on 127.0.0.1, the data directory on a 2 GiB tmpfs. Each shard is one
// Vitest process with its own database, its own process group and its own log.
// The suite is run as it is — no retry, no timeout changed — and a run is green
// only when every shard exited 0, every spec file ran exactly once (the same
// check CI's shard-coverage applies) and no shard's connection was seen in
// another shard's database.
//
// Everything this removes it first identifies by label, never by name, and
// nothing here ever addresses the development stack. The analysis and the
// measurements are in docs/superpowers/specs/2026-11-04-ci-perf-005-local-api-test-runner.md.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { apiSpecFiles, checkVitest } from '../../.github/scripts/shard-coverage.mjs';
import {
  BASE_DB, DATA_DIR, DB_USER, DURATIONS_FILE, IMAGE, KIND, LABELS, SERVER_SETTINGS, TMPFS_MB, USAGE,
  buildApiPlan, checkMount, checkPlanned, checkSettings, databaseCrossings, databaseUrl, formatSummary, parseArgs,
  parsePublishedPort, reportFailures, shardDatabase, shardEnv, staleVerdict,
} from './api-test-plan.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const READY_TIMEOUT_MS = 60_000;
// Not a test timeout: what stops a hung run from holding a container forever.
const RUN_LIMIT_MS = 30 * 60_000;
const DOCKER_TIMEOUT_MS = 30_000;
// An image pull is part of `docker run`.
const DOCKER_RUN_TIMEOUT_MS = 10 * 60_000;
const STOP_GRACE_MS = 5_000;
const SAMPLE_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const startedAt = Date.now();
const runId = `${new Date(startedAt).toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${randomBytes(3).toString('hex')}`;
const containerName = `taktic-api-test-${runId}`;

// Everything this run has started and must stop.
const groups = new Set();
const inflight = new Set();
let port = null;
let stopping = false;
// Nothing to clean until a container may exist.
let cleaned = true;
let abortReason = null;

const say = (line) => process.stdout.write(`[test:api] ${line}\n`);

// Detached, so that Ctrl-C in the terminal reaches the runner alone: a `docker
// run` interrupted by the same keystroke could leave a container nobody has seen.
function capture(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, timeout: DOCKER_TIMEOUT_MS, killSignal: 'SIGKILL', ...options });
    inflight.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const finish = (code) => { inflight.delete(child); done({ code, stdout, stderr }); };
    child.on('error', (e) => { stderr += e.message; finish(127); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

const docker = (...args) => capture('docker', args);

/**
 * When the process holding this pid started: null when none does, undefined when
 * `ps` could not say. A reused pid shows a different time. Pinned to one locale and
 * zone, because `lstart` is local time and two shells comparing it may differ.
 */
function processStart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 10_000 });
  if (r.error) return undefined;
  if (r.status === 0) return r.stdout.trim() || undefined;
  return r.status === 1 && r.stdout.trim() === '' ? null : undefined;
}

// ── containers ───────────────────────────────────────────────────────────────

const clientBackendsSql = "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()";
const psql = (id, database, sql) => docker('exec', id, 'psql', '-v', 'ON_ERROR_STOP=1', '-tA', '-U', DB_USER, '-d', database, '-c', sql);

async function countClients(id) {
  const samples = [];
  // Twice, apart: a run whose owner was killed outright can still have shards
  // finishing, and between two files a shard holds no connection at all.
  for (const wait of [0, 3000]) {
    await sleep(wait);
    const r = await psql(id, 'postgres', clientBackendsSql);
    if (r.code !== 0 || !/^[0-9]+$/.test(r.stdout.trim())) return null;
    samples.push(Number(r.stdout.trim()));
  }
  return samples;
}

/** Removes only what an ended run of this runner left behind. See staleVerdict. */
async function sweepStale() {
  const listed = await docker('ps', '-a', '--filter', `label=${LABELS.kind}=${KIND}`, '--format', '{{.ID}}');
  if (listed.code !== 0) throw new Error(`docker ps failed: ${listed.stderr.trim()}`);
  const ids = listed.stdout.split('\n').filter(Boolean);
  if (ids.length === 0) return;
  const inspected = await docker('inspect', ...ids);
  if (inspected.code !== 0) { say(`leaving ${ids.length} earlier container(s): could not inspect them`); return; }
  for (const c of JSON.parse(inspected.stdout)) {
    const labels = c.Config?.Labels ?? {};
    const running = c.State?.Running === true;
    const name = (c.Name ?? c.Id).replace(/^\//, '');
    const ownerPid = Number(labels[LABELS.pid]);
    const verdict = staleVerdict({
      labels,
      running,
      hostname: hostname(),
      ownerStarted: Number.isInteger(ownerPid) && ownerPid > 0 ? processStart(ownerPid) : undefined,
      clientBackends: running ? await countClients(c.Id) : [],
    });
    if (!verdict.remove) { say(`leaving ${name}: ${verdict.reason} (if it is yours: docker rm -fv ${name})`); continue; }
    const removed = await docker('rm', '-fv', c.Id);
    say(removed.code === 0 ? `removed ${name}: ${verdict.reason}` : `could not remove ${name}: ${removed.stderr.trim()}`);
  }
}

async function startContainer(password, started) {
  const labels = { [LABELS.kind]: KIND, [LABELS.run]: runId, [LABELS.pid]: process.pid, [LABELS.pidStart]: started, [LABELS.host]: hostname() };
  const args = [
    'run', '-d', '--name', containerName,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    // Docker picks a free port as it binds, so no other process can take it in
    // between, and two runs can not pick the same one.
    '-p', '127.0.0.1::5432',
    '--tmpfs', `${DATA_DIR}:rw,size=${TMPFS_MB}m`,
    '-e', `POSTGRES_USER=${DB_USER}`, '-e', `POSTGRES_DB=${BASE_DB}`,
    // By name only, so the value never appears in a process listing.
    '-e', 'POSTGRES_PASSWORD',
    IMAGE,
    ...Object.entries(SERVER_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`]),
  ];
  const r = await capture('docker', args, { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: DOCKER_RUN_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`the container did not start: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function canConnect(targetPort) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: targetPort });
    socket.setTimeout(1000);
    const finish = (ok) => { socket.destroy(); done(ok); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForServer(id) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await docker('inspect', '-f', '{{.State.Running}}', id);
    if (state.stdout.trim() !== 'true') {
      const logs = await docker('logs', '--tail', '20', id);
      throw new Error(`the container stopped while starting:\n${logs.stdout}${logs.stderr}`);
    }
    // Over TCP on purpose: the image's first boot runs a temporary server that
    // listens on the socket alone and then stops, so the socket says "ready" early.
    const ready = await docker('exec', id, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', DB_USER, '-d', BASE_DB);
    if (ready.code === 0 && (await canConnect(port))) return;
    await sleep(250);
  }
  throw new Error(`PostgreSQL was not ready after ${READY_TIMEOUT_MS / 1000} s`);
}

/** Reads back what the run relies on. A container that is not what was asked for runs nothing. */
async function verifyContainer(id) {
  const mount = await docker('exec', id, 'awk', `$2 == "${DATA_DIR}" { print $3, $4 }`, '/proc/mounts');
  const names = Object.keys(SERVER_SETTINGS).map((n) => `'${n}'`).join(', ');
  const settings = await psql(id, 'postgres', `SELECT name || '=' || setting FROM pg_settings WHERE name IN (${names})`);
  const problems = [...checkMount(mount.stdout), ...(settings.code === 0 ? checkSettings(settings.stdout) : [`settings: ${settings.stderr.trim()}`])];
  if (problems.length > 0) throw new Error(`the container is not what this run asked for: ${problems.join('; ')}`);
}

/** Every container carrying this run's id, the only ones this run may remove. */
function ownContainersSync() {
  const r = spawnSync('docker', ['ps', '-a', '--filter', `label=${LABELS.run}=${runId}`, '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 15_000, detached: true });
  return r.status === 0 ? { ids: r.stdout.split('\n').filter(Boolean) } : { error: r.stderr?.trim() || 'docker ps failed' };
}

// ── processes ────────────────────────────────────────────────────────────────

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function signalGroups(signal) {
  for (const pgid of groups) {
    if (!groupAlive(pgid)) { groups.delete(pgid); continue; }
    try { process.kill(-pgid, signal); } catch {}
  }
}

async function stopGroups() {
  signalGroups('SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && [...groups].some(groupAlive)) await sleep(100);
  signalGroups('SIGKILL');
}

// Synchronous, so that it can also run from the 'exit' event. Safe to repeat.
// Answers with what it could not remove. Detached, so a second Ctrl-C can not
// kill these two commands halfway.
function removeEverythingSync() {
  signalGroups('SIGKILL');
  cleaned = true;
  const own = ownContainersSync();
  if (own.error) return [`could not list this run's container: ${own.error}; look for label ${LABELS.run}=${runId}`];
  if (own.ids.length > 0) spawnSync('docker', ['rm', '-fv', ...own.ids], { stdio: 'ignore', timeout: 60_000, detached: true });
  const left = ownContainersSync();
  if (left.error) return [`could not confirm the container is gone: ${left.error}`];
  return left.ids.map((id) => `container still present: docker rm -fv ${id}`);
}

async function interrupted(signal) {
  if (stopping) { signalGroups('SIGKILL'); return; }
  stopping = true;
  abortReason = signal;
  say(`${signal}: stopping this run's shards and removing its container`);
  await stopGroups();
  // A `docker run` in flight may still be creating the container: let it answer
  // first, so the label search sees what it made. If it will not (a long image
  // pull), stop it and look again a moment later, in case the daemon was mid-create.
  const wait = async (ms) => {
    const deadline = Date.now() + ms;
    while (inflight.size > 0 && Date.now() < deadline) await sleep(50);
  };
  await wait(STOP_GRACE_MS);
  const cutShort = inflight.size > 0;
  for (const child of inflight) child.kill('SIGKILL');
  await wait(1000);
  let problems = removeEverythingSync();
  if (cutShort) {
    await sleep(2000);
    problems = removeEverythingSync();
  }
  for (const p of problems) say(p);
  process.exit(SIGNAL_EXIT[signal]);
}

// ── shards ───────────────────────────────────────────────────────────────────

function runShard(shard, port, password, reportDir) {
  const jsonPath = join(reportDir, `shard-${shard.index}.json`);
  const logPath = join(reportDir, `shard-${shard.index}.log`);
  const log = openSync(logPath, 'w');
  return new Promise((done) => {
    // Its own process group: Vitest forks workers and global setup runs Prisma,
    // and the group is what reaches all of them at once.
    const child = spawn('pnpm', [
      '--filter', '@taktic/api', 'exec', 'vitest', 'run',
      '--reporter=default', '--reporter=json', `--outputFile.json=${jsonPath}`,
      ...shard.files,
    ], { cwd: repoRoot, env: shardEnv(process.env, { databaseUrl: databaseUrl(port, password, shard.index), index: shard.index }), detached: true, stdio: ['ignore', log, log] });
    groups.add(child.pid);
    const started = Date.now();
    let finished = false;
    const finish = (exit) => {
      // A process that could not start emits both 'error' and 'close'.
      if (finished) return;
      finished = true;
      closeSync(log);
      if (!groupAlive(child.pid)) groups.delete(child.pid);
      if (!stopping) say(`shard ${shard.index} finished: exit ${exit}, ${Math.round((Date.now() - started) / 1000)} s`);
      done({ index: shard.index, exit, logPath, jsonPath });
    };
    child.on('error', (e) => { say(`shard ${shard.index} did not start: ${e.message}`); groups.delete(child.pid); finish(127); });
    child.on('close', (code, signal) => finish(code ?? signal ?? 1));
  });
}

function filesDone(logPath) {
  try {
    return (readFileSync(logPath, 'utf8').match(/^\s*[✓❯×]\s+test\/\S+\.spec\.ts/gm) ?? []).length;
  } catch {
    return 0;
  }
}

/** Keeps peaks, and notices the container dying. A failed sample only loses that sample. */
function startSampler(id, memory, databasesSeen) {
  let busy = false;
  const toMb = (text) => {
    const m = /^([0-9.]+)\s*([KMG]i?B|B)/.exec(text.trim());
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ B: 1 / 1048576, KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 })[m[2]]);
  };
  const peak = (key, value) => { if (Number.isFinite(value)) memory[key] = Math.max(memory[key] ?? 0, value); };
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const [state, stats, df, ps, activity] = await Promise.all([
      docker('inspect', '-f', '{{.State.Running}}', id),
      docker('stats', '--no-stream', '--format', '{{.MemUsage}}', id),
      docker('exec', id, 'df', '-k', DATA_DIR),
      capture('ps', ['-A', '-o', 'pgid=', '-o', 'rss=']),
      psql(id, 'postgres', "SELECT DISTINCT application_name || '|' || datname FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND datname IS NOT NULL"),
    ]);
    if (activity.code === 0) for (const pair of activity.stdout.split('\n').filter(Boolean)) databasesSeen.add(pair);
    if (!stopping && state.code === 0 && state.stdout.trim() !== 'true') {
      abortReason = 'the PostgreSQL container stopped during the run';
      say(abortReason);
      stopGroups();
    }
    if (stats.code === 0) peak('containerMb', toMb(stats.stdout));
    const used = /\s([0-9]+)\s+[0-9]+\s+[0-9]+%/.exec(df.stdout);
    if (df.code === 0 && used) peak('tmpfsMb', Math.round(Number(used[1]) / 1024));
    if (ps.code === 0) {
      let kb = 0;
      for (const line of ps.stdout.split('\n')) {
        const [pgid, rss] = line.trim().split(/\s+/).map(Number);
        if (groups.has(pgid)) kb += rss;
      }
      if (kb > 0) peak('processesMb', Math.round(kb / 1024));
    }
    busy = false;
  }, SAMPLE_MS);
  return () => clearInterval(timer);
}

// ── after the shards ─────────────────────────────────────────────────────────

/** The databases the run should have made, nothing else on the server, and not one row in the base database. */
async function databaseProblems(id, count) {
  const q = await psql(id, 'postgres', 'SELECT datname FROM pg_database WHERE NOT datistemplate');
  if (q.code !== 0) return [`could not list the databases: ${q.stderr.trim()}`];
  const present = q.stdout.split('\n').filter(Boolean);
  const problems = [];
  const allowed = new Set(['postgres', BASE_DB]);
  for (let i = 1; i <= count; i += 1) {
    const name = shardDatabase(i);
    allowed.add(name);
    allowed.add(`${name.slice(0, -'_test'.length)}_m1_test`);
    if (!present.includes(name)) problems.push(`${name} was never created`);
  }
  for (const name of present) if (!allowed.has(name)) problems.push(`unexpected database ${name}`);
  const written = await psql(id, 'postgres', `SELECT tup_inserted + tup_updated + tup_deleted FROM pg_stat_database WHERE datname = '${BASE_DB}'`);
  if (written.code !== 0 || written.stdout.trim() !== '0') problems.push(`rows were written to the base database ${BASE_DB}: ${written.stdout.trim() || written.stderr.trim()}`);
  return problems;
}

/** The suite's own startup line is the evidence of which database and reset each shard used. */
function logProblems(results) {
  const problems = [];
  for (const r of results) {
    const log = existsSync(r.logPath) ? readFileSync(r.logPath, 'utf8') : '';
    if (!log.includes(`database "${shardDatabase(r.index)}"`)) problems.push(`shard ${r.index} never reported using ${shardDatabase(r.index)}`);
    if (!/\[api-test\] database .*reset: delete\)/.test(log)) problems.push(`shard ${r.index} did not report the delete reset`);
  }
  return problems;
}

function networkErrors(results) {
  const counts = { ETIMEDOUT: 0, ECONNRESET: 0, ECONNREFUSED: 0 };
  for (const r of results) {
    const log = existsSync(r.logPath) ? readFileSync(r.logPath, 'utf8') : '';
    for (const name of Object.keys(counts)) counts[name] += log.split(name).length - 1;
  }
  return counts;
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Removes the container, then confirms the container, the processes and the port are gone. */
async function cleanUp() {
  await stopGroups();
  const problems = removeEverythingSync();
  const left = [...groups].filter(groupAlive);
  if (left.length > 0) problems.push(`process groups still alive: ${left.join(', ')}`);
  if (port !== null) {
    const deadline = Date.now() + STOP_GRACE_MS;
    while ((await canConnect(port)) && Date.now() < deadline) await sleep(200);
    if (await canConnect(port)) problems.push(`port ${port} still answers`);
  }
  return problems;
}

/** Vitest would run a stale client and fail in ways that look like the code's fault. */
function preflight() {
  const require = createRequire(join(repoRoot, 'apps/api/package.json'));
  let generated;
  try {
    generated = join(dirname(require.resolve('@prisma/client')), '../../.prisma/client/schema.prisma');
  } catch {
    throw new Error('dependencies are not installed: run `pnpm install --frozen-lockfile`');
  }
  // Without whitespace: `prisma generate` realigns the copy it keeps.
  const schema = (path) => readFileSync(path, 'utf8').replace(/\s+/g, '');
  if (!existsSync(generated) || schema(generated) !== schema(join(repoRoot, 'prisma/schema.prisma'))) {
    throw new Error('the Prisma client does not match prisma/schema.prisma: run `pnpm db:generate`');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return 0; }

  const specFiles = apiSpecFiles();
  const durations = existsSync(DURATIONS_FILE) ? readFileSync(DURATIONS_FILE, 'utf8') : undefined;
  const plan = buildApiPlan(specFiles, durations, options.shards);
  if (plan.fallback) say(`warning: planning by file count: ${plan.fallback}`);
  if (plan.estimated.length) say(`${plan.estimated.length} file(s) have no history and were estimated`);
  for (const s of plan.shards) say(`shard ${s.index}/${plan.count}: ${s.files.length} files, ~${Math.round(s.ms / 1000)} s planned`);
  if (options.dryRun) return 0;

  preflight();
  const reportDir = join(resolve(options.reportDir ?? join(repoRoot, 'apps/api/reports/test-api')), runId);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

  const daemon = await docker('version', '--format', '{{.Server.Version}}');
  if (daemon.code !== 0) throw new Error(`Docker is not reachable: ${daemon.stderr.trim()}`);
  // Before the sweep: a machine where this fails could not judge anyone's container.
  const started = processStart(process.pid);
  if (!started) throw new Error('`ps` could not say when this process started');
  await sweepStale();

  const password = randomBytes(16).toString('hex');
  cleaned = false;
  const id = await startContainer(password, started);
  const published = await docker('port', id, '5432/tcp');
  if (published.code !== 0) throw new Error(`could not read the published port: ${published.stderr.trim()}`);
  port = parsePublishedPort(published.stdout);
  await waitForServer(id);
  await verifyContainer(id);
  const containerSeconds = Math.round((Date.now() - startedAt) / 1000);
  say(`container ${containerName} on 127.0.0.1:${port}, ready in ${containerSeconds} s; report in ${reportDir}`);

  const memory = {};
  const databasesSeen = new Set();
  const stopSampler = startSampler(id, memory, databasesSeen);
  const testsStarted = Date.now();
  const limit = setTimeout(() => {
    abortReason = `the run passed its ${RUN_LIMIT_MS / 60_000}-minute limit`;
    say(abortReason);
    stopGroups();
  }, RUN_LIMIT_MS);
  const pending = plan.shards.map((s) => runShard(s, port, password, reportDir));
  const heartbeat = setInterval(() => {
    const done = plan.shards.map((s) => `${filesDone(join(reportDir, `shard-${s.index}.log`))}/${s.files.length}`);
    say(`${Math.round((Date.now() - testsStarted) / 1000)} s: files done per shard ${done.join(' ')}`);
  }, HEARTBEAT_MS);
  const results = await Promise.all(pending);
  if (stopping) return 1;
  clearInterval(heartbeat);
  clearTimeout(limit);
  stopSampler();
  const testSeconds = Math.round((Date.now() - testsStarted) / 1000);

  const reports = new Map(results.map((r) => [r.index, readReport(r.jsonPath)]));
  const coverage = checkVitest(specFiles, reports, plan.count);
  const failures = results.flatMap((r) => reportFailures(r.index, reports.get(r.index)));
  const problems = [
    ...(abortReason ? [abortReason] : []),
    ...coverage.problems.filter((p) => !/ is (failed|skipped|pending|todo)\b/.test(p)),
    ...checkPlanned(plan, reports),
    ...(await databaseProblems(id, plan.count)),
    ...databaseCrossings(databasesSeen),
    ...logProblems(results),
  ];

  const cleanupStarted = Date.now();
  const cleanup = await cleanUp();
  const passed = results.every((r) => r.exit === 0) && coverage.problems.length === 0 && failures.length === 0 && problems.length === 0 && cleanup.length === 0;
  const summary = {
    passed,
    runId,
    reportDir,
    files: coverage.files,
    tests: coverage.tests,
    failures,
    problems,
    cleanup,
    databasesSeen: [...databasesSeen].sort(),
    networkErrors: networkErrors(results),
    memory,
    containerSeconds,
    testSeconds,
    cleanupSeconds: Math.round((Date.now() - cleanupStarted) / 1000),
    totalSeconds: Math.round((Date.now() - startedAt) / 1000),
    shards: results.map((r) => {
      const shard = coverage.shards.find((s) => s.index === r.index);
      return { index: r.index, exit: r.exit, files: shard?.files ?? 0, tests: shard?.tests ?? 0, seconds: shard?.seconds ?? 0, failed: failures.filter((f) => f.shard === r.index).length };
    }),
  };
  writeFileSync(join(reportDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(formatSummary(summary));
  return passed ? 0 : 1;
}

for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, () => { interrupted(signal); });
process.on('exit', () => { if (!cleaned) removeEverythingSync(); });

// A signal kills what main is waiting for, so main may end here in any way.
// `interrupted` owns the exit then, and its code says the run was stopped.
main().then(
  (code) => { if (!stopping) process.exit(code); },
  (error) => {
    if (stopping) return;
    console.error(`[test:api] stopped: ${error.message}`);
    process.exit(1);
  },
);
