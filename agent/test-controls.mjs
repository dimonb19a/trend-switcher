// The two controls for "is it the judge or the rules?": a random judge that switches as often as the real one
// (the recorded answers shuffled by runs) and no judge at all (a constant "the trend is down"). Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE_MS, CANDLE_MS } from './replay-feed.mjs';
import { runReplay } from './replay.mjs';
import { agreesWith } from './policy.mjs';
import { createConstantJudge, createShuffledJudge, loadRecordedJudgments, shuffleRuns } from './replay-recorded.mjs';
import { agreeingSummary, fakeJudge, flatSummary, makeCfg } from './test-helpers.mjs';

const T0 = Date.parse('2021-05-01T00:00:00Z');
const cfg = makeCfg({ PAPER_CAPITAL_USD: '1000', RISK_PRESET: 'trend' });
const votesDown = (summary) => agreesWith(summary, 'USDC', cfg);
// D = votes for a sale, O = does not, E = a failed reply (no summary)
const record = (pattern) => [...pattern].map((kind, i) => ({ i, kind, ts: new Date(T0 + i * 300_000).toISOString(), state: `state ${i}`, answers: JSON.stringify({ n: i }),
  summary: kind === 'E' ? null : JSON.stringify(kind === 'D' ? agreeingSummary('USDC') : flatSummary()), error: kind === 'E' ? 'reply could not be read' : null,
  cost_usd: 0.0001, ms: 300, model: 'judge-model-1', request_at: null, response_at: null, usage: null }));
const runLengths = (rows, down) => { const out = []; let n = 0; for (const r of rows) { if ((r.kind === 'D') === down) n += 1; else if (n) { out.push(n); n = 0; } } if (n) out.push(n); return out.sort((a, b) => a - b); };
const PATTERN = 'OOODDDDDOOEOODDOOOOOOODDDDDDDDOEODOOOODDDOOOOOOOOODDDDOODDDDDDO';

test('a shuffle keeps every answer, the number of sale votes, the number of runs and their lengths, and changes only the order', () => {
  const rows = record(PATTERN);
  const a = shuffleRuns(rows, { seed: 7, votesDown });
  assert.equal(a.rows.length, rows.length);
  assert.deepEqual(a.rows.map((r) => r.i).sort((x, y) => x - y), rows.map((r) => r.i), 'the same answers, each once');
  assert.equal(a.down, [...PATTERN].filter((k) => k === 'D').length);
  assert.equal(a.runs, 15, 'eight runs without a sale vote and seven with one, as in the record');
  assert.deepEqual(runLengths(a.rows, true), runLengths(rows, true), 'the same lengths of the sale-vote runs');
  assert.deepEqual(runLengths(a.rows, false), runLengths(rows, false), 'the same lengths of the other runs (a failed reply stays inside its run)');
  assert.notDeepEqual(a.rows.map((r) => r.i), rows.map((r) => r.i), 'the order did change');
  assert.equal(a.rows[0].kind === 'D', rows[0].kind === 'D', 'the kinds alternate as they did, starting with the same kind');
  for (let k = 1; k < a.rows.length; k += 1) if (a.rows[k].kind === a.rows[k - 1].kind && a.rows[k].kind === 'D') assert.equal(a.rows[k].i, a.rows[k - 1].i + 1, 'answers inside a run keep their order');
});

test('a shuffle is the same for the same seed, different for another, and refuses a seed that is not a whole number from 1', () => {
  const rows = record(PATTERN);
  const order = (seed) => shuffleRuns(rows, { seed, votesDown }).rows.map((r) => r.i);
  assert.deepEqual(order(3), order(3));
  assert.notDeepEqual(order(3), order(4));
  for (const seed of [0, -1, 1.5, NaN, undefined]) assert.throws(() => shuffleRuns(rows, { seed, votesDown }), /whole seed/u);
});

test('the shuffled judge plays the new order back one answer per call, replays a failed reply as a failure and stops at the end of the record', async () => {
  const rows = record('OODDDEOODD');
  const j = createShuffledJudge(rows, { seed: 2, votesDown });
  const expected = shuffleRuns(rows, { seed: 2, votesDown }).rows;
  assert.equal(j.stats.down, 5); assert.equal(j.stats.runs, 4); assert.equal(j.stats.recorded, 10);
  let failures = 0;
  for (const row of expected) {
    if (row.kind === 'E') { await assert.rejects(() => j.judge('any state'), /could not be read/u); failures += 1; continue; }
    const reply = await j.judge('any state');
    assert.deepEqual(reply.answers, { n: row.i }); assert.equal(reply.costUsd, 0.0001);
    assert.deepEqual(j.summarize(reply.answers), JSON.parse(row.summary));
  }
  assert.equal(failures, 1); assert.equal(j.stats.errorsReplayed, 1); assert.equal(j.stats.calls, 10); assert.equal(j.stats.misses, 0);
  await assert.rejects(() => j.judge('one more'), /shorter than this window/u);
  assert.equal(j.stats.misses, 1);
});

function synthetic({ fromMs, hours, price }) {
  const minutes = [];
  for (let t = fromMs; t < fromMs + hours * 3600_000; t += MINUTE_MS) { const o = price(t); const c = price(t + MINUTE_MS - 1) * 1.0005; minutes.push({ t, open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c, volume: 10 }); }
  const fives = [];
  for (let t = fromMs; t < fromMs + hours * 3600_000; t += CANDLE_MS) { const m = minutes.filter((x) => x.t >= t && x.t < t + CANDLE_MS); fives.push({ t, open: m[0].open, high: Math.max(...m.map((x) => x.high)), low: Math.min(...m.map((x) => x.low)), close: m[m.length - 1].close, volume: 50 }); }
  return { minutes, fives };
}
const start = T0 + 26 * 3600_000;
const falling = synthetic({ fromMs: T0, hours: 28, price: (t) => (t < start ? 3000 : 3000 - 0.5 * ((t - start) / MINUTE_MS)) });
const base = { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', REQUIRE_DEEPSEEK: 'false', RISK_PRESET: 'trend', STRATEGY: 'votes' };
const replay = (judge, minutesOfRun = 60, env = base) => runReplay({ cfg: makeCfg(env), minutes: falling.minutes, fiveMinutes: falling.fives, fromMs: start, toMs: start + minutesOfRun * MINUTE_MS, warmupMs: 26 * 3600_000, judge, judgeEnabled: true, keepLedgerOpen: true });
const sales = (ledger) => ledger.db.prepare("SELECT ts FROM switches WHERE status = 'done' AND to_side = 'USDC' ORDER BY id").all().map((s) => s.ts);

test('no judge at all: the constant answer always votes for a sale and never for a buy, so the deterministic filters alone decide', async () => {
  const constant = createConstantJudge();
  for (const basis of ['trend', 'forecast']) {
    const c = makeCfg({ PAPER_CAPITAL_USD: '1000', RISK_PRESET: basis });
    assert.equal(agreesWith(constant.summary, 'USDC', c), true, basis); assert.equal(agreesWith(constant.summary, 'ETH', c), false, basis);
  }
  const withConstant = await replay(constant);
  const never = await replay(fakeJudge(() => flatSummary()));
  try {
    assert.equal(sales(withConstant.ledger).length, 1, 'in a steady fall the trend filter passes and the constant judge sells once');
    assert.equal(sales(never.ledger).length, 0, 'a judge that never calls the trend down never sells in the same fall');
    assert.equal(constant.stats.calls, 60);
    assert.equal(withConstant.ledger.totals().costs.judge ?? 0, 0, 'the control costs nothing');
  } finally { withConstant.ledger.close(); never.ledger.close(); }
});

test('a random judge from a real record: the shuffled answers replay over the same window without a miss, and a seed can move the sale', async () => {
  let n = 0;
  // the source judge calls the trend down for a stretch in the middle of the fall and nowhere else
  const source = await replay(fakeJudge(() => { n += 1; return n > 20 && n <= 32 ? agreeingSummary('USDC') : flatSummary(); }));
  const rows = loadRecordedJudgments(source.ledger.db);
  const sourceSales = sales(source.ledger); source.ledger.close();
  assert.equal(sourceSales.length, 1);
  const moved = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const j = createShuffledJudge(rows, { seed, votesDown: (s) => agreesWith(s, 'USDC', makeCfg(base)) });
    const out = await replay(j);
    try {
      assert.equal(j.stats.misses, 0); assert.equal(j.stats.calls, rows.length); assert.equal(j.stats.down, 12); assert.equal(j.stats.runs, 3);
      const at = sales(out.ledger);
      assert.ok(at.length <= 1);
      moved.add(at[0] ?? 'none');
    } finally { out.ledger.close(); }
  }
  assert.ok(moved.size >= 1 && [...moved].every((ts) => ts === 'none' || ts >= new Date(start).toISOString()));
});
