// Engine regressions (TR-01/02/03/04/05/07/08/10/11): AGENT_TEST=1 node --test agent/test-engine.mjs
// Every case that the first review reproduced as a defect is asserted here as the safe
// behaviour; the R1 witnesses live in test-r1.mjs. Fakes only: no network, no keys, no timers.
// Every harness shares one clock between the engine, the ledger and the fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, resolveArming } from './engine.mjs';
import { openLedger } from './ledger.mjs';
import { T0, agreeingSummary, fakeChain, fakeJudge, flatSummary, makeCfg, makeFeed, makeHarness } from './test-helpers.mjs';

const liveEnv = { MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real' };
const harness = (options = {}) => makeHarness(options);

test('TR-01: only MODE=live together with --live arms; every other combination refuses to start', () => {
  assert.equal(resolveArming({ mode: 'live', liveFlag: true }).armed, true);
  assert.match(resolveArming({ mode: 'live', liveFlag: false }).refuse, /refusing/u);
  assert.match(resolveArming({ mode: 'paper', liveFlag: true }).refuse, /refusing/u);
  assert.equal(resolveArming({ mode: 'paper', liveFlag: false }).armed, false);
  assert.throws(() => createEngine({ cfg: makeCfg(liveEnv), armed: false, chain: {}, ledger: {}, feed: {}, judge: {}, slowBrain: {} }), /disagrees/u, 'engine refuses a mode that disagrees with the config');
});

test('paper: six agreeing judgments produce a switch filled at the EXECUTION-time quote, atomically, with costs booked', async () => {
  const h = harness({ chainOptions: { executionPrice: 2700 } }); // tape says 3000, the quoter at execution says 2700
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, true, JSON.stringify(outs[5]));
  const paper = h.ledger.kv.get('paper:balances');
  assert.equal(paper.ethSide, 0);
  assert.ok(Math.abs(paper.usdc - 0.004 * 2700 * (1 - 0.0002)) < 1e-6, `usdc ${paper.usdc}`);
  const sw = h.ledger.db.prepare('SELECT * FROM switches').all();
  assert.equal(sw.length, 1); assert.equal(sw[0].status, 'done');
  const legs = h.ledger.legsOf(sw[0].id);
  assert.equal(legs.length, 1); assert.equal(legs[0].status, 'confirmed'); assert.ok(legs[0].quote_at);
  const costs = h.ledger.totals().costs;
  assert.ok(costs.gas > 0 && costs.judge > 0 && costs.deepseek > 0, JSON.stringify(costs));
  assert.equal(h.ledger.stats(1).switchesToday, 1);
});

test('TR-07: a paper trade that fails mid-write leaves no trade and unchanged balances', async () => {
  const h = harness();
  const realSet = h.ledger.kv.set.bind(h.ledger.kv);
  h.ledger.kv.set = (k, v) => { if (k === 'paper:balances' && v.usdc > 0) throw new Error('synthetic crash'); return realSet(k, v); };
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, false);
  const paper = h.ledger.kv.get('paper:balances');
  assert.equal(paper.ethSide, 0.004); assert.equal(paper.usdc, 0);
  assert.equal(h.ledger.db.prepare("SELECT COUNT(*) AS n FROM legs WHERE status = 'confirmed'").get().n, 0);
  assert.equal(h.ledger.db.prepare('SELECT status FROM switches').get().status, 'failed_before_send', 'nothing was paid or broadcast: the intent never sent');
  assert.ok(h.ledger.stats(1).halt, 'a throwing switch latches the halt');
});

test('TR-02: a 40-second slow-brain wait invalidates the candidate: preflight aborts, nothing is executed', async () => {
  const h = harness({ confirmFn: (args, state) => { state.sleep(40_000); return { ok: true, agrees: true, stance: 'USDC', confidence: 0.8, costUsd: 0.0002 }; } });
  h.state.sleep = h.wait;
  const outs = await h.advance(6);
  assert.ok(outs[5].aborted, JSON.stringify(outs[5]));
  assert.equal(h.ledger.db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 0);
  assert.equal(h.chain.calls.quotes.length, 0, 'no execution quote was taken');
});

test('TR-02: a KILL file that appears during the slow-brain wait stops the switch', async () => {
  const h = harness({ confirmFn: (args, state) => { state.killed = true; return { ok: true, agrees: true, stance: 'USDC', confidence: 0.8, costUsd: 0.0002 }; } });
  const outs = await h.advance(6);
  assert.ok(outs[5].aborted && outs[5].aborted.some((p) => /KILL/u.test(p)), JSON.stringify(outs[5]));
  assert.equal(h.ledger.db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 0);
});

test('TR-02: a slow-brain HTTP outage with unknown billing halts the run and preserves the attempt', async () => {
  const h = harness({ confirmFn: () => ({ ok: false, reason: 'HTTP 503' }) });
  const outs = await h.advance(7);
  assert.equal(outs[5].stop, true);
  assert.equal(outs[6].stop, true);
  assert.equal(h.ledger.db.prepare("SELECT billing FROM inference_calls WHERE provider='deepseek'").get().billing, 'UNKNOWN');
  assert.equal(h.state.confirmCalls, 1);
});

test('no candidate ever forms from flat judgments, and nothing is executed without the slow brain', async () => {
  const h = harness({ summary: flatSummary });
  const outs = await h.advance(8);
  assert.ok(outs.every((o) => o.candidate === null), JSON.stringify(outs));
  assert.equal(h.state.confirmCalls, 0);
});

test('TR-08: inference charges reduce net P&L; partial switches count; the daily budget pauses judging', async () => {
  const clock = () => T0;
  const ledger = openLedger(makeCfg(), { clock });
  ledger.ensureInitial(100);
  ledger.insertEquity({ eth: 0, weth: 0, usdc: 100, price: 3000, equityUsd: 100, walletUsd: 100 });
  ledger.insertJudgment({ price: 3000, features: {}, state: 'synthetic', costUsd: 4 });
  const st = ledger.stats(100);
  assert.ok(Math.abs(st.dailyNetPnlPct + 4) < 1e-9, `daily net ${st.dailyNetPnlPct}`);
  assert.ok(Math.abs(st.totalNetPnlPct + 4) < 1e-9, `total net ${st.totalNetPnlPct}`);
  assert.equal(st.inferenceTodayUsd, 4);
  const id = ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'test', notionalUsd: 11 });
  ledger.updateSwitch(id, { status: 'partial' });
  assert.equal(ledger.stats(100).switchesToday, 1, 'a partial switch is a switch');
  ledger.close();
  // the budget: with the day's budget already spent the engine must not call the judge
  const h = harness();
  h.ledger.ensureInitial(12);
  h.ledger.insertJudgment({ price: 3000, features: {}, state: 'synthetic', costUsd: h.cfg.inferenceBudgetUsdPerDay });
  const before = h.ledger.totals().judgments;
  await h.advance(2);
  assert.equal(h.ledger.totals().judgments, before, 'judge paused once the daily inference budget is spent');
});

test('TR-03/TR-10: an unresolved leg from a previous run latches a halt and blocks new switches until reset', async () => {
  const h = harness({ chainOptions: { receipt: 'missing' } });
  const id = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'old run', notionalUsd: 11 });
  const legId = h.ledger.openLeg({ switchId: id, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  h.ledger.updateLeg(legId, { status: 'sent', tx_hash: '0xdead', nonce: 7 });
  const rec = await h.engine.recoverPending();
  assert.equal(rec.unresolvedLegs, 1);
  assert.ok(h.ledger.stats(1).halt, 'halt latched');
  const outs = await h.advance(6);
  assert.ok(outs[5].blocked && outs[5].blocked.some((p) => /halted|pending/u.test(p)), JSON.stringify(outs[5]));
  h.ledger.resetHalt();
  assert.equal(h.ledger.stats(1).halt, null, 'only an explicit reset clears the halt');
  assert.equal(h.ledger.stats(1).pendingSwitches > 0, true, 'the unresolved leg itself still blocks');
});

test('live: the bound of the whole plan is checked before the first transaction; an oversized bound sends nothing', async () => {
  const h = harness({ live: true, chainOptions: { estimateWei: 10n ** 16n } }); // 0.01 ETH ≈ $30 of gas against $12 notional
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, false);
  assert.match(outs[5].result.reason, /bound/u);
  assert.equal(h.chain.calls.sends.length, 0);
  assert.equal(h.ledger.db.prepare('SELECT status FROM switches').get().status, 'failed_before_send');
  assert.equal(h.ledger.db.prepare('SELECT status FROM legs').get().status, 'cancelled', 'the planned leg is closed, never left open');
});

test('live: a switch out of native ETH sends one deadline-bearing swap with the estimated gas limit and fee caps, books actual output and gas, and needs no approval', async () => {
  const h = harness({ live: true });
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, true, JSON.stringify(outs[5]));
  assert.equal(h.chain.calls.sends.length, 1);
  assert.equal(h.chain.calls.approveTxs.length, 0, 'native ETH needs no approval');
  const sent = h.chain.calls.sends[0];
  const sentAt = Math.floor(sent.at / 1000);
  assert.ok(sent.tx.deadline >= sentAt + h.cfg.swapDeadlineSec - 1 && sent.tx.deadline <= sentAt + h.cfg.swapDeadlineSec + 1, `deadline ${sent.tx.deadline} vs ${sentAt}`);
  assert.equal(sent.nonce, 7, 'explicit nonce from the chain');
  assert.equal(sent.gasLimit, 192_000n, 'the bounded gas limit of the estimate is what is serialized');
  assert.equal(sent.maxFeePerGas, 6_000_000n); assert.equal(sent.maxPriorityFeePerGas, 1_000_000n);
  const leg = h.ledger.db.prepare('SELECT * FROM legs').get();
  assert.equal(leg.status, 'confirmed'); assert.ok(leg.amount_out_actual > 0); assert.ok(leg.gas_l2_usd > 0); assert.ok(leg.gas_l1_usd > 0);
  assert.equal(leg.nonce, 7);
  const sw = h.ledger.db.prepare('SELECT * FROM switches').get();
  assert.equal(sw.status, 'done'); assert.ok(sw.spent_usd > 0 && sw.spent_usd <= sw.budget_usd, `spent ${sw.spent_usd} within budget ${sw.budget_usd}`);
  assert.ok(h.ledger.totals().costs.gas > 0);
});

test('live: buying back ETH with USDC approves exactly the amount, not unlimited, and the plan is two bounded steps', async () => {
  const h = harness({ live: true, chainOptions: { balances: { eth: 0.002, weth: 0, usdc: 12 }, allowance: 0n }, summary: () => agreeingSummary('ETH'), trendUp: true });
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, true, JSON.stringify(outs[5]));
  assert.equal(h.chain.calls.approveTxs.length, 1);
  assert.equal(h.chain.calls.approveTxs[0].amountRaw, 12_000_000n, 'exact allowance for 12 USDC');
  assert.equal(h.chain.calls.sends.length, 2, 'approval then swap');
  const legs = h.ledger.legsOf(1);
  assert.deepEqual(legs.map((l) => [l.kind, l.status]), [['approve', 'confirmed'], ['swap', 'confirmed']]);
  assert.match(h.ledger.getSwitch(1).reason ?? '', /bounded after their approval/u);
});

test('TR-03: a receipt timeout marks the leg unknown, the switch unknown, latches the halt and blocks the next candidate', async () => {
  const h = harness({ live: true, chainOptions: { receipt: 'timeout' } });
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, false);
  assert.match(outs[5].result.reason, /timeout; halted/u);
  const leg = h.ledger.db.prepare('SELECT status FROM legs').get();
  assert.equal(leg.status, 'unknown');
  assert.equal(h.ledger.db.prepare('SELECT status FROM switches').get().status, 'unknown');
  assert.ok(h.ledger.stats(1).halt);
  const more = await h.advance(6);
  assert.ok(more[5].blocked || more[5].candidate === null, JSON.stringify(more[5]));
  assert.equal(h.chain.calls.sends.length, 1, 'no second send');
});

test('live: our own transaction still in the mempool refuses a new switch', async () => {
  const h = harness({ live: true, chainOptions: { inFlight: 1 } });
  const outs = await h.advance(6);
  assert.equal(outs[5].switched, false);
  assert.match(outs[5].result.reason, /pending in the mempool/u);
  assert.equal(h.chain.calls.sends.length, 0);
});

test('TR-06: a stalled tape goes stale after 30 s of no market events: no features, votes cleared, no judgment paid for', async () => {
  const cfg = makeCfg();
  let now = T0; const clock = () => now;
  const chain = fakeChain({ clock });
  const ledger = openLedger(cfg, { clock });
  const engine = createEngine({ cfg, armed: false, chain, ledger, feed: makeFeed({ eventAt: T0, frozenAt: T0, trendUp: false }), judge: fakeJudge(() => agreeingSummary('USDC')), slowBrain: { async confirm() { return { ok: true, agrees: true, stance: 'USDC', confidence: 0.8, costUsd: 0.0002 }; } }, clock, fsx: { existsSync: () => false } });
  const outs = [];
  for (let i = 0; i < 8; i += 1) { outs.push(await engine.tick()); now += cfg.tickMs; }
  assert.ok(outs.slice(0, 6).every((o) => o.candidate === null || o.switched !== undefined || o.aborted), JSON.stringify(outs.slice(0, 6)));
  assert.deepEqual(outs[7], { stale: true }, 'at +35 s the tape is stale');
  const judgments = ledger.totals().judgments;
  assert.ok(judgments <= 7, `no judgment is paid for on a stale tape (got ${judgments})`);
  assert.equal(engine.votes.items.length, 0, 'votes cleared on stale data');
});

test('TR-11: every judgment row carries the model, the config and source hashes and the feature schema', async () => {
  const h = harness({ summary: flatSummary });
  await h.advance(1);
  const row = h.ledger.db.prepare('SELECT model, config_hash, source_hash, feature_schema, tape_source, candle_source FROM judgments').get();
  assert.equal(row.model, 'judge-model-1');
  assert.match(row.source_hash, /^[0-9a-f]{16}$/u);
  assert.ok(row.config_hash && row.feature_schema === 'features-v2.1' && row.tape_source === 'coinbase:ETH-USD' && row.candle_source === 'coinbase:ETH-USD', JSON.stringify(row));
});
