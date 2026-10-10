#!/usr/bin/env node
// The release version's consistency check (RELEASE-BASELINE-001).
//
//   pnpm version:check                 every rule below, plus any v* tag on HEAD
//   pnpm version:check --tag v0.1.0    the same, and this tag must name the version
//   pnpm version:check --print         print the version and nothing else
//
// The root package.json `version` is the only place the release version is
// written (docs/release.md). What is checked:
//
//   - it is MAJOR.MINOR.PATCH;
//   - every workspace manifest is private and keeps the placeholder 0.0.0, so
//     no app or package grows a version of its own;
//   - CHANGELOG.md has an `## Unreleased` section and a dated
//     `## X.Y.Z - YYYY-MM-DD` section for this version;
//   - no app source writes the version as a literal (the apps read it from
//     the build, see apps/*/next.config.ts);
//   - a tag given with --tag, and every v* tag pointing at HEAD, is
//     annotated and is exactly `v<version>`.
//
// It publishes nothing and creates no tag.
//
// Output is one line per failure and a final `version-check: OK <version>` or
// `version-check: <n> failure(s)`. Exit status: 0 consistent, 1 a check failed,
// 2 the check could not run.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const WORKSPACE_PLACEHOLDER_VERSION = '0.0.0';

/** The workspace manifests, from pnpm-workspace.yaml's globs (`dir/*` or a plain dir). */
export function workspaceManifests(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s*-\s*["']?([^"'#\s]+)["']?/gm)].map((match) => match[1]);
  const dirs = globs.flatMap((glob) => {
    if (glob.endsWith('/*')) {
      const parent = join(root, glob.slice(0, -2));
      return existsSync(parent) ? readdirSync(parent).map((name) => join(parent, name)) : [];
    }
    return [join(root, glob)];
  });
  return dirs.map((dir) => join(dir, 'package.json')).filter((file) => existsSync(file)).sort();
}

const SOURCE_DIRS = ['app', 'components', 'lib', 'src'];
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_FILE.test(name)) yield path;
  }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Every rule, as a list of failure lines; empty when the version is consistent. */
export function checkVersion(root, { tag = null } = {}) {
  const failures = [];
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = rootManifest.version;
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    return { version, failures: [`package.json: version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`] };
  }

  for (const file of workspaceManifests(root)) {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const name = relative(root, file);
    if (manifest.private !== true) failures.push(`${name}: must be private`);
    if (manifest.version !== WORKSPACE_PLACEHOLDER_VERSION) {
      failures.push(
        `${name}: version must stay ${WORKSPACE_PLACEHOLDER_VERSION} (the release version lives in the root package.json), got ${JSON.stringify(manifest.version)}`,
      );
    }
  }

  const changelogPath = join(root, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    failures.push('CHANGELOG.md: missing');
  } else {
    const changelog = readFileSync(changelogPath, 'utf8');
    if (!/^## Unreleased\s*$/m.test(changelog)) failures.push('CHANGELOG.md: no "## Unreleased" section');
    const escaped = version.replaceAll('.', '\\.');
    if (!new RegExp(`^## ${escaped} - \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm').test(changelog)) {
      failures.push(`CHANGELOG.md: no "## ${version} - YYYY-MM-DD" section`);
    }
  }

  // A quoted literal or a `v`-prefixed one: the shapes a hand-written copy takes.
  const escaped = version.replaceAll('.', '\\.');
  const literal = new RegExp(`(['"\`]v?${escaped}['"\`])|(\\bv${escaped}(?![\\d.]))`);
  const appsDir = join(root, 'apps');
  for (const app of existsSync(appsDir) ? readdirSync(appsDir) : []) {
    for (const sub of SOURCE_DIRS) {
      const dir = join(appsDir, app, sub);
      if (!existsSync(dir)) continue;
      for (const file of sourceFiles(dir)) {
        if (literal.test(readFileSync(file, 'utf8'))) {
          failures.push(`${relative(root, file)}: writes the release version ${version} as a literal`);
        }
      }
    }
  }

  const tags = new Set(tag ? [tag] : []);
  if (existsSync(join(root, '.git'))) {
    for (const pointing of git(root, ['tag', '--points-at', 'HEAD', '--list', 'v*']).split('\n').filter(Boolean)) {
      tags.add(pointing);
    }
  }
  for (const name of tags) {
    if (name !== `v${version}`) {
      failures.push(`tag ${name}: does not match package version ${version} (expected v${version})`);
      continue;
    }
    let type = '';
    try {
      type = git(root, ['cat-file', '-t', `refs/tags/${name}`]);
    } catch {
      // Named on the command line but not created yet: nothing more to check.
      continue;
    }
    if (type !== 'tag') failures.push(`tag ${name}: must be annotated (git tag -a), is a lightweight tag`);
  }

  return { version, failures };
}

function main(argv) {
  const args = argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : (args[at + 1] ?? '');
  };
  const root = option('--root') ?? process.cwd();
  if (args.includes('--print')) {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      console.error(`version-check: package.json version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`);
      return 1;
    }
    console.log(version);
    return 0;
  }
  const { version, failures } = checkVersion(root, { tag: option('--tag') });
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) {
    console.error(`version-check: ${failures.length} failure(s)`);
    return 1;
  }
  console.log(`version-check: OK ${version}`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(`version-check: could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
