// The day report (agent v2.6): AGENT_TEST=1 node --test agent/test-report.mjs
// A harness on fakes writes a file ledger; the report is built on the live handle and, through the
// CLI, on the closed file. Every figure asserted here is one the §5 format of the test days names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildReport, dayWindow, renderReport } from './report.mjs';
import { createArms } from './arms.mjs';
import { T0, makeFeed, makeHarness } from './test-helpers.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('dayWindow: a UTC day, or null for every row; malformed input is refused', () => {
  assert.deepEqual(dayWindow('2026-10-02'), { from: '2026-10-02T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' });
  assert.equal(dayWindow(null), null);
  assert.throws(() => dayWindow('02.10.2026'), /YYYY-MM-DD/u);
});

test('the shadow arms and final wallet use the same post-tick end price', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' } });
  try {
    await h.advance(1);
    h.ledger.insertArm({ arm: 'hold_eth', side: 'ETH', ethSide: 0.5, usdc: 100, equityUsd: 1600,
      costsUsd: 0.2, netUsd: 1599.8, switches: 0 });
    h.wait(60_000);
    h.ledger.observe('valuation', { price: 2900, priceAt: new Date(h.clock()).toISOString(),
      walletUsd: 966.66, externalUsd: 0, stale: false });
    const r = buildReport({ db: h.ledger.db });
    assert.equal(r.header.endPrice, 2900);
    assert.equal(r.result.finalWalletUsd, 966.66);
    assert.ok(near(r.result.arms.hold_eth.equityUsd, 1550));
    assert.ok(near(r.result.arms.hold_eth.netUsd, 1549.8));
    assert.equal(r.result.arms.hold_eth.valuedAt, r.result.finalValuationAt);
  } finally { h.ledger.close(); }
});

test('the report of a virtual-capital day: header, time, costs, funnel, the switch with its horizons, the three result lines, halts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-report-'));
  const path = join(dir, 'T1.db');
  let h;
  try {
    h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000', AGENT_DB_PATH: path, INFERENCE_BUDGET_USD_PER_DAY: '3' }, chainOptions: { executionPrice: 2997 }, confirmFn: (args, state) => (state.veto ? { ok: true, agrees: false, stance: 'HOLD', confidence: 0.9, costUsd: 0.0002 } : { ok: true, agrees: true, stance: args.candidate, confidence: 0.8, model: 'deepseek-flash', costUsd: 0.0002 }) });
    const arms = createArms({ cfg: h.cfg, ledger: h.ledger, clock: h.clock });
    const tick = h.engine.tick;
    h.state.veto = true;
    let outs = await h.advance(13); // veto at the sixth tick, then two deferred candidate-ticks in the cooldown
    assert.equal(outs[5].vetoed, 'slow brain'); assert.equal(outs[12].cooldown, true);
    h.state.veto = false;
    h.wait(h.cfg.deepseekCooldownMs);
    outs = await h.advance(6); // a fresh run: the slow brain agrees, the switch fills
    assert.equal(outs[5].switched, true, JSON.stringify(outs[5]));
    // the tape moves after the switch so the horizons have something to say: −0.5 % at +15 min, +1 % at +60 min
    const switchAt = h.clock() - h.tickMs;
    h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 2985, trendUp: false }).snapshot;
    h.setNow(switchAt + 16 * 60_000); await tick();
    h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3030, trendUp: false }).snapshot;
    h.setNow(switchAt + 61 * 60_000); await tick();
    arms.init({ ethSide: 0, usdc: 1000, price: 3030, quotes: { at: h.clock(), sellQuotePrice: 3030, buyQuotePrice: 3030 }, now: h.clock() });
    arms.tick({ price: 3030, features: null, quotes: null, now: h.clock() });
    const ledgerRows = h.ledger.db.prepare('SELECT COUNT(*) AS n FROM equity').get().n;

    const r = buildReport({ db: h.ledger.db, projectionUsd: 100 });
    // 1. header
    assert.equal(r.header.agentVersion, '2.14.0'); assert.equal(r.header.tickMs, 5000); assert.equal(r.header.paperCapitalUsd, 1000); assert.equal(r.header.notionalCapUsd, 2000); assert.equal(r.header.inferenceBudgetUsdPerDay, 3);
    assert.equal(r.header.configChangedMidRun, false); assert.equal(r.header.opening.source, 'PAPER_CAPITAL_USD'); assert.equal(r.header.opening.openingPrice, 3000);
    assert.ok(near(r.header.opening.ethSide, 1000 / 3000) && r.header.opening.usdc === 0, 'the opening balances survive the fill'); assert.equal(r.header.opening.nowEthSide, 0);
    assert.equal(r.header.voteRule, '5 of 6 within 45 s, gap ≤ 10 s'); assert.equal(r.header.requireDeepseek, true); assert.equal(r.header.configHash.length, 16);
    assert.ok(near(r.header.initial.walletUsd, 1000)); assert.equal(r.header.startPrice, 3000); assert.equal(r.header.endPrice, 3030); assert.equal(r.header.judgeModel, 'judge-model-1');
    // 2. time
    assert.equal(r.time.ticksSeen, ledgerRows); assert.equal(r.time.judgments, 21); assert.equal(r.time.judgeErrors, 0); assert.equal(r.time.degradedJudgments, 0); assert.equal(r.time.usableJudgments, 21);
    assert.equal(r.time.halt, null); assert.equal(r.time.eligibleTicks, 21); assert.equal(r.time.gapsOver5min.length, 3, JSON.stringify(r.time.gapsOver5min)); // the cooldown wait and the two horizon jumps
    assert.equal(r.time.feed.disconnectedJudgments, 0);
    // 3. calls and costs
    assert.equal(r.calls.judge.calls, 21); assert.ok(near(r.calls.judge.usd, 21 * 0.0000168)); assert.equal(r.calls.judge.latencyMs.max, 300);
    assert.equal(r.calls.deepseek.calls, 2); assert.ok(near(r.calls.deepseek.usd, 0.0004)); assert.equal(r.calls.deepseek.agreed, 1); assert.equal(r.calls.deepseek.vetoes, 1); assert.equal(r.calls.deepseek.usableAnswers, 2);
    assert.equal(r.calls.paperGas.legs, 1); assert.ok(near(r.calls.paperGas.usd, 0.003));
    assert.ok(near(r.calls.externalUsd, r.calls.judge.usd + 0.0004 + 0.003)); assert.equal(r.calls.budget.reached, false);
    assert.ok(near(r.calls.shareOfProjectionPct, r.calls.shareOfCapitalPct * 10), 'the same dollars are ten times the share of $100');
    // 4. funnel
    assert.equal(r.funnel.judgments, 21); assert.equal(r.funnel.leaningVotes.USDC, 21); assert.equal(r.funnel.deferredByCooldown, 2); assert.equal(r.funnel.executed, 1);
    assert.deepEqual(r.funnel.candidateTicksByStage, { 'slow-brain:vetoed': 1, 'cooldown:deferred': 2, 'execute:execute': 1 });
    assert.deepEqual(r.funnel.switchesByStatus, { done: 1 });
    // 5. the switch and its horizons: to USDC at 3000, then −0.5 % (paid, cost 0.07 %) and +1 % (not paid); 240 min not covered
    assert.equal(r.switches.length, 1);
    const s = r.switches[0];
    assert.equal(s.to, 'USDC'); assert.equal(s.status, 'done'); assert.ok(near(s.notionalUsd, 1000)); assert.ok(near(s.entryPrice, 2997 * (1 - h.cfg.expectedSlippageBps / 10_000))); assert.equal(s.decisionPrice, 3000); assert.ok(near(s.costPctAtDecision, 0.07));
    assert.equal(s.legs.length, 1); assert.equal(s.legs[0].accounting, 'booked');
    assert.equal(s.horizons['15m'].paid, true); assert.ok(near(s.horizons['15m'].movePct, -0.5, 1e-6));
    assert.equal(s.horizons['60m'].paid, false); assert.ok(near(s.horizons['60m'].movePct, 1, 1e-6));
    assert.equal(s.horizons['240m'], null);
    // 6. result: the wallet is in USDC at 2997 × (1 − 2 bps) after the fill, so the gross is that minus the capital minus the paper gas; net = gross − inference; the projection scales the gross only
    const usdc = h.ledger.kv.get('paper:balances').usdc;
    assert.ok(near(r.result.finalWalletUsd, usdc));
    const gross = usdc - 1000 - 0.003; const inference = r.calls.judge.usd + 0.0004;
    assert.ok(near(r.result.lines.grossBeforeInference.usd, gross)); assert.ok(near(r.result.lines.netAtCapital.usd, gross - inference));
    assert.ok(near(r.result.lines.projection.usd, gross / 10 - inference)); assert.equal(r.result.lines.projection.capitalUsd, 100);
    assert.ok(near(r.result.priceMovePct, 1, 1e-9));
    assert.ok(r.result.arms.hold_usdc && r.result.arms.hold_eth, 'the arms\' last rows are named');
    // 7. halts
    assert.equal(r.halts.current, null); assert.deepEqual(r.halts.switchHalts, []);
    // text rendering names the three lines
    const text = renderReport(r);
    assert.match(text, /gross before inference/u); assert.match(text, /net at the capital/u); assert.match(text, /projection at \$100/u);
    assert.match(text, /15-minute forecast labels: .*covered \(good \d+, degraded \d+, unknown \d+\); .* matched overall, .* on good data/u);
    assert.match(text, /virtual capital \$1000\.00, notional cap \$2000\.00, inference budget \$3\.00\/day/u);
    assert.ok(!/0x[0-9a-f]{64}|DEEPSEEK_API_KEY|PRIVATE_KEY/iu.test(text), 'no secret, no key name');

    // the CLI on the closed file, read-only, as JSON and as text; a day window that holds no rows is honest
    h.ledger.close();
    const cli = resolve(import.meta.dirname, 'report.mjs');
    const json = JSON.parse(execFileSync(process.execPath, [cli, '--db', path, '--json'], { encoding: 'utf8' }));
    assert.equal(json.time.judgments, 21); assert.equal(json.result.lines.projection.usd, null);
    const day = new Date(T0).toISOString().slice(0, 10);
    const dayJson = JSON.parse(execFileSync(process.execPath, [cli, '--db', path, '--day', day, '--json'], { encoding: 'utf8' }));
    assert.equal(dayJson.time.judgments, 21, 'every row of the run lies in the epoch\'s UTC day');
    const empty = JSON.parse(execFileSync(process.execPath, [cli, '--db', path, '--day', '2000-01-01', '--json'], { encoding: 'utf8' }));
    assert.equal(empty.time.judgments, 0); assert.equal(empty.result.lines.netAtCapital.usd, null);
    assert.match(execFileSync(process.execPath, [cli, '--db', path], { encoding: 'utf8' }), /TEST-DAY REPORT — paper — every row/u);
  } finally { try { h?.ledger.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test('the report of a run that halted on the daily loss names the halt, the halted time and the eligible time before it', async () => {
  const h = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' } });
  await h.advance(3);
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 2900, trendUp: false }).snapshot; // −3.33 %: the daily limit latches at the next tick's entry
  const outs = await h.advance(3);
  assert.ok(h.ledger.stats(0).halt, JSON.stringify(outs));
  const r = buildReport({ db: h.ledger.db });
  assert.match(r.time.halt.reason, /^risk \(tick\): daily net loss/u);
  assert.equal(r.time.eligibleTicks, 3, 'the judgments before the latch');
  assert.equal(r.time.judgments, 6, 'judging went on while halted, within the budget (R5-P1)');
  assert.ok(r.time.halt.haltedMinutes >= 0);
  assert.match(renderReport(r), /halt: risk \(tick\): daily net loss/u);
});
