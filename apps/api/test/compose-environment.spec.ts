import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTurnstileConfig } from '../src/modules/turnstile/turnstile.config';

/**
 * The deployment contract the two compose files carry, pinned.
 *
 * The base `docker-compose.yml` is what a staging or production host may run,
 * and it must not decide the environment for a host that forgot to: an
 * `APP_ENVIRONMENT` left unset has to reach the process as unset, where every
 * reader treats unknown as production and Turnstile falls closed. The local
 * declaration lives in `docker-compose.local.yml` alone, which is loaded only
 * by an explicit `-f` — never implicitly, which is why it is not named
 * `docker-compose.override.yml`.
 *
 * A line-based read rather than a YAML parser: the repository has none, and
 * the two facts asserted here are single lines whose exact spelling is the
 * contract.
 */
const repoRoot = resolve(__dirname, '../../..');
const base = readFileSync(resolve(repoRoot, 'docker-compose.yml'), 'utf8');
const local = readFileSync(resolve(repoRoot, 'docker-compose.local.yml'), 'utf8');

/** The `environment:` lines of one service, from the base file. */
function serviceEnvironmentLines(source: string, service: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  expect(start, `service ${service}`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break; // next service
    body.push(line);
  }
  return body.filter((line) => /^\s{6}[A-Z_]+:/.test(line));
}

function readVariable(lines: string[], name: string): string | undefined {
  const match = lines.map((line) => line.match(new RegExp(`^\\s{6}${name}:\\s*(.*)$`))).find(Boolean);
  return match?.[1]?.trim();
}

describe('docker-compose.yml — the base file a deployment may run', () => {
  it.each(['api', 'web'])('forwards APP_ENVIRONMENT to %s as empty-when-unset, never defaulting it to local', (service) => {
    const value = readVariable(serviceEnvironmentLines(base, service), 'APP_ENVIRONMENT');
    expect(value).toBe('${APP_ENVIRONMENT:-}');
  });

  it('names no environment anywhere, so a host that says nothing declares nothing', () => {
    expect(base).not.toMatch(/APP_ENVIRONMENT:-(local|staging|production)/);
    expect(base).not.toMatch(/APP_ENVIRONMENT:\s*(local|staging|production)\s*$/m);
  });

  it('forwards every Turnstile variable empty-when-unset, the secret to the api only', () => {
    const api = serviceEnvironmentLines(base, 'api');
    const web = serviceEnvironmentLines(base, 'web');
    const admin = serviceEnvironmentLines(base, 'admin');
    expect(readVariable(api, 'TURNSTILE_MODE')).toBe('${TURNSTILE_MODE:-}');
    expect(readVariable(api, 'TURNSTILE_SECRET_KEY')).toBe('${TURNSTILE_SECRET_KEY:-}');
    expect(readVariable(api, 'TURNSTILE_EXPECTED_HOSTNAMES')).toBe('${TURNSTILE_EXPECTED_HOSTNAMES:-}');
    expect(readVariable(web, 'TURNSTILE_MODE')).toBe('${TURNSTILE_MODE:-}');
    expect(readVariable(web, 'TURNSTILE_SITE_KEY')).toBe('${TURNSTILE_SITE_KEY:-}');
    expect(readVariable(web, 'TURNSTILE_SECRET_KEY')).toBeUndefined();
    expect(admin.some((line) => /TURNSTILE|APP_ENVIRONMENT/.test(line))).toBe(false);
  });

  it('forwards the public origin to the web empty-when-unset, so its SEO gate can only open on a declared value', () => {
    const web = serviceEnvironmentLines(base, 'web');
    expect(readVariable(web, 'WEB_APP_URL')).toBe('${WEB_APP_URL:-}');
    expect(readVariable(web, 'WEB_ORIGIN')).toBe('${WEB_ORIGIN:-}');
    // Never the API's loopback default: a loopback origin is a closed site
    // anyway, but the web must not be handed one it could mistake for real.
    expect(web.some((line) => /WEB_(APP_URL|ORIGIN):.*localhost/.test(line))).toBe(false);
  });

  it('rendered with nothing set, is what the API refuses to boot on', () => {
    // Exactly the values a host with no APP_ENVIRONMENT hands the process.
    expect(() =>
      resolveTurnstileConfig({
        NODE_ENV: 'development',
        APP_ENVIRONMENT: '',
        TURNSTILE_MODE: '',
        TURNSTILE_SECRET_KEY: '',
        TURNSTILE_EXPECTED_HOSTNAMES: '',
        TURNSTILE_SITEVERIFY_TIMEOUT_MS: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TURNSTILE_SECRET_KEY is required/);
  });
});

describe('docker-compose.local.yml — the explicit local declaration', () => {
  it.each(['api', 'web'])('declares APP_ENVIRONMENT=local for %s, and nothing else', (service) => {
    const lines = serviceEnvironmentLines(local, service);
    expect(readVariable(lines, 'APP_ENVIRONMENT')).toBe('local');
    expect(lines).toHaveLength(1);
  });

  it('touches no other service', () => {
    const services = local.split('\n').filter((line) => /^  \S+:$/.test(line)).map((line) => line.trim());
    expect(services.sort()).toEqual(['api:', 'web:']);
  });

  it('is not the implicit override file', () => {
    expect(() => readFileSync(resolve(repoRoot, 'docker-compose.override.yml'))).toThrow();
  });

  it('rendered on top of the base with nothing set, is the test adapter', () => {
    expect(
      resolveTurnstileConfig({
        NODE_ENV: 'development',
        APP_ENVIRONMENT: 'local',
        TURNSTILE_MODE: '',
        TURNSTILE_SECRET_KEY: '',
        TURNSTILE_EXPECTED_HOSTNAMES: '',
        TURNSTILE_SITEVERIFY_TIMEOUT_MS: '',
      } as NodeJS.ProcessEnv),
    ).toEqual({ mode: 'test' });
  });
});
