import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { allDistrictPairs, createLocationAllocator } from '../src/fixtures';

/**
 * API-HARDENING-001: the fixture district pool is one per run, shared by every
 * worker process, so no test's outcome depends on where it is scheduled.
 *
 * No browser: this is the allocator's own contract, run in the same suite so
 * it is exercised under the same Node and file system as the fixtures.
 */
const run = promisify(execFile);

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'taktic-location-claims-'));
}

test.describe('fixture district allocator', () => {
  test('never hands the same district to two allocators sharing a run', () => {
    const dir = freshDir();
    try {
      const first = createLocationAllocator(dir);
      const second = createLocationAllocator(dir);
      const seen = new Set<string>();

      // Interleaved, the way a worker and its retry replacement would be.
      for (let index = 0; index < 400; index += 1) {
        const location = (index % 3 === 0 ? second : first)();
        const key = `${location.city}/${location.district}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
      expect(readdirSync(dir)).toHaveLength(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gives one run the whole pool, not a quarter of it, and refuses past the end', () => {
    const dir = freshDir();
    try {
      const allocate = createLocationAllocator(dir);
      const total = allDistrictPairs().length;
      // Past the 243 a single worker used to be limited to.
      for (let index = 0; index < total; index += 1) {
        allocate();
      }
      expect(total).toBeGreaterThan(900);
      expect(() => allocate()).toThrow(/All \d+ fixture districts are claimed/);
      expect(() => createLocationAllocator(dir)()).toThrow(/All \d+ fixture districts are claimed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stays exclusive across separate processes claiming at once', async () => {
    test.setTimeout(120_000);
    const dir = freshDir();
    const script = join(dir, '..', `claim-${Date.now()}.ts`);
    const fixtures = resolve(__dirname, '../src/fixtures');
    writeFileSync(
      script,
      `import { createLocationAllocator } from ${JSON.stringify(fixtures)};\n` +
        `const allocate = createLocationAllocator(${JSON.stringify(dir)});\n` +
        `const out: string[] = [];\n` +
        `for (let i = 0; i < 60; i += 1) { const l = allocate(); out.push(l.city + '/' + l.district); }\n` +
        `console.log(JSON.stringify(out));\n`,
    );
    try {
      const outputs = await Promise.all(
        [0, 1, 2, 3].map(() =>
          run('pnpm', ['exec', 'tsx', script], { cwd: resolve(__dirname, '..'), env: process.env }),
        ),
      );
      const claimed = outputs.flatMap((output) => JSON.parse(output.stdout.trim().split('\n').pop()!) as string[]);
      expect(claimed).toHaveLength(240);
      expect(new Set(claimed).size).toBe(240);
      expect(readdirSync(dir)).toHaveLength(240);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(script, { force: true });
    }
  });
});
