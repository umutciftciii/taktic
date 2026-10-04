#!/usr/bin/env node
// Security audit of a resolved Compose configuration (OPS-004 / OPS-006).
//
// Reads what `docker compose config --format json` prints — the file after
// every merge and every ${VAR} substitution, i.e. what Docker would actually
// run — and fails on anything that would publish a port beyond loopback or
// put development behaviour on a deployed host.
//
//   node scripts/ops/compose-security.mjs prod   audit docker-compose.prod.yml
//   node scripts/ops/compose-security.mjs dev    audit the local dev stack
//                                                (docker-compose.yml +
//                                                docker-compose.local.yml)
//
// Both invocations run Compose with placeholder values for the variables the
// file requires, plus every variable already in the environment, so a real
// host can run the same audit against its own .env:
//
//   node scripts/ops/compose-security.mjs prod --use-env
//
// Or audit a configuration resolved elsewhere (the deploy preflight does this
// so the host needs no Node: the script can run in a container):
//
//   docker compose -f docker-compose.prod.yml config --format json \
//     | node scripts/ops/compose-security.mjs prod --stdin
//
// and list the environment variable *names* one service receives (never the
// values), for the preflight's comparison with the running container:
//
//   ... | node scripts/ops/compose-security.mjs env-keys api
//
// Exit status: 0 clean, 1 findings, 2 the audit itself could not run.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Host addresses a published port may use. Anything else reaches a network. */
export const LOOPBACK_HOST_IPS = new Set(['127.0.0.1', '::1']);

/** Services of the deployed stack and what each one is allowed to be. */
export const PROD_APP_SERVICES = ['api', 'web', 'admin', 'migrate'];

/**
 * Values only the API (or the migration tool) may receive. The web and admin
 * processes render HTML for strangers; a secret in their environment is one
 * template bug away from a page.
 */
export const API_ONLY_VARIABLES = [
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'RESEND_API_KEY',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY',
  'PROMOTION_FINGERPRINT_KEY',
];

/** Commands that mean "development server" wherever they appear. */
const DEV_COMMAND = /\b(next\s+dev|ts-node-dev|tsx\s+watch|nodemon|pnpm\s+(?:--filter\s+\S+\s+)?dev)\b/;

function commandText(value) {
  if (value == null) return '';
  return Array.isArray(value) ? value.join(' ') : String(value);
}

function environmentKeys(service) {
  const env = service.environment;
  if (!env) return [];
  return Array.isArray(env) ? env.map((entry) => String(entry).split('=')[0]) : Object.keys(env);
}

/**
 * Ports every service of any stack must satisfy: published only on loopback.
 * A port entry without host_ip binds every interface (0.0.0.0 and [::]).
 */
function auditPorts(name, service, findings) {
  for (const port of service.ports ?? []) {
    const hostIp = port.host_ip;
    if (!hostIp) {
      findings.push(`${name}: port ${port.target} is published on every host interface (no host_ip)`);
    } else if (!LOOPBACK_HOST_IPS.has(hostIp)) {
      findings.push(`${name}: port ${port.target} is published on ${hostIp}, not loopback`);
    }
  }
  if (service.network_mode === 'host') {
    findings.push(`${name}: network_mode "host" bypasses port publishing entirely`);
  }
}

/** The deployed stack: loopback, plus everything that makes it immutable. */
export function auditProd(config) {
  const findings = [];
  const services = config.services ?? {};

  for (const required of ['postgres', ...PROD_APP_SERVICES]) {
    if (!services[required]) findings.push(`${required}: service missing from the resolved configuration`);
  }

  for (const [name, service] of Object.entries(services)) {
    auditPorts(name, service, findings);

    if (service.privileged) findings.push(`${name}: privileged container`);

    if (name === 'postgres' && (service.ports ?? []).length > 0) {
      findings.push('postgres: must not be published on any host address');
    }

    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind') {
        findings.push(`${name}: bind mount ${volume.source} -> ${volume.target} (deployed containers run their image, not the host checkout)`);
      }
    }

    if (DEV_COMMAND.test(`${commandText(service.entrypoint)} ${commandText(service.command)}`)) {
      findings.push(`${name}: runs a development server command`);
    }

    if (PROD_APP_SERVICES.includes(name)) {
      if (service.build) findings.push(`${name}: has a build section; deployed images come from scripts/ops/build-images.sh`);
      const expected = `taktic-${name}:`;
      if (typeof service.image !== 'string' || !service.image.startsWith(expected)) {
        findings.push(`${name}: image "${service.image}" is not ${expected}<commit>`);
      }
      if (!(service.security_opt ?? []).includes('no-new-privileges:true')) {
        findings.push(`${name}: missing security_opt no-new-privileges:true`);
      }
      if (!(service.cap_drop ?? []).includes('ALL')) {
        findings.push(`${name}: missing cap_drop ALL`);
      }
    }

    if (name === 'web' || name === 'admin') {
      const leaked = environmentKeys(service).filter((key) => API_ONLY_VARIABLES.includes(key));
      for (const key of leaked) findings.push(`${name}: receives ${key}, which only the API may see`);
    }
  }

  const env = services.api?.environment ?? {};
  if (!Array.isArray(env) && env.APP_ENVIRONMENT !== undefined && !['staging', 'production'].includes(env.APP_ENVIRONMENT)) {
    findings.push(`api: APP_ENVIRONMENT resolves to "${env.APP_ENVIRONMENT}", expected staging or production`);
  }

  return findings;
}

/** The local development stack: only the network exposure rule applies. */
export function auditDev(config) {
  const findings = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    auditPorts(name, service, findings);
  }
  return findings;
}

/** Placeholders for the variables docker-compose.prod.yml refuses to default. */
export const PROD_PLACEHOLDER_ENV = {
  COMPOSE_PROJECT_NAME: 'taktic-audit',
  TAKTIC_IMAGE_TAG: '0000000000000000000000000000000000000000',
  APP_ENVIRONMENT: 'staging',
  POSTGRES_PASSWORD: 'audit-placeholder',
};

export function resolveConfig(stack, { useEnv = false, extraEnv = {} } = {}) {
  const files =
    stack === 'prod'
      ? ['-f', 'docker-compose.prod.yml', '--profile', 'tools']
      : ['-f', 'docker-compose.yml', '-f', 'docker-compose.local.yml'];
  const base = useEnv ? process.env : { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST ?? '' };
  const env = { ...(stack === 'prod' ? PROD_PLACEHOLDER_ENV : {}), ...base, ...extraEnv };
  if (!env.DOCKER_HOST) delete env.DOCKER_HOST;
  // --env-file /dev/null: the audit of the repository's files must not depend
  // on whatever .env happens to sit in this checkout. --use-env opts back in.
  const envFile = useEnv ? [] : ['--env-file', '/dev/null'];
  const out = execFileSync('docker', ['compose', ...envFile, ...files, 'config', '--format', 'json'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function readStdin() {
  return new Promise((resolveRead, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolveRead(data));
    process.stdin.on('error', reject);
  });
}

async function main(argv) {
  const mode = argv[0];
  if (mode === 'env-keys') {
    const config = JSON.parse(await readStdin());
    const service = config.services?.[argv[1]];
    if (!service) {
      console.error(`compose-security: no service "${argv[1]}" in the configuration`);
      return 2;
    }
    for (const key of environmentKeys(service).sort()) console.log(key);
    return 0;
  }
  if (mode !== 'prod' && mode !== 'dev') {
    console.error('usage: compose-security.mjs prod|dev [--use-env | --stdin] | env-keys <service>');
    return 2;
  }
  let config;
  try {
    config = argv.includes('--stdin')
      ? JSON.parse(await readStdin())
      : resolveConfig(mode, { useEnv: argv.includes('--use-env') });
  } catch (error) {
    console.error(`compose-security: could not resolve the configuration: ${error.stderr || error.message}`);
    return 2;
  }
  const findings = mode === 'prod' ? auditProd(config) : auditDev(config);
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const ports = (service.ports ?? []).map((p) => `${p.host_ip ?? '0.0.0.0'}:${p.published}->${p.target}`);
    console.log(`${mode} ${name}: ${ports.length ? ports.join(', ') : 'not published'}`);
  }
  if (findings.length) {
    for (const finding of findings) console.error(`FAIL ${finding}`);
    return 1;
  }
  console.log(`compose-security: ${mode} stack OK`);
  return 0;
}

// Run as a program, not when imported by the tests. Compared by real path: on
// macOS the temporary directory a deploy stages these scripts into is reached
// through a symlink (/var -> /private/var), and a plain string comparison
// once made the audit exit 0 without auditing anything.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`compose-security: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
