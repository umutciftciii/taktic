import { runBootConfigChecks } from './boot-config';

/**
 * `node dist/boot-config-check.js` — the API's boot checks, and nothing else.
 *
 * Run by scripts/ops/deploy-preflight.sh inside the image a deploy is about to
 * start, through `docker compose run` so the container receives exactly the
 * environment docker-compose.prod.yml will give the real API. It imports no
 * module, opens no connection and listens on nothing; it only answers "would
 * this build, with this configuration, refuse to boot?" while the old API is
 * still serving and before any migration has been applied.
 *
 * One line per check, then a verdict line the preflight looks for verbatim, so
 * a tool that printed nothing can never read as a pass. Exit 1 when any check
 * refuses. The messages are the boot messages themselves: they name variables
 * and never carry a secret's value.
 */
function main(): number {
  const results = runBootConfigChecks();

  for (const result of results) {
    if (result.ok) {
      process.stdout.write(`ok   ${result.name}\n`);
    } else {
      process.stdout.write(`FAIL ${result.name}: ${result.message}\n`);
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  if (failed > 0) {
    process.stdout.write(`boot-config: ${failed} check(s) refused\n`);
    return 1;
  }

  process.stdout.write('boot-config: OK\n');
  return 0;
}

process.exitCode = main();
