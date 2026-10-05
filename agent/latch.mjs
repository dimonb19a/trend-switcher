// The daily loss latch and the calendar.
//
// Live, a latched daily loss waits for the owner's `--reset-halt`: a machine does not decide that a bad day
// is over. Two places may lift it by the calendar instead, both paper only: a replay (no owner sits at a
// simulated clock) and a paper run with PAPER_DAILY_LATCH_LIFT=midnight, which writes the same operator
// policy down as a rule: "the day after a losing day, trading resumes". Nothing else is ever lifted here:
// the kill limit, a switch-level halt and an UNKNOWN bill keep their latch.
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const isDailyLossLatch = (halt) => Boolean(halt) && typeof halt.reason === 'string'
  && /daily net loss/u.test(halt.reason) && !/kill limit/u.test(halt.reason);

/**
 * The replay's midnight rule: a latched DAILY loss limit is lifted when the simulated UTC day changes,
 * and nothing else is. Returns true when a latch was lifted.
 */
export function liftDailyLatchAtMidnight(ledger, mode = 'paper') {
  if (!isDailyLossLatch(ledger.kv.get(`halt:${mode}`))) return false;
  if (ledger.requiredHalts().length > 0) return false;
  ledger.resetHalt();
  return true;
}

/**
 * The same rule for a clock that is not driven by a loop of days: a latched daily loss is lifted once the UTC
 * day it latched on is over, whenever the next tick comes (a restart in between changes nothing). Returns the
 * day the latch was set on when it was lifted, otherwise null.
 */
export function liftDailyLatchAfterItsDay(ledger, mode, nowMs) {
  const halt = ledger.kv.get(`halt:${mode}`);
  if (!isDailyLossLatch(halt)) return null;
  const at = Date.parse(halt.at ?? '');
  if (!Number.isFinite(at) || !Number.isFinite(nowMs) || utcDay(nowMs) <= utcDay(at)) return null;
  if (ledger.requiredHalts().length > 0) return null;
  ledger.resetHalt();
  return utcDay(at);
}
