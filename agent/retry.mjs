// Bounded retry for transient RPC failures. A quote or block-number read that fails once must not
// turn into a latched halt: the first side-by-side paper session lost arms to a "missing revert
// data" error from the public RPC at the moment of a switch, when several processes hit the same
// endpoint in the same second. The retry is bounded three ways: a number of attempts, an overall
// wall-clock deadline that covers the waits, and a timeout per attempt (a request that never answers
// is abandoned, since a JSON-RPC call cannot be cancelled). Only errors the caller classifies as
// transient are retried; a deterministic failure is thrown at once. The waits carry a random jitter
// so parallel sessions do not retry in lockstep, and they are stop-aware: an operator stop ends the
// wait instead of outliving it. After the last attempt the last error is thrown unchanged (its
// `retryInfo` says how many attempts were made and why the retry stopped), so the halt semantics of
// the engine (any exception inside a switch latches, unless the engine itself decides otherwise)
// stay exactly as they were.
import { RecordableError } from './errors.mjs';

const DEFAULT_BACKOFF_MS = Object.freeze([1000, 3000, 6000]);

export class RetryTimeoutError extends RecordableError {
  constructor(ms, attempt) {
    super(`attempt ${attempt} timed out after ${ms} ms`);
    this.name = 'RetryTimeoutError';
    this.code = 'TIMEOUT';
  }
}

export class RetryStoppedError extends RecordableError {
  constructor(where, cause) {
    super(`stop requested ${where}`, cause ? { cause } : undefined);
    this.name = 'RetryStoppedError';
    this.code = 'ABORTED';
  }
}

/** Sleep in short slices so a stop request ends the wait early. */
export async function stopAwareSleep(ms, shouldStop = () => false) {
  for (let left = ms; left > 0; left -= 250) {
    if (shouldStop()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 250)));
  }
}

const withTimeout = (promise, ms, attempt) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new RetryTimeoutError(ms, attempt)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

const annotate = (error, info) => {
  try { Object.defineProperty(error, 'retryInfo', { value: info, enumerable: false, configurable: true }); } catch { /* a frozen error keeps its shape */ }
  return error;
};

/**
 * Run `fn(attempt)` up to `attempts` times. `deadlineMs` bounds the whole operation including the
 * waits (null = unbounded); `timeoutMs` bounds one attempt (null = unbounded). `shouldRetry(error)`
 * says whether an error is worth another attempt; `shouldStop()` ends a wait early with an ABORTED
 * error. `onRetry(error, attempt, waitMs)` is called before each wait. The last error is rethrown
 * unchanged, with a non-enumerable `retryInfo { attempts, elapsedMs, stoppedBecause }`.
 */
export async function withRetry(fn, {
  attempts = 3, backoffMs = DEFAULT_BACKOFF_MS, jitterFraction = 0.25, random = Math.random,
  deadlineMs = null, timeoutMs = null, shouldRetry = () => true, shouldStop = () => false,
  now = Date.now, sleep = stopAwareSleep, onRetry = null,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RecordableError('attempts must be a positive integer');
  const startedAt = now();
  const remaining = () => (deadlineMs === null ? Infinity : deadlineMs - (now() - startedAt));
  let lastError; let stoppedBecause = 'attempts'; let made = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (shouldStop()) throw annotate(new RetryStoppedError(`before attempt ${attempt}`, lastError), { attempts: made, elapsedMs: now() - startedAt, stoppedBecause: 'stop' });
    const budget = remaining();
    if (attempt > 1 && budget <= 0) { stoppedBecause = 'deadline'; break; }
    const limit = Math.min(timeoutMs ?? Infinity, budget);
    made = attempt;
    try {
      return await (Number.isFinite(limit) ? withTimeout(Promise.resolve().then(() => fn(attempt)), limit, attempt) : fn(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === attempts) { stoppedBecause = 'attempts'; break; }
      if (!shouldRetry(error)) { stoppedBecause = 'not-retryable'; break; }
      const base = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      const wait = Math.round(base * (1 + jitterFraction * (2 * random() - 1)));
      if (wait >= remaining()) { stoppedBecause = 'deadline'; break; }
      if (onRetry) onRetry(error, attempt, wait);
      await sleep(wait, shouldStop);
      if (shouldStop()) throw annotate(new RetryStoppedError(`during the wait after attempt ${attempt}`, lastError), { attempts: made, elapsedMs: now() - startedAt, stoppedBecause: 'stop' });
    }
  }
  throw annotate(lastError, { attempts: made, elapsedMs: now() - startedAt, stoppedBecause });
}
