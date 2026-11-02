// node --test .github/scripts/cache-confirm.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm } from './cache-confirm.mjs';

const KEY = 'playwright-apt-chromium-ubuntu24-20261026.354.1-pw1.62.1-63f13eaddd1fdfec';
const REF = 'refs/heads/main';
const entry = (over = {}) => ({ key: KEY, ref: REF, ...over });

/** A list() that answers with `answers[n]` on call n (the last one repeats). */
function lister(answers) {
  const calls = [];
  const list = async (key, ref) => {
    calls.push({ key, ref });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { list, calls };
}
const waits = [];
const wait = async (ms) => void waits.push(ms);
const run = (answers, opts = {}) => {
  waits.length = 0;
  const l = lister(answers);
  return confirm({ key: KEY, ref: REF, list: l.list, attempts: 4, delayMs: 5, wait, ...opts }).then((r) => ({ ...r, calls: l.calls }));
};

test('an entry listed on the first look is confirmed without waiting', async () => {
  const r = await run([[entry()]]);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(r.calls[0], { key: KEY, ref: REF });
});

test('an entry that only shows up a few seconds after the save is still confirmed (the main run 41502413097 case)', async () => {
  const r = await run([[], [], [entry()]]);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test('an entry that never shows up is not confirmed, after a bounded number of looks', async () => {
  const r = await run([[]]);
  assert.equal(r.ok, false);
  assert.equal(r.calls.length, 4);
  assert.match(r.reason, /not listed for refs\/heads\/main after 4 attempts/);
});

test('only the exact key on the exact ref counts — a prefix match or another branch does not', async () => {
  const r = await run([[entry({ key: `${KEY}-other` }), entry({ ref: 'refs/pull/9/merge' })]]);
  assert.equal(r.ok, false);
});

test('API errors are retried, and are never read as found', async () => {
  assert.equal((await run([new Error('HTTP 502'), [entry()]])).ok, true);
  const r = await run([new Error('HTTP 403')]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /last: API error: HTTP 403/);
});

test('nothing to look for is a failure, not a pass', async () => {
  assert.equal((await run([[entry()]], { key: '' })).ok, false);
});
