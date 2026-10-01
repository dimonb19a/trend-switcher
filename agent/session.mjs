import { RecordableError } from './errors.mjs';
// A bounded paper session. Slots belong to the wall clock; an overlong tick
// consumes later slots rather than creating a burst of late API requests.
export async function runTimedSession({ ledger, engine, durationMs, tickMs, clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), shouldStop = () => false,
  stopReason = () => 'operator stop' }) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(tickMs) || tickMs <= 0) throw new RecordableError('positive integer duration and tick interval required');
  const start = clock();
  const end = start + durationMs;
  const planned = Math.ceil(durationMs / tickMs);
  const iso = (ms) => new Date(ms).toISOString();
  const manifest = { status: 'running', startedAt: iso(start), deadlineAt: iso(end), tickMs, plannedSlots: planned,
    attemptedSlots: 0, missedSlots: 0, unattemptedSlots: 0, completedSlots: 0, stopReason: null, endedAt: null,
    configHash: ledger.provenance?.configHash ?? null, sourceHash: ledger.provenance?.sourceHash ?? null };
  ledger.kv.set('session:paper', manifest);
  try {
    let nextIndex = 0;
    for (let index = 0; index < planned; index += 1) {
      nextIndex = index;
      const scheduled = start + index * tickMs;
      if (shouldStop() || clock() >= end) { manifest.stopReason = shouldStop() ? stopReason() : 'deadline'; break; }
      if (clock() < scheduled) await sleep(scheduled - clock());
      if (shouldStop() || clock() >= end) { manifest.stopReason = shouldStop() ? stopReason() : 'deadline'; break; }
      if (clock() >= scheduled + tickMs) {
        manifest.missedSlots += 1;
        ledger.observe('slot', { index, scheduledAt: iso(scheduled), status: 'missed', reason: 'previous tick exceeded slot' });
        ledger.kv.set('session:paper', manifest);
        nextIndex = index + 1;
        continue;
      }
      const began = clock();
      manifest.attemptedSlots += 1;
      let output;
      try { output = await engine.tick(); }
      catch (error) { output = { stop: true, error: error.message }; }
      manifest.completedSlots += 1;
      ledger.observe('slot', { index, scheduledAt: iso(scheduled), startedAt: iso(began), endedAt: iso(clock()),
        status: 'completed', output });
      ledger.kv.set('session:paper', manifest);
      nextIndex = index + 1;
      if (output?.stop || output?.error) { manifest.stopReason = output.reason ?? output.error ?? 'engine stop'; break; }
    }
    if (!manifest.stopReason && !shouldStop() && clock() < end) await sleep(end - clock());
    manifest.stopReason ??= shouldStop() ? stopReason() : clock() >= end ? 'deadline' : 'early end';
    for (let index = nextIndex; index < planned; index += 1) {
      ledger.observe('slot', { index, scheduledAt: iso(start + index * tickMs), status: 'not-run', reason: manifest.stopReason });
      manifest.unattemptedSlots += 1;
    }
    manifest.status = manifest.stopReason === 'deadline' ? 'completed' : 'stopped';
    return manifest;
  } catch (error) {
    manifest.status = 'failed'; manifest.stopReason = error.message;
    throw error;
  } finally {
    manifest.endedAt = iso(clock());
    engine.finalizeValuation('session end');
    ledger.kv.set('session:paper', manifest);
    ledger.observe('session', manifest);
  }
}
