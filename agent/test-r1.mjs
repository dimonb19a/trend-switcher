// Safe regressions for the fourteen witnesses of the first review round (R1): the same schedules,
// asserted as the behaviour the contract promises. Every harness runs the
// engine, the ledger and the fakes on ONE injected clock; where a witness
// depended on the calendar, the case runs at two epochs and must agree.
// AGENT_TEST=1 node --test agent/test-r1.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './engine.mjs';
import { openLedger } from './ledger.mjs';
import { Feed } from './feed.mjs';
import { createArms } from './arms.mjs';
import { confirm } from './deepseek.mjs';
import { computeFeatures } from './features.mjs';
import { describeConfig, loadConfig } from './config.mjs';
import { REVIEW_EPOCH, T0, USDC, agreeingSummary, fakeChain, fakeJudge, makeCfg, makeFeed, makeHarness, makeSnapshot } from './test-helpers.mjs';

const EPOCHS = { fixed: T0, review: REVIEW_EPOCH };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const rows = (h, sql, ...args) => h.ledger.db.prepare(sql).get(...args);

test('R1-A: the engine refuses a ledger that runs on a different clock', () => {
  const cfg = makeCfg(); const clock = () => T0;
  assert.throws(() => createEngine({ cfg, armed: false, chain: fakeChain({ clock }), ledger: openLedger(cfg, { clock: () => T0 + 1 }), feed: makeFeed({ eventAt: T0 }), judge: fakeJudge(() => agreeingSummary('USDC')), slowBrain: {}, clock }), /one clock/u);
});

test('R1-01: the first live switch goes through on one shared clock at either epoch; the hold binds the NEXT candidate, not the intent itself', async () => {
  for (const [name, epoch] of Object.entries(EPOCHS)) {
    const h = makeHarness({ live: true, epoch });
    const out = await h.last(6);
    assert.equal(out.switched, true, `${name}: ${JSON.stringify(out)}`);
    assert.equal(h.chain.calls.sends.length, 1, name);
    assert.equal(h.ledger.stats(1).switchesToday, 1, name);
    // now in USDC; the judge turns to ETH and the candles trend up: the next candidate waits out the hold
    h.state.summary = () => agreeingSummary('ETH');
    h.feed.snapshot = makeFeed({ eventAt: epoch, trendUp: true }).snapshot;
    const held = await h.last(6);
    assert.ok(held.blocked?.some((p) => /minimum hold/u.test(p)), `${name}: ${JSON.stringify(held)}`);
    assert.equal(h.chain.calls.sends.length, 1, name);
    h.wait(h.cfg.minHoldMinutes * 60_000);
    const next = await h.last(6);
    assert.equal(next.switched, true, `${name}: ${JSON.stringify(next)}`);
    assert.equal(h.chain.calls.sends.length, 3, `${name}: approval + swap after the hold`);
  }
});

test('R1-A: the last daily slot is granted, the next refused, a partial counts, and the UTC day boundary resets the count on the same clock', async () => {
  const h = makeHarness();
  for (let i = 0; i < h.cfg.maxSwitchesPerDay - 1; i += 1) {
    const id = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'earlier today', notionalUsd: 11 });
    h.ledger.updateSwitch(id, { status: i === 0 ? 'partial' : 'done' });
  }
  assert.equal(h.ledger.stats(1).switchesToday, h.cfg.maxSwitchesPerDay - 1, 'a partial intent occupies a slot');
  h.wait((h.cfg.minHoldMinutes + 1) * 60_000);
  const sixth = await h.last(6);
  assert.equal(sixth.switched, true, `the last slot: ${JSON.stringify(sixth)}`);
  assert.equal(h.ledger.stats(1).switchesToday, h.cfg.maxSwitchesPerDay);
  h.state.summary = () => agreeingSummary('ETH');
  h.feed.snapshot = makeFeed({ eventAt: T0, trendUp: true }).snapshot;
  h.wait((h.cfg.minHoldMinutes + 1) * 60_000);
  const seventh = await h.last(6);
  assert.ok(seventh.blocked?.some((p) => /daily maximum/u.test(p)), `one past the quota: ${JSON.stringify(seventh)}`);
  const nextDay = new Date(h.clock()); nextDay.setUTCDate(nextDay.getUTCDate() + 1); nextDay.setUTCHours(0, 21, 0, 0);
  h.setNow(nextDay.getTime());
  assert.equal(h.ledger.stats(1).switchesToday, 0, 'a new UTC day on the same clock');
  const fresh = await h.last(6);
  assert.equal(fresh.switched, true, `first of the new day: ${JSON.stringify(fresh)}`);
});

test('R1-02: KILL appearing during the paper execution quote stops the fill; balances untouched; no halt (the brake is not a fault)', async () => {
  const h = makeHarness();
  const quote = h.chain.quote;
  h.chain.quote = async (...args) => { h.state.killed = true; return quote(...args); };
  const out = await h.last(6);
  assert.equal(out.switched, false, JSON.stringify(out));
  assert.match(out.result.reason, /KILL/u);
  const paper = h.ledger.kv.get('paper:balances');
  assert.equal(paper.ethSide, 0.004); assert.equal(paper.usdc, 0);
  assert.equal(rows(h, "SELECT COUNT(*) AS n FROM legs WHERE status = 'confirmed'").n, 0);
  assert.equal(rows(h, 'SELECT status FROM switches').status, 'failed_before_send');
  assert.equal(h.ledger.stats(1).halt, null);
});

test('R1-03: a 40-second execution quote outlives the votes: no paper fill', async () => {
  const h = makeHarness();
  const quote = h.chain.quote;
  h.chain.quote = async (...args) => { h.wait(40_000); return quote(...args); };
  const out = await h.last(6);
  assert.equal(out.switched, false, JSON.stringify(out));
  assert.match(out.result.reason, /candidate no longer|quote .* old/u);
  assert.equal(h.ledger.kv.get('paper:balances').usdc, 0);
});

test('R1-04: the preflight verdict is dated after its own waits: a 40-second balance read that meets KILL fails, and `now` is the verdict time', async () => {
  const h = makeHarness();
  await h.advance(5);
  h.engine.votes.push(agreeingSummary('USDC'), h.clock());
  const balances = h.chain.balances;
  h.chain.balances = async (...args) => { h.wait(40_000); h.state.killed = true; return balances(...args); };
  const pf = await h.engine.preflight({ stage: 'independent-test', target: 'USDC' });
  assert.equal(pf.ok, false);
  assert.ok(pf.problems.some((p) => /KILL/u.test(p)), JSON.stringify(pf.problems));
  assert.equal(pf.now, h.clock(), 'the verdict carries the time it was taken, after the wait');
});

test('R1-B: after an approval that takes long, the swap is re-quoted and re-judged; a wait that outlives the votes cancels the swap as partial', async () => {
  const options = { live: true, chainOptions: { balances: { eth: 0.002, weth: 0, usdc: 12 } }, summary: () => agreeingSummary('ETH'), trendUp: true };
  const g = makeHarness(options);
  const wait = g.chain.waitReceipt;
  g.chain.waitReceipt = async (...args) => { g.wait(50_000); return wait(...args); };
  const o = await g.last(6);
  assert.equal(o.switched, false, JSON.stringify(o));
  assert.equal(o.result.partial, true);
  assert.match(o.result.reason, /candidate no longer|votes|too old/u);
  assert.equal(g.chain.calls.sends.length, 1, 'the approval only');
  assert.deepEqual(g.ledger.legsOf(1).map((l) => l.status), ['confirmed', 'cancelled']);
  assert.equal(g.ledger.getSwitch(1).status, 'partial');
  const k = makeHarness(options);
  const wait2 = k.chain.waitReceipt;
  k.chain.waitReceipt = async (...args) => { k.wait(3_000); return wait2(...args); };
  const o2 = await k.last(6);
  assert.equal(o2.switched, true, JSON.stringify(o2));
  const approvalSentAt = k.chain.calls.sends[0].at;
  const swapQuote = k.chain.calls.quotes[k.chain.calls.quotes.length - 1];
  assert.ok(swapQuote.at >= approvalSentAt + 3_000, 'the swap quote is taken after the approval confirmed');
  assert.ok(k.chain.calls.sends[1].at >= swapQuote.at, 'and the swap is sent after that quote');
});

test('R1-05: on restart, a leg at the broadcast boundary without a hash is unknown and halts; a leg never broadcast is cancelled and does not halt', async () => {
  const h = makeHarness({ live: true });
  const a = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'crashed at the boundary', notionalUsd: 12 });
  const aLeg = h.ledger.openLeg({ switchId: a, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  h.ledger.updateLeg(aLeg, { status: 'broadcasting', nonce: 7 });
  const rec = await h.engine.recoverPending();
  assert.equal(h.ledger.legsOf(a)[0].status, 'unknown');
  assert.equal(h.ledger.getSwitch(a).status, 'unknown');
  assert.match(rec.halt.reason, /unknown/u);
  assert.equal(rec.unresolvedLegs, 1);
  const g = makeHarness({ live: true });
  const b = g.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'never sent', notionalUsd: 12 });
  g.ledger.openLeg({ switchId: b, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  const rec2 = await g.engine.recoverPending();
  assert.equal(g.ledger.legsOf(b)[0].status, 'cancelled');
  assert.equal(g.ledger.getSwitch(b).status, 'failed_before_send');
  assert.equal(rec2.halt, null); assert.equal(rec2.unresolvedLegs, 0);
});

test('R1-06: on restart a reverted receipt books its gas and halts; a confirmed one books gas and the output from the logs; a paid approval without its swap is partial and halts', async () => {
  const h = makeHarness({ live: true, chainOptions: { receipt: 'revert' } });
  const id = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'old', notionalUsd: 12 });
  const leg = h.ledger.openLeg({ switchId: id, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  h.ledger.updateLeg(leg, { status: 'sent', tx_hash: '0xreverted', nonce: 7 });
  const rec = await h.engine.recoverPending();
  assert.equal(h.ledger.legsOf(id)[0].status, 'failed');
  assert.ok(h.ledger.totals().costs.gas > 0, 'the gas of the reverted transaction is booked');
  assert.match(rec.halt.reason, /failed/u);
  assert.equal(h.ledger.getSwitch(id).status, 'failed');

  const g = makeHarness({ live: true });
  g.chain.fills.set('0xconfirmed', { tokenOut: USDC, amountOutRaw: 10_800_000n });
  const id2 = g.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'old', notionalUsd: 12 });
  const leg2 = g.ledger.openLeg({ switchId: id2, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  g.ledger.updateLeg(leg2, { status: 'sent', tx_hash: '0xconfirmed', nonce: 7 });
  const rec2 = await g.engine.recoverPending();
  const l2 = g.ledger.legsOf(id2)[0];
  assert.equal(l2.status, 'confirmed'); assert.equal(l2.amount_out_actual, 10.8); assert.ok(l2.gas_l2_usd > 0);
  assert.equal(g.ledger.getSwitch(id2).status, 'done'); assert.equal(rec2.halt, null);
  assert.ok(g.ledger.totals().costs.gas > 0);

  const k = makeHarness({ live: true });
  const id3 = k.ledger.openSwitch({ fromSide: 'USDC', toSide: 'ETH', reason: 'old', notionalUsd: 12 });
  const ap = k.ledger.openLeg({ switchId: id3, seq: 1, kind: 'approve', tokenIn: 'USDC', tokenOut: null, amountIn: 12 });
  k.ledger.updateLeg(ap, { status: 'approval_sent', tx_hash: '0xapproved', nonce: 7 });
  k.ledger.openLeg({ switchId: id3, seq: 2, kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: 12 });
  const rec3 = await k.engine.recoverPending();
  assert.deepEqual(k.ledger.legsOf(id3).map((l) => l.status), ['confirmed', 'cancelled']);
  assert.equal(k.ledger.getSwitch(id3).status, 'partial', 'a paid approval without its swap is not done');
  assert.match(rec3.halt.reason, /partial/u);
});

test('R1-07: the estimate right before the broadcast is the bounded one; a re-estimate above the cap sends nothing, and after a paid approval the swap is bounded by what remains', async () => {
  const h = makeHarness({ live: true });
  const est = h.chain.estimateTx; let n = 0;
  h.chain.estimateTx = async (...args) => { const e = await est(...args); n += 1; return n > 1 ? { ...e, boundWei: 10n ** 15n, boundUsd: 3 } : e; };
  const out = await h.last(6);
  assert.equal(out.switched, false, JSON.stringify(out));
  assert.match(out.result.reason, /gas bound/u);
  assert.equal(h.chain.calls.sends.length, 0);
  assert.equal(h.ledger.getSwitch(1).status, 'failed_before_send');
  assert.equal(h.ledger.legsOf(1)[0].status, 'cancelled');
  assert.equal(h.ledger.stats(1).halt, null);

  const g = makeHarness({ live: true, chainOptions: { balances: { eth: 0.002, weth: 0, usdc: 12 } }, summary: () => agreeingSummary('ETH'), trendUp: true });
  const est2 = g.chain.estimateTx;
  g.chain.estimateTx = async (tx, ...rest) => { const e = await est2(tx, ...rest); return tx.data === '0xswap' ? { ...e, boundWei: 10n ** 15n, boundUsd: 3 } : e; };
  const o = await g.last(6);
  assert.equal(o.switched, false, JSON.stringify(o));
  assert.equal(o.result.partial, true);
  assert.match(o.result.reason, /gas bound/u);
  assert.equal(g.chain.calls.sends.length, 1, 'the approval only');
  const legs = g.ledger.legsOf(1);
  assert.deepEqual(legs.map((l) => [l.kind, l.status]), [['approve', 'confirmed'], ['swap', 'cancelled']]);
  assert.equal(g.ledger.getSwitch(1).status, 'partial');
  assert.equal(g.ledger.stats(1).halt, null, 'a refusal after a successful setup step is not a fault');
  assert.ok(g.ledger.totals().costs.gas > 0, 'the approval gas is booked');
  assert.equal(g.ledger.stats(1).switchesToday, 1, 'a partial intent counts');
});

test('R1-08: a daily loss beyond the limit latches a halt that a price rebound does not lift; only the owner\'s reset does', async () => {
  const h = makeHarness();
  h.ledger.ensureInitial(13);
  h.ledger.insertEquity({ eth: 0.004, weth: 0, usdc: 0, price: 3250, equityUsd: 13, walletUsd: 13 });
  const down = await h.last(6); // paper wallet 0.004 × 3000 = $12: 7.7% below the day's first point
  assert.ok(down.blocked?.some((p) => /halted/u.test(p)), JSON.stringify(down));
  assert.match(h.ledger.stats(12).halt.reason, /daily net loss/u);
  h.feed.snapshot = makeFeed({ eventAt: T0, price: 3250, trendUp: false }).snapshot;
  const rebound = await h.last(1);
  assert.ok(rebound.blocked?.some((p) => /halted/u.test(p)), `still halted after the rebound: ${JSON.stringify(rebound)}`);
  assert.equal(rows(h, 'SELECT COUNT(*) AS n FROM switches').n, 0);
  h.ledger.resetHalt();
  const after = await h.last(1);
  assert.equal(after.switched, true, JSON.stringify(after));
});

test('R1-09: gas paid from the live wallet is counted once, through the wallet; the paper wallet pays nothing, so its gas estimate is external; inference is external in both', async () => {
  const h = makeHarness({ live: true });
  const before = await h.engine.readPosition(3000);
  assert.ok(near(before.walletUsd, 15) && near(before.equityUsd, 12), `${before.walletUsd} / ${before.equityUsd}`);
  h.ledger.ensureInitial(before.walletUsd);
  h.chain.bal.eth -= 0.0001; // $0.30 of gas left the wallet; native is still above the reserve
  h.ledger.recordCost('gas', 0.3, 'synthetic confirmed receipt', { estimate: false, external: false });
  const after = await h.engine.readPosition(3000);
  assert.ok(near(after.walletUsd, 14.7), `${after.walletUsd}`);
  assert.ok(near(h.ledger.stats(after.walletUsd).totalNetPnlPct, -2), `net ${h.ledger.stats(after.walletUsd).totalNetPnlPct}: the $0.30 exactly once`);
  h.ledger.recordCost('judge', 0.15, 'judgments', { estimate: false, external: true });
  assert.ok(near(h.ledger.stats(after.walletUsd).totalNetPnlPct, -3), 'inference is subtracted');
  const p = makeHarness();
  const pos = await p.engine.readPosition(3000);
  p.ledger.ensureInitial(pos.walletUsd);
  assert.ok(near(pos.walletUsd, 12));
  p.ledger.recordCost('gas', 0.12, 'paper leg', { estimate: true, external: true });
  assert.ok(near(p.ledger.stats(pos.walletUsd).totalNetPnlPct, -1), 'paper gas is external');
});

test('R1-10: a billed reply that is malformed or truncated still carries its cost, and the engine books it', async () => {
  const cfg = makeCfg({ DEEPSEEK_API_KEY: 'synthetic-not-a-real-key' });
  for (const [finish, content] of [['stop', 'not json'], ['length', '{"stance":"USDC","confidence":0.9']]) {
    const out = await confirm({ stateText: 's', judgeSummary: agreeingSummary('USDC'), candidate: 'USDC', position: { side: 'ETH' } }, {
      cfg, env: { DEEPSEEK_API_KEY: 'synthetic-not-a-real-key' },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', usage: { prompt_tokens: 500, completion_tokens: 40 }, choices: [{ finish_reason: finish, message: { content } }] }) }),
    });
    assert.equal(out.ok, false, finish);
    assert.ok(Number.isFinite(out.costUsd) && out.costUsd > 0, `${finish}: cost ${out.costUsd}`);
    assert.equal(out.model, 'deepseek-flash');
  }
  const h = makeHarness({ confirmFn: () => ({ ok: false, reason: 'answer outside the contract', costUsd: 0.0003, model: 'deepseek-flash' }) });
  const out = await h.last(6);
  assert.equal(out.held, 'answer outside the contract');
  assert.ok(near(h.ledger.totals().costs.deepseek, 0.0003, 1e-12), JSON.stringify(h.ledger.totals().costs));
});

test('R1-11: a late older event never becomes the current price; the age follows the newest event; the history stays sorted; sequence and time are checked independently', () => {
  const now = T0;
  const f = new Feed({ clock: () => now });
  const tick = (p, at, sequence) => ({ type: 'ticker', product_id: 'ETH-USD', price: String(p), time: new Date(at).toISOString(), sequence });
  assert.equal(f.onMessage(tick(3000, now, 1)), true);
  assert.equal(f.onMessage(tick(2800, now - 40_000, 2)), true, 'kept in the history');
  const s = f.snapshot(now);
  assert.equal(s.last.p, 3000); assert.equal(s.eventAgeMs, 0); assert.equal(s.reordered, 1);
  assert.deepEqual(s.ticks.map((t) => t.p), [2800, 3000]);
  assert.equal(f.onMessage(tick(2900, now - 20_000, 3)), true);
  assert.deepEqual(f.snapshot(now).ticks.map((t) => t.t), [now - 40_000, now - 20_000, now], 'sorted by event time');
  assert.equal(f.onMessage(tick(3100, now + 1000, 3)), false, 'a sequence regression is rejected on its own');
  assert.equal(f.onMessage(tick(2700, now - 70_000, 4)), false, 'older than a gap is stale');
  assert.equal(f.snapshot(now).last.p, 3000);
});

test('R1-12: hold-ETH and hold-USDC are different benchmarks from the same capital; code_judge decides from its own side under the same rules; costs are attributed', () => {
  const h = makeHarness();
  const arms = createArms({ cfg: h.cfg, ledger: h.ledger, clock: h.clock });
  const quotes = { at: h.clock(), sellQuotePrice: 3000, buyQuotePrice: 3000, impactBps: 0, expectedSlippagePct: 0.02, tolerancePct: 0.5, costPct: 0.07 };
  assert.equal(arms.init({ ethSide: 0.004, usdc: 0, price: 3000, quotes: null, now: h.clock() }), null, 'no benchmark without a fresh two-sided quote');
  const st = arms.init({ ethSide: 0.004, usdc: 0, price: 3000, quotes, now: h.clock() });
  assert.equal(st.hold_eth.ethSide, 0.004); assert.equal(st.hold_eth.usdc, 0);
  assert.equal(st.hold_usdc.ethSide, 0); assert.ok(near(st.hold_usdc.usdc, 12 * (1 - 0.0002)), `${st.hold_usdc.usdc}`);
  assert.notDeepEqual(st.hold_eth, st.hold_usdc);
  const down = computeFeatures(makeSnapshot({ now: h.clock(), trendUp: false }), quotes, h.clock());
  const asked = [];
  const notes = arms.tick({ price: 3000, features: down, quotes, candidateFor: (side) => { asked.push(side); return side === 'ETH' ? 'USDC' : null; }, now: h.clock(), judgeCostUsd: 0.00002 });
  assert.deepEqual(asked, ['ETH']); assert.equal(notes.code_judge, 'switched to USDC'); assert.equal(arms.state().code_judge.ethSide, 0);
  assert.ok(arms.state().code_judge.costsUsd > h.cfg.paperGasUsdPerLeg, 'gas and the judge are attributed to the arm');
  arms.tick({ price: 3000, features: down, quotes: { ...quotes, at: h.clock() }, candidateFor: (side) => { asked.push(side); return null; }, now: h.clock() });
  assert.equal(asked[asked.length - 1], 'USDC', 'the arm is asked for its OWN side');
  assert.equal(arms.state().hold_eth.ethSide, 0.004, 'hold-ETH stays in ETH');
  const up = computeFeatures(makeSnapshot({ now: h.clock(), trendUp: true }), quotes, h.clock());
  const again = arms.tick({ price: 3000, features: up, quotes, candidateFor: () => 'ETH', now: h.clock() });
  assert.match(again.code_judge, /minimum hold/u, 'the same hold rule as the main arm');
  const last = rows(h, 'SELECT costs_usd, net_usd FROM arms WHERE arm = ? ORDER BY id DESC LIMIT 1', 'code_judge');
  assert.ok(last.costs_usd > 0 && last.net_usd < 12, JSON.stringify(last));
});

test('R1-13: the config hash covers every decision and execution parameter and never a secret; discrete parameters must be integers', () => {
  const a = makeHarness({ env: { MAX_GAS_PCT_OF_NOTIONAL: '1' } });
  const b = makeHarness({ env: { MAX_GAS_PCT_OF_NOTIONAL: '5' } });
  assert.notEqual(a.ledger.provenance.configHash, b.ledger.provenance.configHash);
  for (const [k, v] of [['POSITION_MAX_AGE_SEC', '30'], ['L1_FEE_MARGIN_PCT', '50'], ['DEEPSEEK_MIN_CONFIDENCE', '0.7'], ['RECEIPT_TIMEOUT_MS', '60000'], ['MAX_CANDLE_AGE_SEC', '600']]) {
    assert.notEqual(makeHarness({ env: { [k]: v } }).ledger.provenance.configHash, a.ledger.provenance.configHash, k);
  }
  const key = '0x' + 'a'.repeat(64);
  const described = JSON.stringify(describeConfig(loadConfig({ AGENT_TEST: '1', PRIVATE_KEY: key, DEEPSEEK_API_KEY: 'sk-synthetic', RPC_URL: 'https://rpc.example/v2/secret-token' })));
  assert.ok(!described.includes(key) && !described.includes('sk-synthetic') && !described.includes('secret-token'), 'no secret in the description');
  assert.throws(() => loadConfig({ AGENT_TEST: '1', VOTE_WINDOW: '5.5' }), /VOTE_WINDOW.*integer/u);
  assert.throws(() => loadConfig({ AGENT_TEST: '1', SLIPPAGE_BPS: '12.5' }), /SLIPPAGE_BPS.*integer/u);
  assert.throws(() => loadConfig({ AGENT_TEST: '1', MAX_SWITCHES_PER_DAY: '2.5' }), /integer/u);
  assert.equal(loadConfig({ AGENT_TEST: '1', SLIPPAGE_BPS: '30' }).slippageBps, 30);
});
