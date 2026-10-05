import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport } from './report.mjs';
import { runTimedSession } from './session.mjs';
import { makeCfg, makeFeed, makeHarness, flatSummary, T0 } from './test-helpers.mjs';
import { openLedger } from './ledger.mjs';

test('T1: the last fill appears in the final wallet even when no next tick arrives', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' }, chainOptions: { executionPrice: 2997 } });
  const out = await h.advance(6);
  assert.equal(out.at(-1).switched, true);
  const paper = h.ledger.kv.get('paper:balances');
  const r = buildReport({ db: h.ledger.db });
  assert.ok(Math.abs(r.result.finalWalletUsd - paper.usdc) < 1e-9);
  assert.ok(r.result.finalWalletUsd < 1000);
  assert.ok(r.result.lines.netAtCapital.usd < -1);
  assert.equal(r.header.valuationSource, 'post-tick paper balances');
  assert.equal(r.result.lines.projection.capitalUsd, null);
  h.ledger.close();
});

test('T1: unknown inference spend survives reset and restart; no invented zero or second call', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' },
    confirmFn: () => ({ ok: false, reason: 'HTTP 503' }) });
  const out = await h.advance(6);
  assert.equal(out.at(-1).stop, true);
  const row = h.ledger.db.prepare("SELECT * FROM inference_calls WHERE provider='deepseek'").get();
  assert.equal(row.billing, 'UNKNOWN'); assert.equal(row.usd, null);
  assert.equal(h.ledger.db.prepare("SELECT COUNT(*) AS n FROM costs WHERE kind='deepseek'").get().n, 0);
  const r = buildReport({ db: h.ledger.db });
  assert.equal(r.calls.deepseek.calls, 1);
  assert.equal(r.result.lines.netAtCapital.usd, null);
  h.ledger.resetHalt();
  assert.equal((await h.engine.tick()).stop, true);
  assert.equal(h.state.confirmCalls, 1);
  h.ledger.close();
});

test('T1 paper exception keeps ticking after malformed judge billing, without votes or invented net', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', PAPER_CONTINUE_UNKNOWN_BILLING: 'true' }, summary: flatSummary });
  try {
    const originalJudge = h.judge.judge;
    h.judge.judge = async () => { throw new Error('response contains a missing or invalid answer'); };
    const failed = await h.advance(3);
    assert.ok(failed.every((out) => !out.stop && !out.error), JSON.stringify(failed));
    assert.equal(h.ledger.unknownInference().length, 3);
    assert.equal(h.ledger.stats(1000).halt, null);
    assert.equal(h.ledger.stats(1000).inferenceUnknownReserveUsd, 0.003);
    assert.equal(h.ledger.db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 0);
    h.judge.judge = originalJudge;
    const recovered = await h.engine.tick();
    assert.equal(recovered.stop, undefined);
    assert.equal(h.ledger.unknownInference().length, 3, 'UNKNOWN bills remain visible');
    const r = buildReport({ db: h.ledger.db });
    assert.equal(r.calls.billingUnknown.length, 3);
    assert.equal(r.calls.budget.unknownReservedUsd, 0.003);
    assert.equal(r.result.lines.netAtCapital.usd, null);
    assert.equal(r.result.provisional, true);
  } finally { h.ledger.close(); }
});

test('T1 paper exception holds an unpriced DeepSeek answer and continues the next tick', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', PAPER_CONTINUE_UNKNOWN_BILLING: 'true' },
    confirmFn: () => ({ ok: true, agrees: true, stance: 'USDC', confidence: 0.8 }) });
  try {
    const out = await h.advance(7);
    assert.equal(out[5].held, 'slow-brain billing UNKNOWN');
    assert.equal(out[6].stop, undefined);
    assert.equal(h.ledger.stats(1000).halt, null);
    assert.equal(h.ledger.db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 0);
    assert.equal(h.ledger.db.prepare("SELECT billing FROM inference_calls WHERE provider='deepseek'").get().billing, 'UNKNOWN');
    assert.equal(h.ledger.db.prepare("SELECT outcome FROM decisions WHERE stage='slow-brain'").get().outcome, 'held');
  } finally { h.ledger.close(); }
});

test('T1 paper exception reserves unknown calls against the budget and keeps the session alive', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', PAPER_CONTINUE_UNKNOWN_BILLING: 'true',
    PAPER_UNKNOWN_BILL_RESERVE_USD: '0.01', INFERENCE_BUDGET_USD_PER_DAY: '0.05' } });
  try {
    h.judge.judge = async () => { throw new Error('unpriced reply'); };
    const out = await h.advance(6);
    assert.ok(out.every((tick) => !tick.stop && !tick.error), JSON.stringify(out));
    assert.equal(h.ledger.unknownInference().length, 5);
    assert.equal(h.ledger.stats(1000).inferenceBudgetCommittedUsd, 0.05);
    assert.equal(h.ledger.stats(1000).halt, null);
  } finally { h.ledger.close(); }
});

test('T1 paper exception reaches its timed deadline despite UNKNOWN judge bills', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', PAPER_CONTINUE_UNKNOWN_BILLING: 'true' } });
  try {
    h.judge.judge = async () => { throw new Error('malformed vendor answer'); };
    const manifest = await runTimedSession({ ledger: h.ledger, engine: h.engine,
      durationMs: 3 * 60_000, tickMs: 60_000, clock: h.clock, sleep: async (ms) => h.wait(ms) });
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.attemptedSlots, 3);
    assert.equal(manifest.missedSlots, 0);
    assert.equal(h.ledger.unknownInference().length, 3);
    assert.equal(h.ledger.stats(1000).halt, null);
  } finally { h.ledger.close(); }
});

test('T1: a paid judge reply retains its known bill when summary parsing fails', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' }, summary: flatSummary, trendUp: false });
  try {
    await h.engine.tick(); h.wait(60_000);
    h.judge.judge = async () => ({ model: 'judge-model-1', answers: {}, usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 40 });
    h.judge.summarize = () => { throw new Error('synthetic malformed answers'); };
    await h.engine.tick();
    const call = h.ledger.db.prepare('SELECT * FROM inference_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(call.billing, 'KNOWN'); assert.equal(call.usd, 40);
    assert.equal(h.ledger.db.prepare("SELECT COUNT(*) AS n FROM costs WHERE kind='judge' AND usd=40").get().n, 1);
    assert.match(h.ledger.stats(1000).halt.reason, /risk \(judgment cost\)/u);
    assert.equal(h.ledger.db.prepare('SELECT summary FROM judgments ORDER BY id DESC LIMIT 1').get().summary, null);
  } finally { h.ledger.close(); }
});

test('T1: a charged model-pin rejection evaluates risk at the post-wait price', async () => {
  for (const [price, expectHalt] of [[2700, true], [3150, false]]) {
    const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' }, summary: flatSummary, trendUp: false });
    try {
      await h.engine.tick(); h.wait(60_000);
      h.judge.judge = async () => {
        h.feed.snapshot = makeFeed({ price, trendUp: false }).snapshot;
        throw Object.assign(new Error('synthetic model pin mismatch'), { costUsd: 0.0002,
          usage: { input_tokens: 10, output_tokens: 10 }, model: 'wrong-pin' });
      };
      await h.engine.tick();
      const call = h.ledger.db.prepare('SELECT * FROM inference_calls ORDER BY id DESC LIMIT 1').get();
      assert.equal(call.billing, 'KNOWN'); assert.equal(call.usd, 0.0002);
      assert.equal(Boolean(h.ledger.stats(price).halt), expectHalt, `post-wait price ${price}`);
      assert.equal(h.ledger.db.prepare("SELECT COUNT(*) AS n FROM costs WHERE kind='judge' AND usd=0.0002").get().n, 1);
    } finally { h.ledger.close(); }
  }
});

test('T1: a dispatched attempt remains UNKNOWN after reopening its file ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-t1-'));
  const cfg = makeCfg({ AGENT_DB_PATH: join(dir, 'run.db') });
  let ledger;
  try {
    ledger = openLedger(cfg, { clock: () => T0 });
    ledger.beginInference('judge');
    ledger.close(); ledger = openLedger(cfg, { clock: () => T0 + 60_000 });
    assert.equal(ledger.unknownInference().length, 1);
    assert.equal(buildReport({ db: ledger.db }).calls.judge.calls, 1);
  } finally { try { ledger?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test('T1: a 61-minute observation cannot label the 15-minute horizon', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' } });
  await h.advance(6);
  const switchAt = Date.parse(h.ledger.db.prepare('SELECT ts FROM switches').get().ts);
  h.setNow(switchAt + 61 * 60_000);
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 2900, trendUp: false }).snapshot;
  await h.engine.tick();
  const r = buildReport({ db: h.ledger.db });
  assert.equal(r.switches[0].horizons['15m'], null);
  assert.equal(r.switches[0].horizons['60m'].lateMs, 60_000);
  h.ledger.close();
});

test('T1: compressed input keeps the exact public snapshot used for the tick', () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' } });
  const snap = makeFeed({ eventAt: T0 }).snapshot(T0);
  h.ledger.captureInput(snap);
  const row = h.ledger.db.prepare('SELECT codec,payload FROM market_inputs').get();
  assert.equal(row.codec, 'json+gzip');
  assert.deepEqual(JSON.parse(gunzipSync(row.payload).toString('utf8')), snap);
  h.ledger.close();
});

test('T1: 30 wall-clock slots stay bounded, and a slow tick records missed slots without bursts', async () => {
  let now = T0; let calls = 0;
  const clock = () => now;
  const ledger = openLedger(makeCfg(), { clock });
  const engine = { async tick() { calls += 1; if (calls === 3) now += 130_000; return { candidate: null }; },
    finalizeValuation() {} };
  const manifest = await runTimedSession({ ledger, engine, durationMs: 30 * 60_000, tickMs: 60_000,
    clock, sleep: async (ms) => { now += ms; } });
  assert.equal(manifest.plannedSlots, 30);
  assert.equal(manifest.missedSlots, 1);
  assert.equal(manifest.unattemptedSlots, 0);
  assert.equal(manifest.attemptedSlots, 29);
  assert.equal(manifest.status, 'completed');
  assert.equal(now, T0 + 30 * 60_000);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE kind='slot'").get().n, 30);
  const report = buildReport({ db: ledger.db });
  assert.equal(report.time.plannedTicks, 30);
  assert.match(report.header.sourceHash, /^[0-9a-f]{16}$/u);
  assert.equal(report.header.agentVersion, '2.16.0');
  ledger.close();
});

test('T1: a stop during a tick drains that tick and preserves an early-stop manifest', async () => {
  let now = T0; let stop = false;
  const clock = () => now;
  const ledger = openLedger(makeCfg(), { clock });
  const engine = { async tick() { now += 42_000; stop = true; return { candidate: null }; }, finalizeValuation() {} };
  const manifest = await runTimedSession({ ledger, engine, durationMs: 30 * 60_000, tickMs: 60_000,
    clock, sleep: async (ms) => { now += ms; }, shouldStop: () => stop, stopReason: () => 'SIGINT' });
  assert.equal(manifest.status, 'stopped'); assert.equal(manifest.stopReason, 'SIGINT');
  assert.equal(manifest.completedSlots, 1);
  assert.equal(manifest.unattemptedSlots, 29);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE kind='slot'").get().n, 30);
  assert.equal(now, T0 + 42_000);
  ledger.close();
});

test('T1: a failed tick stops the schedule instead of continuing with a broken journal', async () => {
  let now = T0; let calls = 0;
  const clock = () => now;
  const ledger = openLedger(makeCfg(), { clock });
  const engine = { async tick() { calls += 1; return { error: 'ledger write failed' }; }, finalizeValuation() {} };
  const manifest = await runTimedSession({ ledger, engine, durationMs: 30 * 60_000, tickMs: 60_000,
    clock, sleep: async (ms) => { now += ms; } });
  assert.equal(manifest.status, 'stopped'); assert.equal(manifest.stopReason, 'ledger write failed');
  assert.equal(calls, 1);
  assert.equal(manifest.unattemptedSlots, 29);
  ledger.close();
});
