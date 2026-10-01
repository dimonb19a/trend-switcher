// Bounded retry for transient RPC failures: AGENT_TEST=1 node --test agent/test-retry.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryStoppedError, RetryTimeoutError, stopAwareSleep, withRetry } from './retry.mjs';

const noJitter = { jitterFraction: 0 };

test('a call that fails twice and then succeeds returns the value after two bounded waits', async () => {
  const waits = []; const retries = []; let calls = 0;
  const value = await withRetry(async (attempt) => { calls += 1; if (attempt < 3) throw new Error(`missing revert data #${attempt}`); return 'quoted'; },
    { ...noJitter, attempts: 3, backoffMs: [10, 20, 30], sleep: async (ms) => { waits.push(ms); }, onRetry: (error, attempt, wait) => retries.push([error.message, attempt, wait]) });
  assert.equal(value, 'quoted'); assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(retries, [['missing revert data #1', 1, 10], ['missing revert data #2', 2, 20]]);
});

test('after the last attempt the last error is thrown unchanged, with retryInfo naming the attempts, so the engine halt semantics stay intact', async () => {
  let calls = 0; const boom = new Error('missing revert data');
  await assert.rejects(withRetry(async () => { calls += 1; throw boom; }, { ...noJitter, attempts: 3, sleep: async () => {} }),
    (error) => error === boom && error.retryInfo.attempts === 3 && error.retryInfo.stoppedBecause === 'attempts');
  assert.equal(calls, 3);
});

test('attempts=1 means no retry; a bad attempts value is refused', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new Error('once'); }, { ...noJitter, attempts: 1, sleep: async () => { throw new Error('must not sleep'); } }), /once/u);
  assert.equal(calls, 1);
  await assert.rejects(withRetry(async () => 'x', { attempts: 0 }), /positive integer/u);
});

test('a backoff list shorter than the attempts reuses its last delay', async () => {
  const waits = [];
  await assert.rejects(withRetry(async () => { throw new Error('always'); }, { ...noJitter, attempts: 4, backoffMs: [5], sleep: async (ms) => { waits.push(ms); } }), /always/u);
  assert.deepEqual(waits, [5, 5, 5]);
});

test('jitter spreads the waits within ±25 % of the base so parallel sessions do not retry in lockstep', async () => {
  const waits = [];
  await assert.rejects(withRetry(async () => { throw new Error('always'); }, { attempts: 3, backoffMs: [1000, 1000], jitterFraction: 0.25, random: () => 0, sleep: async (ms) => { waits.push(ms); } }), /always/u);
  assert.deepEqual(waits, [750, 750]);
  waits.length = 0;
  await assert.rejects(withRetry(async () => { throw new Error('always'); }, { attempts: 2, backoffMs: [1000], jitterFraction: 0.25, random: () => 1, sleep: async (ms) => { waits.push(ms); } }), /always/u);
  assert.deepEqual(waits, [1250]);
  const defaults = await withRetry(async (attempt) => { if (attempt < 2) throw new Error('x'); return 'ok'; }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(defaults, 'ok'); assert.ok(waits[1] >= 750 && waits[1] <= 1250, `default first wait with jitter: ${waits[1]}`);
});

test('the overall deadline covers the waits: no wait starts that would end past it, and the last error names the deadline', async () => {
  let now = 0; const waits = []; const error = new Error('transient');
  await assert.rejects(withRetry(async () => { now += 100; throw error; },
    { ...noJitter, attempts: 5, backoffMs: [1000, 3000, 6000], deadlineMs: 5000, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } }),
  (e) => e === error && e.retryInfo.stoppedBecause === 'deadline' && e.retryInfo.attempts === 3);
  assert.deepEqual(waits, [1000, 3000]); // 100 + 1000 + 100 + 3000 + 100 = 4300 ms spent; a 6000 ms wait would end past 5000 ms
});

test('a per-attempt timeout abandons an attempt that never answers and counts as a transient failure', async () => {
  let calls = 0;
  await assert.rejects(withRetry(() => { calls += 1; return new Promise(() => {}); }, { ...noJitter, attempts: 2, backoffMs: [1], timeoutMs: 20 }),
    (e) => e instanceof RetryTimeoutError && e.code === 'TIMEOUT' && e.retryInfo.attempts === 2);
  assert.equal(calls, 2);
});

test('an error the caller classifies as deterministic is thrown at once, without a wait', async () => {
  let calls = 0; const revert = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' });
  await assert.rejects(withRetry(async () => { calls += 1; throw revert; },
    { ...noJitter, attempts: 4, shouldRetry: (e) => e.data === null || e.data === undefined, sleep: async () => { throw new Error('must not wait'); } }),
  (e) => e === revert && e.retryInfo.stoppedBecause === 'not-retryable');
  assert.equal(calls, 1);
});

test('an operator stop ends the wait and surfaces as ABORTED with the last error as its cause', async () => {
  let stop = false; const failing = new Error('transient');
  await assert.rejects(withRetry(async () => { throw failing; }, { ...noJitter, attempts: 3, backoffMs: [10], shouldStop: () => stop, sleep: async () => { stop = true; } }),
    (e) => e instanceof RetryStoppedError && e.code === 'ABORTED' && e.cause === failing && e.retryInfo.stoppedBecause === 'stop');
  await assert.rejects(withRetry(async () => 'never called', { shouldStop: () => true }), (e) => e instanceof RetryStoppedError && e.retryInfo.attempts === 0);
});

test('the default sleep returns early when a stop is requested', async () => {
  const started = Date.now(); let stop = false;
  setTimeout(() => { stop = true; }, 30);
  await stopAwareSleep(5000, () => stop);
  assert.ok(Date.now() - started < 2000);
});
