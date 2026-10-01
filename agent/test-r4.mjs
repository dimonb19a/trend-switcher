// Safe regressions for the fourth review round (R4): a cost billed during a wait is judged for
// risk against the balances valued at the tape's price AFTER that wait (E4); whether a leg's receipt
// facts are recorded and whether its USD cost is booked are two separate facts, so an unpriced leg
// that meets different facts keeps its originals and becomes a conflict nobody books but a human (C6);
// a conflict never erases a committed cost from the switch's total, and a settled leg that is not
// booked leaves that total explicitly unresolved (C7). AGENT_TEST=1 node --test agent/test-r4.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USDC, agreeingSummary, flatSummary, makeFeed, makeHarness } from './test-helpers.mjs';

const rows = (h, sql, ...args) => h.ledger.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const near = (a, b, eps = 1e-10) => Math.abs(a - b) < eps;
const gasCosts = (h) => rows(h, "SELECT id, usd, price_usd FROM costs WHERE kind = 'gas' ORDER BY id");
const valuation = (h, price, priceSource) => ({ price, priceAt: new Date(h.clock()).toISOString(), priceSource });
/** The parent switch's own label is not the subject of these tests: close it, so `stats.pendingSwitches` counts accounting obligations only. */
const closeParent = (h, id) => h.ledger.updateSwitch(id, { status: 'done' });

/** A switch with one swap leg already sent by an earlier run; optionally a second one. */
function priorSent(h, { legs = 1 } = {}) {
  const id = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'earlier run', notionalUsd: 12 });
  const out = { id, legs: [] };
  for (let seq = 1; seq <= legs; seq += 1) {
    const hash = `0xprior${seq}`;
    const leg = h.ledger.openLeg({ switchId: id, seq, kind: 'swap', tokenIn: seq === 1 ? 'ETH' : 'WETH', tokenOut: 'USDC', amountIn: 0.004 });
    h.ledger.updateLeg(leg, { status: 'sent', tx_hash: hash, nonce: 6 + seq, l1_bound_wei: '2500000000' });
    h.chain.fills.set(hash, { tokenOut: USDC, amountOutRaw: 12_000_000n });
    out.legs.push({ leg, hash });
  }
  return out;
}

const DROP = 2910.1; // −3.00 % from 3000: market drift alone stays inside the daily limit; the billed cost crosses it

test('R4-E4: a billed slow-brain reply is judged against the balances valued at the tape AFTER the wait — held and veto latch there; the rebound does not lift it', async () => {
  for (const kind of ['held', 'veto']) {
    const h = makeHarness();
    await h.advance(5);
    h.state.confirmFn = () => {
      h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: DROP, trendUp: false }).snapshot; // the tape moves while the slow brain answers
      return kind === 'held' ? { ok: false, reason: 'billed invalid answer', costUsd: 0.0004 } : { ok: true, agrees: false, stance: 'HOLD', confidence: 0.8, costUsd: 0.0004 };
    };
    const out = await h.last(1);
    assert.ok(kind === 'held' ? out.held : out.vetoed, `${kind}: ${JSON.stringify(out)}`);
    const atEntry = h.ledger.stats(12); const now = h.ledger.stats(0.004 * DROP);
    assert.ok(atEntry.dailyNetPnlPct > -3, `${kind}: at the entry price the same costs stay inside the limit (${atEntry.dailyNetPnlPct})`);
    assert.ok(now.dailyNetPnlPct <= -3, `${kind}: at the post-wait price the billed cost crosses (${now.dailyNetPnlPct})`);
    assert.ok(now.halt && /^risk \(slow-brain cost\): daily net loss -3\.00%/u.test(now.halt.reason), `${kind}: ${JSON.stringify(now.halt)}`);
    h.state.confirmFn = null;
    h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3000, trendUp: false }).snapshot;
    h.wait(h.cfg.deepseekCooldownMs);
    const rebound = await h.last(6);
    assert.notEqual(rebound.switched, true, kind);
    assert.equal(h.ledger.totals().switches, 0, kind);
  }
});

test('R4-E4 negative control: the same price drift with a sub-limit billed cost does not halt', async () => {
  const h = makeHarness();
  await h.advance(5);
  h.state.confirmFn = () => { h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: DROP, trendUp: false }).snapshot; return { ok: false, reason: 'billed invalid answer', costUsd: 0.0001 }; };
  const out = await h.last(1);
  assert.ok(out.held, JSON.stringify(out));
  const st = h.ledger.stats(0.004 * DROP);
  assert.ok(st.dailyNetPnlPct > -3, `${st.dailyNetPnlPct}`); assert.equal(st.halt, null, 'a refusal is not an emergency');
});

test('R4-E4: the same rule for the judgment cost — a price that moved during the judge\'s wait is what the billed cost is judged against, candidate or not', async () => {
  const h = makeHarness({ summary: flatSummary });
  await h.advance(1);
  h.ledger.recordCost('judge', 0.35 - h.ledger.stats(12).inferenceTodayUsd, 'near-limit prior cost', { external: true });
  assert.ok(h.ledger.stats(12).dailyNetPnlPct > -3, 'inside the limit at the entry price');
  h.state.summary = () => { h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 2990, trendUp: false }).snapshot; return flatSummary(); }; // summarize() runs after the judge's await
  const out = await h.last(1);
  assert.equal(out.candidate, null);
  const st = h.ledger.stats(0.004 * 2990);
  assert.ok(st.dailyNetPnlPct <= -3, `${st.dailyNetPnlPct}`);
  assert.ok(st.halt && /^risk \(judgment cost\): daily net loss/u.test(st.halt.reason), JSON.stringify(st.halt));
  assert.ok(h.ledger.stats(12).dailyNetPnlPct > -3, 'the entry valuation alone would not have latched');
});

test('R4-E4: a tape that went stale or silent during the wait is not passed off as fresh — the last price still latches (the safe direction) and the reason names the caveat', async () => {
  const stale = makeHarness();
  await stale.advance(5);
  stale.state.confirmFn = () => { stale.feed.snapshot = makeFeed({ frozenAt: stale.clock() - 60_000, price: DROP, trendUp: false }).snapshot; return { ok: false, reason: 'billed invalid answer', costUsd: 0.0004 }; };
  const out = await stale.last(1);
  assert.ok(out.held, JSON.stringify(out));
  const st = stale.ledger.stats(0.004 * DROP);
  assert.ok(st.halt && /^risk \(slow-brain cost\): daily net loss -3\.00% beyond the daily limit 3% \[stale tape \(60 s\) valued at its last price\]$/u.test(st.halt.reason), JSON.stringify(st.halt));

  const silent = makeHarness();
  await silent.advance(5);
  silent.ledger.recordCost('judge', 0.35985 - silent.ledger.stats(12).inferenceTodayUsd, 'near-limit prior cost', { external: true });
  silent.state.confirmFn = () => { silent.feed.snapshot = () => ({ product: 'ETH-USD', ticks: [], last: null, gaps: [], eventAgeMs: NaN, candles: [], candlesContiguous: false, candlesEventAgeMs: NaN, candlesSource: null, candlesDegraded: false, rejected: {}, reordered: 0, reconnects: 1, disconnected: true }); return { ok: false, reason: 'billed invalid answer', costUsd: 0.0002 }; };
  const held = await silent.last(1);
  assert.ok(held.held, JSON.stringify(held));
  const s2 = silent.ledger.stats(12);
  assert.ok(s2.halt && /^risk \(slow-brain cost\): daily net loss .* \[no tape price after the wait; entry valuation\]$/u.test(s2.halt.reason), JSON.stringify(s2.halt));
});

test('R4-C6: an unpriced settled leg that meets DIFFERENT receipt facts keeps its originals and becomes a conflict nobody books but a human; it blocks new switches and the switch total stays unresolved', async () => {
  for (const field of ['status', 'l2Wei', 'amountOutRaw']) {
    const h = makeHarness({ live: true });
    const { id, legs: [{ leg, hash }] } = priorSent(h);
    const facts = await h.chain.receiptFacts(hash, { tokenOut: USDC });
    const first = h.engine.settleLeg(h.ledger.getLeg(leg), facts, null); // a cold start: no price yet
    assert.deepEqual([first.booked, first.replay, first.conflict], [false, false, false], field);
    assert.equal(h.ledger.getLeg(leg).accounting, 'pending', field);
    assert.equal(h.ledger.getSwitch(id).spent_usd, null, `${field}: an unpriced settlement leaves the total unresolved, not zero`);
    const other = { ...facts, [field]: field === 'status' ? 0 : facts[field] + 1n };
    const out = h.engine.settleLeg(h.ledger.getLeg(leg), other, valuation(h, 3000, 'test:conflict'));
    assert.deepEqual([out.conflict, out.booked, out.replay], [true, false, true], field);
    const row = h.ledger.getLeg(leg);
    assert.equal(row.accounting, 'conflict', field); assert.match(row.error, /receipt facts differ/u);
    assert.equal(row.status, 'confirmed', `${field}: the first facts stand`); assert.equal(row.gas_l2_wei, String(facts.l2Wei), field); assert.equal(row.amount_out_raw, String(facts.amountOutRaw), field);
    assert.equal(row.price_usd, null, `${field}: nothing was booked`); assert.equal(gasCosts(h).length, 0, field);
    assert.equal(h.ledger.getSwitch(id).spent_usd, null, `${field}: the total is unresolved`);
    closeParent(h, id);
    assert.equal(h.ledger.legsAwaitingAccounting().length, 1, `${field}: the disputed leg is an accounting obligation`);
    assert.equal(h.ledger.stats(12).pendingSwitches, 1, `${field}: the disputed obligation blocks a new switch`);
    assert.equal(h.engine.bookPending(valuation(h, 3100, 'test:next-tick')), 0, `${field}: the next priced tick books nothing of it`);
    assert.equal(gasCosts(h).length, 0, field); assert.equal(h.ledger.getLeg(leg).accounting, 'conflict', field);
    const again = h.engine.settleLeg(h.ledger.getLeg(leg), facts, valuation(h, 3200, 'test:matching-later'));
    assert.deepEqual([again.conflict, again.booked], [true, false], `${field}: matching input later does not clear a conflict`);
    assert.equal(gasCosts(h).length, 0, field); assert.equal(h.ledger.stats(12).pendingSwitches, 1, field);
  }
});

test('R4-C6: an unpriced settled leg that meets the SAME receipt facts is a replay that may take its first valuation, once; a booked one changes nothing on any later replay', async () => {
  const h = makeHarness({ live: true });
  const { id, legs: [{ leg, hash }] } = priorSent(h);
  const facts = await h.chain.receiptFacts(hash, { tokenOut: USDC });
  const first = h.engine.settleLeg(h.ledger.getLeg(leg), facts, null);
  assert.deepEqual([first.booked, first.replay, first.conflict], [false, false, false]);
  closeParent(h, id);
  assert.equal(h.ledger.stats(12).pendingSwitches, 1, 'the obligation blocks until priced');
  const second = h.engine.settleLeg(h.ledger.getLeg(leg), facts, valuation(h, 3000, 'test:first'));
  assert.deepEqual([second.booked, second.replay, second.conflict], [true, true, false]);
  const cost = gasCosts(h); const row = h.ledger.getLeg(leg);
  assert.equal(cost.length, 1); assert.equal(cost[0].price_usd, 3000); assert.equal(row.accounting, 'booked'); assert.equal(row.price_source, 'test:first');
  assert.ok(near(h.ledger.getSwitch(id).spent_usd, cost[0].usd), 'the total follows the booking'); assert.equal(h.ledger.stats(12).pendingSwitches, 0);
  const third = h.engine.settleLeg(h.ledger.getLeg(leg), facts, valuation(h, 3300, 'test:later'));
  assert.deepEqual([third.booked, third.replay, third.conflict], [false, true, false]);
  assert.equal(gasCosts(h).length, 1); assert.equal(h.ledger.getLeg(leg).price_usd, 3000); assert.ok(near(h.ledger.getSwitch(id).spent_usd, cost[0].usd));
});

test('R4-C7: a conflict discovered on a BOOKED leg never erases its committed cost from the switch total; a later leg adds to that total; the booked conflict stays flagged for a human without blocking', async () => {
  const h = makeHarness({ live: true });
  const { id, legs: [one, two] } = priorSent(h, { legs: 2 });
  const facts1 = await h.chain.receiptFacts(one.hash, { tokenOut: USDC });
  assert.equal(h.engine.settleLeg(h.ledger.getLeg(one.leg), facts1, valuation(h, 3000, 'test:first')).booked, true);
  const afterFirst = h.ledger.getSwitch(id).spent_usd;
  assert.ok(afterFirst > 0 && near(afterFirst, gasCosts(h)[0].usd), 'a leg still in flight carries no facts, so the total is what is booked so far');
  const conflict = h.engine.settleLeg(h.ledger.getLeg(one.leg), { ...facts1, l2Wei: facts1.l2Wei + 1n }, valuation(h, 3300, 'test:conflict'));
  assert.deepEqual([conflict.conflict, conflict.booked], [true, false]);
  assert.ok(near(h.ledger.getSwitch(id).spent_usd, afterFirst), 'the conflict changes nothing in the total');
  const facts2 = await h.chain.receiptFacts(two.hash, { tokenOut: USDC });
  assert.equal(h.engine.settleLeg(h.ledger.getLeg(two.leg), facts2, valuation(h, 3000, 'test:second')).booked, true);
  const costs = gasCosts(h); const total = costs.reduce((s, r) => s + r.usd, 0);
  assert.equal(costs.length, 2);
  assert.ok(near(h.ledger.getSwitch(id).spent_usd, total), `both committed costs are in the total: ${h.ledger.getSwitch(id).spent_usd} vs ${total}`);
  const flagged = h.ledger.getLeg(one.leg);
  assert.equal(flagged.accounting, 'conflict'); assert.equal(flagged.price_usd, 3000); assert.match(flagged.error, /receipt facts differ/u);
  closeParent(h, id);
  assert.equal(h.ledger.legsAwaitingAccounting().length, 0);
  assert.equal(h.ledger.stats(12).pendingSwitches, 0, 'a booked conflict is not an accounting obligation: its cost is committed; the flag is for a human');
  assert.equal(h.engine.bookPending(valuation(h, 3500, 'test:next-tick')), 0); assert.equal(gasCosts(h).length, 2);
});

test('R4-C7: while any settled leg of a switch is not booked, the switch total is NULL (unresolved), never the smaller sum; the full sum appears when the obligation is booked', async () => {
  const h = makeHarness({ live: true });
  const { id, legs: [one, two] } = priorSent(h, { legs: 2 });
  const facts1 = await h.chain.receiptFacts(one.hash, { tokenOut: USDC });
  h.engine.settleLeg(h.ledger.getLeg(one.leg), facts1, valuation(h, 3000, 'test:first'));
  const cost1 = gasCosts(h)[0].usd;
  assert.ok(near(h.ledger.getSwitch(id).spent_usd, cost1));
  const facts2 = await h.chain.receiptFacts(two.hash, { tokenOut: USDC });
  assert.equal(h.engine.settleLeg(h.ledger.getLeg(two.leg), facts2, null).booked, false); // settled on a cold feed
  assert.equal(h.ledger.getSwitch(id).spent_usd, null, 'one settled leg is not booked: the total is unresolved, not the first leg alone');
  closeParent(h, id);
  assert.equal(h.ledger.stats(12).pendingSwitches, 1, 'the unpriced obligation blocks a new switch');
  assert.equal(h.engine.bookPending(valuation(h, 3100, 'test:next-tick')), 1);
  const costs = gasCosts(h);
  assert.equal(costs.length, 2); assert.equal(costs[1].price_usd, 3100);
  assert.ok(near(h.ledger.getSwitch(id).spent_usd, costs[0].usd + costs[1].usd), 'the full sum once everything is booked');
  assert.equal(h.ledger.stats(12).pendingSwitches, 0);
});

test('R4: the normal live path still books every leg once and totals them; the paper path is untouched', async () => {
  const live = makeHarness({ live: true });
  const out = await live.last(6);
  assert.equal(out.switched, true, JSON.stringify(out));
  const sw = live.ledger.getSwitch(1); const costs = gasCosts(live);
  assert.equal(sw.status, 'done'); assert.equal(costs.length, live.ledger.legsOf(1).length);
  assert.ok(near(sw.spent_usd, costs.reduce((s, r) => s + r.usd, 0)), `spent ${sw.spent_usd}`);
  assert.equal(live.ledger.stats(1).pendingSwitches, 0);
  const paper = makeHarness();
  const p = await paper.last(6);
  assert.equal(p.switched, true, JSON.stringify(p));
  assert.equal(paper.ledger.getSwitch(1).spent_usd, paper.cfg.paperGasUsdPerLeg); assert.equal(paper.ledger.stats(1).pendingSwitches, 0);
});
