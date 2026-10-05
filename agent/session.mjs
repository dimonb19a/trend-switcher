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

// ---- A long paper run ---------------------------------------------------------------------------------
// The open-ended loop with an end written down (`--until <UTC instant>`). A timed session is a measurement of
// hours on a fresh ledger and dies with its process; a long run is days or weeks on ONE ledger and is meant to
// be restarted: after a reboot the same command continues where the ledger stands, and the ticks in between
// are simply missing. Paper with a virtual capital only.
export const LONG_RUN_MAX_DAYS = 45;
const DAY_MS = 86_400_000;

/**
 * { absent: true } without `--until`; { ok: true, deadline } when the run may start or continue; { refuse } otherwise.
 * A run nobody watches must not be able to idle for a month: every setting whose absence would leave the agent alive
 * but unable to vote or to act is checked here, before the first tick.
 */
export function resolveLongRun({ until, now, cfg, timed = false, once = false, live = false, noJudge = false, judgeKeySet = false, judgePriced = false }) {
  if (until === undefined || until === null) return { absent: true };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/u.test(String(until)) || !Number.isFinite(Date.parse(until))) return { refuse: '--until must be a UTC instant such as 2026-11-06T00:00:00Z' };
  const deadline = Date.parse(until);
  if (timed || once) return { refuse: '--until does not combine with --duration-minutes or --once' };
  if (live || cfg.mode !== 'paper') return { refuse: '--until is for paper runs only' };
  if (cfg.paperCapitalUsd === null) return { refuse: '--until needs a virtual capital (PAPER_CAPITAL_USD)' };
  if (!Number.isFinite(now)) return { refuse: 'no clock' };
  if (deadline <= now) return { refuse: `--until ${until} is not in the future: this run is over`, over: true };
  if (deadline - now > LONG_RUN_MAX_DAYS * DAY_MS) return { refuse: `--until is more than ${LONG_RUN_MAX_DAYS} days ahead` };
  const needs = [];
  if (noJudge) needs.push('the judge (no --no-judge)');
  if (!judgeKeySet || !cfg.judgeBaseUrl || !cfg.judgeModel) needs.push('the judge endpoint, model pin and key');
  if (!judgePriced) needs.push('the judge prices (without them every bill is UNKNOWN and every answer is discarded)');
  if (!cfg.paperContinueUnknownBilling) needs.push('PAPER_CONTINUE_UNKNOWN_BILLING=true (without it the first bill that cannot be established ends the run for good)');
  if (cfg.requireDeepseek && !cfg.hasDeepseekKey) needs.push('the slow-brain key, or REQUIRE_DEEPSEEK=false');
  if (needs.length) return { refuse: `it needs ${needs.join('; ')}` };
  return { ok: true, deadline };
}

/** The run's own record in the ledger (`run:paper`): one per ledger, extended at every start. */
export function noteLongRunStart(ledger, { deadline, tickMs, now }) {
  const prev = ledger.kv.get('run:paper');
  const startedAt = new Date(now).toISOString();
  const until = new Date(deadline).toISOString();
  const record = {
    kind: 'long paper run', status: 'running', firstStartAt: prev?.firstStartAt ?? startedAt, until, tickMs,
    startCount: (prev?.startCount ?? 0) + 1, starts: [...(prev?.starts ?? []), startedAt].slice(-40),
    untilChanged: prev && prev.until !== until ? [...(prev.untilChanged ?? []), { from: prev.until, to: until, at: startedAt }] : (prev?.untilChanged ?? []),
    configHash: ledger.provenance?.configHash ?? null, endedAt: null, stopReason: null,
  };
  ledger.kv.set('run:paper', record);
  return record;
}

export function noteLongRunStop(ledger, { now, reason, completed }) {
  const prev = ledger.kv.get('run:paper');
  if (!prev) return null;
  const record = { ...prev, status: completed ? 'completed' : 'stopped', endedAt: new Date(now).toISOString(), stopReason: reason };
  ledger.kv.set('run:paper', record);
  return record;
}

/**
 * A blind process is worse than a dead one: when the tape has given no usable price for this long, the loop ends with a
 * failure so that whatever keeps the run alive starts a fresh process and a fresh connection.
 */
export function staleTooLong({ staleSinceMs, now, tickMs, limitMs = 15 * 60_000 }) {
  if (!Number.isFinite(staleSinceMs) || !Number.isFinite(now)) return false;
  return now - staleSinceMs >= Math.max(limitMs, 3 * tickMs);
}

