// The one-line status of a run: the facts it reads from a ledger and the things it flags for a look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE_MS, CANDLE_MS } from './replay-feed.mjs';
import { runReplay } from './replay.mjs';
import { noteLongRunStart } from './session.mjs';
import { buildStatus, renderStatus } from './status.mjs';
import { agreeingSummary, fakeJudge, flatSummary, makeCfg } from './test-helpers.mjs';

const T0 = Date.parse('2021-05-01T00:00:00Z');
function synthetic({ fromMs, hours, price }) {
  const minutes = [];
  for (let t = fromMs; t < fromMs + hours * 3600_000; t += MINUTE_MS) { const o = price(t); const c = price(t + MINUTE_MS - 1) * 1.0005; minutes.push({ t, open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c, volume: 10 }); }
  const fives = [];
  for (let t = fromMs; t < fromMs + hours * 3600_000; t += CANDLE_MS) { const m = minutes.filter((x) => x.t >= t && x.t < t + CANDLE_MS); fives.push({ t, open: m[0].open, high: Math.max(...m.map((x) => x.high)), low: Math.min(...m.map((x) => x.low)), close: m[m.length - 1].close, volume: 50 }); }
  return { minutes, fives };
}

async function fallingRun(env = {}) {
  const cfg = makeCfg({ PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', REQUIRE_DEEPSEEK: 'false', RISK_PRESET: 'trend', ...env });
  const start = T0 + 26 * 3600_000;
  const price = (t) => (t < start ? 3000 : 3000 - 0.5 * ((t - start) / MINUTE_MS));
  const { minutes, fives } = synthetic({ fromMs: T0, hours: 27, price });
  let votes = 0;
  const judge = fakeJudge(() => (votes++ < 2 ? flatSummary() : agreeingSummary('USDC')));
  const toMs = start + 40 * MINUTE_MS;
  const { ledger } = await runReplay({ cfg, minutes, fiveMinutes: fives, fromMs: start, toMs, warmupMs: 26 * 3600_000, judge, judgeEnabled: true, keepLedgerOpen: true });
  return { ledger, cfg, start, toMs };
}

test('the status of a run that sold in a fall: side, worth against the start and against holding, the switch, the judge, the last tick', async () => {
  const { ledger, toMs } = await fallingRun();
  try {
    const s = buildStatus({ db: ledger.db, now: toMs + 30_000 });
    assert.equal(s.side, 'USDC'); assert.equal(s.strategy, 'votes'); assert.equal(s.asset, 'ETH'); assert.equal(s.tickMs, 60_000);
    assert.ok(s.switches >= 1); assert.equal(s.lastSwitch.to, 'USDC');
    assert.ok(s.holdPct < 0 && s.netPct > s.holdPct, `the arm sat out part of the fall: ${s.netPct} against ${s.holdPct}`);
    assert.ok(s.holdWorstDropPct > s.worstDropPct);
    assert.equal(s.judge.calls, 40); assert.equal(s.judge.errors, 0); assert.equal(s.unknownBills, 0); assert.equal(s.halt, null); assert.equal(s.dailyLatchLifts, 0);
    assert.ok(s.lastTickAgeMs >= 30_000 && s.lastTickAgeMs < 5 * 60_000);
    assert.equal(s.run.kind, 'replay'); assert.equal(s.over, true, 'the replay has ended');
    assert.deepEqual(s.attention, []);
    const line = renderStatus(s);
    assert.ok(!line.includes('\n') && !line.startsWith('ATTENTION'));
    assert.match(line, /in USDC \| \$\d[\d,]*\.\d\d [+-]\d+\.\d\d % \| hold -\d+\.\d\d %/u);
    assert.ok(/^[\x20-\x7e]*$/u.test(line), 'the line is plain ASCII');
    assert.match(line, /switch(es)?, last 2021-05-02T\d\d:\d\dZ to USDC \| no halt/u);
  } finally { ledger.close(); }
});

test('what the line flags: a process that stopped ticking, a latch the calendar does not lift, a daily latch without the knob, a restart loop', async () => {
  const { ledger, toMs, start } = await fallingRun();
  try {
    // a long run in progress on this ledger, last seen 40 minutes ago
    noteLongRunStart(ledger, { deadline: toMs + 20 * 86_400_000, tickMs: 60_000, now: start });
    const silent = buildStatus({ db: ledger.db, now: toMs + 40 * 60_000 });
    assert.equal(silent.over, false); assert.equal(silent.run.kind, 'long paper run'); assert.equal(silent.run.starts, 1);
    assert.match(silent.attention.join('; '), /no tick for 4\d min: the process is not running/u);
    assert.ok(renderStatus(silent).startsWith('ATTENTION: no tick for'));
    // fresh ticks, but a kill latch
    ledger.latchHalt('risk (tick): total net loss -31.00% beyond the kill limit 30%');
    const killed = buildStatus({ db: ledger.db, now: toMs + 30_000 });
    assert.match(killed.attention.join('; '), /halted; this latch is not lifted by the calendar/u);
    assert.match(renderStatus(killed), /HALT since 2021-05-02T\d\d:\d\dZ: risk \(tick\): total net loss/u);
    ledger.resetHalt();
    // a daily latch on a run configured without PAPER_DAILY_LATCH_LIFT: someone has to reset it
    ledger.latchHalt('risk (tick): daily net loss -3.20% beyond the daily limit 3%');
    assert.match(buildStatus({ db: ledger.db, now: toMs + 30_000 }).attention.join('; '), /daily loss latched; waits for --reset-halt/u);
    ledger.resetHalt();
    for (let i = 0; i < 9; i += 1) noteLongRunStart(ledger, { deadline: toMs + 20 * 86_400_000, tickMs: 60_000, now: start + i * 60_000 });
    assert.match(buildStatus({ db: ledger.db, now: toMs + 30_000 }).attention.join('; '), /10 starts: the process keeps restarting/u);
  } finally { ledger.close(); }
});

test('with the midnight knob a latched daily loss is not flagged: the calendar lifts it', async () => {
  const { ledger, toMs } = await fallingRun({ PAPER_DAILY_LATCH_LIFT: 'midnight' });
  try {
    ledger.latchHalt('risk (tick): daily net loss -3.20% beyond the daily limit 3%');
    const s = buildStatus({ db: ledger.db, now: toMs + 30_000 });
    assert.ok(s.halt && /daily net loss/u.test(s.halt.reason));
    assert.deepEqual(s.attention, []);
    assert.match(renderStatus(s), /HALT since .*daily net loss/u);
  } finally { ledger.close(); }
});
