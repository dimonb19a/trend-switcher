// Lock tests (R1-C / R1-14): AGENT_TEST=1 node --test agent/test-lock.mjs
// Two controlled interleavings on a fake filesystem with real link/rename
// semantics, then real processes racing for one file on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireLock, claimPath, readLock, releaseLock } from './lock.mjs';

const run = promisify(execFile);
const PATH = '/fake/agent.lock';
const CLAIM = claimPath(PATH);
const owner = (pid) => ({ pid, mode: 'paper', account: '0xabc', chainId: 8453 });

/** A fake filesystem with real link/unlink semantics and hooks to interleave a second starter at a chosen point. */
function fakeFs(hooks = {}) {
  const files = new Map();
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    mkdirSync() {},
    openSync(p, flags) { if (flags === 'wx' && files.has(p)) throw err('EEXIST'); files.set(p, ''); return p; },
    writeSync(fd, data) { files.set(fd, data); },
    closeSync() {},
    linkSync(src, dst) { hooks.beforeLink?.(dst); if (!files.has(src)) throw err('ENOENT'); if (files.has(dst)) throw err('EEXIST'); files.set(dst, files.get(src)); },
    readFileSync(p) { if (!files.has(p)) throw err('ENOENT'); return files.get(p); },
    unlinkSync(p) { hooks.beforeUnlink?.(p); if (!files.has(p)) throw err('ENOENT'); files.delete(p); },
  };
}
const leftovers = (fsx) => [...fsx.files.keys()].filter((k) => k !== PATH);

/** Run starter 202 once, at the first call of `hook` that matches `when`. */
function interleave(when, alive, results) {
  let done = false;
  return (arg) => { if (!done && when(arg)) { done = true; results[202] = acquireLock({ path: PATH, owner: owner(202), fsx: results.fsx, isAlive: (p) => alive.has(p), clock: () => 1 }); } };
}

test('R1-14: two simultaneous starters on the schedule A:check → B:check+write → A:write end with exactly one owner', () => {
  const alive = new Set([101, 202]); const results = {};
  results.fsx = fakeFs({ beforeLink: interleave((dst) => dst === PATH, alive, results) });
  results[101] = acquireLock({ path: PATH, owner: owner(101), fsx: results.fsx, isAlive: (p) => alive.has(p), clock: () => 2 });
  assert.equal(results[202].ok, true);
  assert.equal(results[101].ok, false); assert.equal(results[101].holder.pid, 202);
  assert.equal(readLock({ path: PATH, fsx: results.fsx }).pid, 202);
  assert.deepEqual(leftovers(results.fsx), [], 'temporary records are cleaned up');
});

test('R1-14: a dead holder, two simultaneous recoverers: the one that completes first owns, the other finds a live holder', () => {
  const alive = new Set([101, 202]); const results = {};
  results.fsx = fakeFs({ beforeLink: interleave((dst) => dst === CLAIM, alive, results) }); // B runs while A reaches for the claim
  results.fsx.files.set(PATH, JSON.stringify({ pid: 999, mode: 'paper' })); // 999 is dead
  results[101] = acquireLock({ path: PATH, owner: owner(101), fsx: results.fsx, isAlive: (p) => alive.has(p), clock: () => 2 });
  assert.equal(results[202].ok, true); assert.equal(results[202].recovered.pid, 999);
  assert.equal(results[101].ok, false); assert.equal(results[101].holder.pid, 202, 'A re-reads under its claim and sees the live owner');
  assert.equal(readLock({ path: PATH, fsx: results.fsx }).pid, 202);
  assert.deepEqual(leftovers(results.fsx), [], 'no claim or temporary files remain');
});

test('R1-14: a dead holder, a second starter arriving while the first holds the claim: it refuses and names the claim', () => {
  const alive = new Set([101, 202]); const results = {};
  results.fsx = fakeFs({ beforeUnlink: interleave((p) => p === PATH, alive, results) }); // B runs while A, claim in hand, removes the dead record
  results.fsx.files.set(PATH, JSON.stringify({ pid: 999, mode: 'paper' }));
  results[101] = acquireLock({ path: PATH, owner: owner(101), fsx: results.fsx, isAlive: (p) => alive.has(p), clock: () => 2 });
  assert.equal(results[101].ok, true); assert.equal(results[101].recovered.pid, 999);
  assert.equal(results[202].ok, false); assert.match(results[202].reason, /being recovered.*claim/u);
  assert.equal(readLock({ path: PATH, fsx: results.fsx }).pid, 101);
  assert.deepEqual(leftovers(results.fsx), []);
});

test('an abandoned claim is never removed automatically: the starter refuses and says which file to remove', () => {
  const fsx = fakeFs();
  fsx.files.set(PATH, JSON.stringify({ pid: 999, mode: 'paper' }));
  fsx.files.set(CLAIM, JSON.stringify({ pid: 998, mode: 'paper' }));
  const r = acquireLock({ path: PATH, owner: owner(1), fsx, isAlive: () => false, clock: () => 1 });
  assert.equal(r.ok, false); assert.match(r.reason, /remove the claim file/u);
  assert.ok(fsx.files.has(CLAIM) && fsx.files.has(PATH), 'nothing of anyone else\'s was touched');
});

test('sequentially: a live holder refuses, a dead one is recovered, release only removes our own record, the record carries the scope', () => {
  const fsx = fakeFs();
  const first = acquireLock({ path: PATH, owner: owner(1), fsx, isAlive: () => true, clock: () => 1 });
  assert.equal(first.ok, true);
  assert.deepEqual(readLock({ path: PATH, fsx }), { pid: 1, mode: 'paper', account: '0xabc', chainId: 8453, since: new Date(1).toISOString() });
  const second = acquireLock({ path: PATH, owner: owner(2), fsx, isAlive: () => true, clock: () => 2 });
  assert.equal(second.ok, false); assert.equal(second.holder.pid, 1);
  releaseLock({ path: PATH, pid: 2, fsx });
  assert.equal(readLock({ path: PATH, fsx }).pid, 1, 'someone else\'s record is left alone');
  const third = acquireLock({ path: PATH, owner: owner(3), fsx, isAlive: (p) => p !== 1, clock: () => 3 });
  assert.equal(third.ok, true, 'a dead holder is recovered'); assert.equal(third.recovered.pid, 1);
  releaseLock({ path: PATH, pid: 3, fsx });
  assert.equal(readLock({ path: PATH, fsx }), null);
  assert.deepEqual(leftovers(fsx), []);
});

test('R1-14: eight real processes starting at once on one lock file: exactly one owner per round', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-lock-'));
  try {
    const lockPath = join(dir, 'agent.lock');
    const script = `import { acquireLock } from ${JSON.stringify(new URL('./lock.mjs', import.meta.url).href)};
      const r = acquireLock({ path: process.argv[1], owner: { pid: process.pid, mode: 'test', account: 'x', chainId: 8453 } });
      console.log(r.ok ? 'OWNER' : 'REFUSED');
      await new Promise((res) => setTimeout(res, 1500));`;
    for (let round = 0; round < 2; round += 1) {
      const outs = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', script, lockPath])));
      const verdicts = outs.map((o) => o.stdout.trim());
      assert.equal(verdicts.filter((v) => v === 'OWNER').length, 1, `round ${round}: ${verdicts.join(',')}`);
      // the winner exited without releasing: its record is stale for the next round and must be recovered, not honoured
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
