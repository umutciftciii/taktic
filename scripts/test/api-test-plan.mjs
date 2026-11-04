// The side-effect-free half of `pnpm test:api` (CI-PERF-005): what each shard
// runs, what its process may see, which leftover container may be removed, and
// how the shards' reports become one. run-api-tests.mjs does the I/O.
//
//   node scripts/test/api-test-plan.mjs update <report dir>...
//
// rewrites api-test-durations.json from the reports of earlier green runs.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileWeights, mergeRuns, planShards, readDurations } from '../../.github/scripts/e2e-shard-plan.mjs';

export const DURATIONS_FILE = fileURLToPath(new URL('./api-test-durations.json', import.meta.url));
export const DURATIONS_PROJECT = 'api-local';

export const IMAGE = 'postgres:16.6-alpine';
export const DATA_DIR = '/var/lib/postgresql/data';
export const TMPFS_MB = 2048;
export const DB_USER = 'taktic_user';
export const BASE_DB = 'taktic';
/** The development PostgreSQL's published port. The runner never uses it. */
export const RESERVED_PORT = 5433;
export const MAX_SHARDS = 8;

// Durability off and the WAL capped: the data directory dies with the container.
// Constraints, transactions and isolation levels are untouched, so the suite
// proves what it proves on CI. Without the WAL cap a full run has filled a tmpfs
// and PANICked the server (CI-PERF-002).
export const SERVER_SETTINGS = {
  fsync: 'off',
  synchronous_commit: 'off',
  full_page_writes: 'off',
  wal_level: 'minimal',
  max_wal_senders: '0',
  max_wal_size: '256MB',
  checkpoint_timeout: '30s',
  max_connections: '200',
};

export const LABELS = {
  kind: 'com.taktic.test-runner',
  run: 'com.taktic.test-runner.run-id',
  pid: 'com.taktic.test-runner.owner-pid',
  pidStart: 'com.taktic.test-runner.owner-started',
  host: 'com.taktic.test-runner.owner-host',
};
export const KIND = 'api-local';

const USAGE = `usage: pnpm test:api [--shards=N] [--dry-run] [--report-dir=DIR]

  --shards=N        parallel shards, 1-${MAX_SHARDS} (default 4)
  --dry-run         print the plan; start nothing
  --report-dir=DIR  parent of this run's report directory
                    (default apps/api/reports/test-api)`;

export function parseArgs(argv) {
  const options = { shards: 4, dryRun: false, help: false, reportDir: null };
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inline] = arg.split(/=(.*)/s);
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (flag === '--shards' || flag === '--report-dir') {
      const value = inline ?? args[(i += 1)];
      if (value === undefined || value === '') throw new Error(`${flag} needs a value\n${USAGE}`);
      if (flag === '--report-dir') options.reportDir = value;
      else {
        if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > MAX_SHARDS) {
          throw new Error(`--shards must be a whole number from 1 to ${MAX_SHARDS}; got "${value}"`);
        }
        options.shards = Number(value);
      }
    } else throw new Error(`unknown option "${arg}"\n${USAGE}`);
  }
  return options;
}

export { USAGE };

/**
 * Which shard runs which spec file. Longest file first onto the shard with the
 * least planned time, from the committed history, so the same commit always
 * gives the same split. A file with no history weighs the median file; a
 * missing or broken history falls back to file counts, with a warning.
 *
 * @param {string[]} specFiles  relative to apps/api
 * @param {string | undefined} durationsText  the durations file's text
 */
export function buildApiPlan(specFiles, durationsText, count) {
  const history = durationsText === undefined
    ? { problem: 'the durations file is missing' }
    : readDurations(durationsText, DURATIONS_PROJECT);
  const files = new Map([...specFiles].sort().map((f) => [f, 1]));
  const { weights, estimated } = fileWeights(files, history.seconds);
  const shards = planShards(weights, count);
  for (const s of shards) if (s.files.length === 0) throw new Error(`shard ${s.index}/${count} was planned no files`);
  return { count, fallback: history.problem ?? null, estimated, shards };
}

// Only what the toolchain needs to find itself. A value a developer exported —
// TEST_DATABASE_URL above all, which outranks everything and would put every
// shard on one database, but also TEST_DB_RESET and the application's own
// settings — must not be able to change what this run tests.
const INHERITED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TZ', 'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'PNPM_HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
];

export function shardEnv(parent, { databaseUrl, index }) {
  const env = {};
  for (const name of INHERITED_ENV) if (parent[name] !== undefined) env[name] = parent[name];
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_SLUG: `api_shard_${index}`,
    // This is the only place the delete reset is switched on.
    TEST_DB_RESET: 'delete',
    AUTH_COOKIE_NAME: 'taktic_session',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

export const shardDatabase = (index) => `${BASE_DB}_api_shard_${index}_test`;

export const shardApplication = (index) => `api_shard_${index}`;

/**
 * application_name marks every connection with its shard, which is what lets
 * databaseCrossings see them: all shards share one server, so unlike CI's
 * per-runner services the server's own list of databases proves nothing.
 */
export function databaseUrl(port, password, index) {
  assertRunnerPort(port);
  return `postgresql://${DB_USER}:${password}@127.0.0.1:${port}/${BASE_DB}?schema=public&application_name=${shardApplication(index)}`;
}

/**
 * Connections seen in a database other than their shard's own, its migration
 * scratch database or the maintenance database. `seen` holds `application|database`.
 */
export function databaseCrossings(seen) {
  const problems = [];
  for (const pair of seen) {
    const [application, database] = pair.split('|');
    const shard = /^api_shard_([0-9]+)$/.exec(application);
    if (!shard) continue;
    const own = shardDatabase(Number(shard[1]));
    if (![own, `${own.slice(0, -'_test'.length)}_m1_test`, 'postgres'].includes(database)) {
      problems.push(`${application} connected to ${database}`);
    }
  }
  return problems;
}

export function assertRunnerPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`"${port}" is not a usable port`);
  if (port === RESERVED_PORT) throw new Error(`port ${RESERVED_PORT} belongs to the development database`);
}

/**
 * The published address `docker port` printed, or an error unless it is
 * loopback only: one line per binding, and any other interface is refused.
 */
export function parsePublishedPort(output) {
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`expected one published address, got: ${JSON.stringify(lines)}`);
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(lines[0]);
  if (!match) throw new Error(`the container is published on "${lines[0]}", not on 127.0.0.1 only`);
  const port = Number(match[1]);
  assertRunnerPort(port);
  return port;
}

/** Problems with the tmpfs line of the container's /proc/mounts. */
export function checkMount(line) {
  const [type, options = ''] = line.trim().split(/\s+/);
  if (type !== 'tmpfs') return [`${DATA_DIR} is on "${type || 'nothing'}", not a tmpfs`];
  const size = /(?:^|,)size=([0-9]+)k(?:,|$)/.exec(options);
  if (!size || Number(size[1]) !== TMPFS_MB * 1024) return [`the tmpfs options are "${options}", not a ${TMPFS_MB} MB ceiling`];
  return [];
}

/**
 * @param {string} output  `name=setting` lines from pg_settings, with the unit
 */
export function checkSettings(output) {
  const seen = new Map(output.trim().split('\n').map((l) => l.split('=')));
  const problems = [];
  const effective = { ...SERVER_SETTINGS, max_wal_size: '256', checkpoint_timeout: '30' };
  for (const [name, wanted] of Object.entries(effective)) {
    if (seen.get(name) !== wanted) problems.push(`${name} is ${seen.get(name) ?? 'unset'}, not ${wanted}`);
  }
  return problems;
}

/**
 * Whether a labelled container left by an earlier run may be removed. Every
 * check must come back positive: anything unknown keeps the container, because
 * a stray container costs some memory and a wrong removal kills somebody's run.
 *
 * @param {object} c
 * @param {Record<string,string>} c.labels
 * @param {boolean} c.running
 * @param {string} c.hostname  this machine
 * @param {string | null | undefined} c.ownerStarted  when the labelled pid's process started; null when no
 *   such process, undefined when that could not be found out
 * @param {number[] | null} c.clientBackends  counts of connected clients, one per sample; null when unknown
 */
export function staleVerdict({ labels, running, hostname, ownerStarted, clientBackends }) {
  if (labels[LABELS.kind] !== KIND) return { remove: false, reason: 'not a container of this runner' };
  for (const key of ['run', 'pid', 'pidStart', 'host']) {
    if (!labels[LABELS[key]]) return { remove: false, reason: `its ${key} label is missing` };
  }
  // A Mac's hostname can change with the network, so this may be our own leftover.
  if (labels[LABELS.host] !== hostname) return { remove: false, reason: `it was started under the hostname ${labels[LABELS.host]}` };
  if (ownerStarted === undefined) return { remove: false, reason: 'whether the run that started it is alive could not be found out' };
  if (ownerStarted !== null && ownerStarted === labels[LABELS.pidStart]) {
    return { remove: false, reason: 'the run that started it is still alive' };
  }
  if (running) {
    if (!clientBackends || clientBackends.length === 0) return { remove: false, reason: 'its connections could not be counted' };
    if (clientBackends.some((n) => n !== 0)) return { remove: false, reason: 'something is still connected to it' };
  }
  return { remove: true, reason: 'its run has ended and nothing uses it' };
}

/** A Vitest report's path, relative to apps/api wherever the checkout is. */
const specPath = (name) => {
  const at = name.lastIndexOf('/apps/api/');
  return at === -1 ? name : name.slice(at + '/apps/api/'.length);
};

/** Problems unless each shard's report holds exactly the files the plan gave it. */
export function checkPlanned(plan, reports) {
  const problems = [];
  for (const shard of plan.shards) {
    const report = reports.get(shard.index);
    if (!report) continue; // checkVitest already says the report is missing.
    const ran = new Set((report.testResults ?? []).map((f) => specPath(f.name)));
    for (const f of shard.files) if (!ran.has(f)) problems.push(`${f} is planned for shard ${shard.index} but did not run there`);
    for (const f of ran) if (!shard.files.includes(f)) problems.push(`${f} ran in shard ${shard.index}, which was not planned it`);
  }
  return problems;
}

/** What went wrong in one shard's report: one entry per test, or per file that never reached its tests. */
export function reportFailures(index, report) {
  const failures = [];
  for (const file of report?.testResults ?? []) {
    const path = specPath(file.name);
    const failed = (file.assertionResults ?? []).filter((t) => t.status !== 'passed');
    for (const t of failed) {
      failures.push({ shard: index, file: path, test: t.fullName, status: t.status, message: firstLine(t.failureMessages?.[0]) });
    }
    if (file.status !== 'passed' && failed.length === 0) {
      failures.push({ shard: index, file: path, test: null, status: file.status, message: firstLine(file.message) });
    }
  }
  return failures;
}

const firstLine = (text) => (text ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? '';

/**
 * Each file's cost: from the end of the file before it in the shard to its own
 * end. A report's per-file times start at the first test, which leaves out the
 * import and the Nest boot every file pays for; the gaps put them back. Files in
 * a shard run one after another, so the gaps are that file's time.
 */
export function reportFileMs(report) {
  const files = [...(report?.testResults ?? [])].sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
  const ms = new Map();
  let previous = report?.startTime ?? files[0]?.startTime ?? 0;
  for (const f of files) {
    ms.set(specPath(f.name), Math.max(0, (f.endTime ?? previous) - previous));
    previous = f.endTime ?? previous;
  }
  return ms;
}

const formatSeconds = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;

/** What a person reads at the end: the verdict, the shards, every failure, the time and the memory. */
export function formatSummary(s) {
  const lines = ['', `API tests ${s.passed ? 'PASSED' : 'FAILED'}: ${s.files} files, ${s.tests} tests, ${s.failures.length} failed, ${formatSeconds(s.totalSeconds)} in all`];
  lines.push('', 'shard | files | tests | failed | test time | exit');
  for (const r of s.shards) {
    lines.push(`${String(r.index).padStart(5)} | ${String(r.files).padStart(5)} | ${String(r.tests).padStart(5)} | ${String(r.failed).padStart(6)} | ${formatSeconds(r.seconds).padStart(9)} | ${r.exit}`);
  }
  lines.push('', `time: container ${s.containerSeconds} s, tests ${s.testSeconds} s, cleanup ${s.cleanupSeconds} s`);
  const m = s.memory;
  lines.push(`peak memory: container ${m.containerMb ?? '?'} MB, tmpfs ${m.tmpfsMb ?? '?'}/${TMPFS_MB} MB, test processes ${m.processesMb ?? '?'} MB`);
  lines.push(`network errors in the logs: ${Object.entries(s.networkErrors).map(([k, v]) => `${k} ${v}`).join(', ')}; failures mentioning 401: ${s.failures.filter((f) => /\b401\b/.test(f.message)).length}`);
  lines.push(`databases: ${s.databasesSeen.length} shard/database pairs seen, none crossing${s.problems.some((p) => / connected to /.test(p)) ? ' — except as listed below' : ''}`);
  lines.push(`cleanup: ${s.cleanup.length === 0 ? 'container, port and processes are gone' : s.cleanup.join('; ')}`);
  if (s.failures.length > 0) {
    lines.push('', 'failures:');
    for (const f of s.failures) lines.push(`  [shard ${f.shard}] ${f.file}${f.test ? ` › ${f.test}` : ''} (${f.status})`, ...(f.message ? [`      ${f.message}`] : []));
  }
  if (s.problems.length > 0) {
    lines.push('', 'the run itself is not valid:');
    for (const p of s.problems) lines.push(`  ${p}`);
  }
  lines.push('', `report: ${s.reportDir}`);
  return lines.join('\n');
}

function update(dirs) {
  const runs = dirs.map((dir) => {
    const shards = readdirSync(dir).filter((f) => /^shard-[0-9]+\.json$/.test(f));
    if (shards.length === 0) throw new Error(`${dir} holds no shard report`);
    const summary = join(dir, 'summary.json');
    if (!existsSync(summary) || JSON.parse(readFileSync(summary, 'utf8')).passed !== true) {
      throw new Error(`${dir} is not a green run: its times would describe a different suite`);
    }
    const run = new Map();
    for (const name of shards) {
      for (const [file, ms] of reportFileMs(JSON.parse(readFileSync(join(dir, name), 'utf8')))) {
        if (run.has(file)) throw new Error(`${file} ran in two shards of ${dir}`);
        run.set(file, ms);
      }
    }
    return run;
  });
  const text = JSON.stringify({ version: 1, runs: dirs.map((d) => resolve(d).split('/').pop()), projects: { [DURATIONS_PROJECT]: mergeRuns(runs) } }, null, 2) + '\n';
  writeFileSync(DURATIONS_FILE, text);
  console.log(`wrote ${DURATIONS_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'update' && args.length > 0) update(args);
  else {
    console.error('usage: api-test-plan.mjs update <report dir>...');
    process.exitCode = 2;
  }
}
