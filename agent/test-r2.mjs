// Safe regressions for the second review round's boundary findings (R2): valuation at the verdict's own
// price, a loss seen anywhere latching there, and one replay-safe receipt settlement that survives
// a cold feed, a crash after any durable step (with a real file DB closed and reopened) and a
// parent switch mislabelled by an exception. AGENT_TEST=1 node --test agent/test-r2.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from './engine.mjs';
import { Feed } from './feed.mjs';
import { openLedger } from './ledger.mjs';
import { USDC, agreeingSummary, fakeChain, fakeJudge, makeCfg, makeFeed, makeHarness } from './test-helpers.mjs';

const rows = (h, sql, ...args) => h.ledger.db.prepare(sql).all(...args).map((r) => ({ ...r })); // plain objects (node:sqlite rows have a null prototype)
const usdOf = (wei, price = 3000) => (Number(wei) / 1e18) * price; // the fake receipt: L2 900e9 wei + L1 2e9 wei; the fake bound: L1 2.5e9 wei
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

/** A switch with one swap leg already sent (the state a crash after the broadcast leaves behind). */
function sentLeg(h, hash = '0xsent') {
  const id = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'earlier run', notionalUsd: 12 });
  const leg = h.ledger.openLeg({ switchId: id, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  h.ledger.updateLeg(leg, { status: 'sent', tx_hash: hash, nonce: 7, l1_bound_wei: '2500000000' });
  h.chain.fills.set(hash, { tokenOut: USDC, amountOutRaw: 12_000_000n });
  return { id, leg };
}

test('R2-B1: the verdict values the balances it was handed at ITS price; a 10% drop during the last balance read vetoes, in paper and in fake live, and latches', async () => {
  for (const live of [false, true]) {
    const h = makeHarness({ live });
    await h.advance(5);
    const balances = h.chain.balances; let n = 0;
    h.chain.balances = async (...args) => {
      if (++n === (live ? 4 : 3)) { h.wait(1000); h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 2700, trendUp: false }).snapshot; }
      return balances(...args);
    };
    const out = await h.last(1);
    assert.equal(out.switched, false, `${live ? 'live' : 'paper'}: ${JSON.stringify(out)}`);
    assert.match(out.result.reason, /halted|daily net loss/u, live ? 'live' : 'paper');
    assert.equal(h.chain.calls.sends.length, 0, 'nothing broadcast');
    assert.match(h.ledger.stats(10.8).halt.reason, /^risk \((paper fill|swap ETH)\): daily net loss/u, 'the loss seen at the verdict latched there, naming the stage');
    if (!live) assert.equal(h.ledger.kv.get('paper:balances').usdc, 0);
  }
});

test('R2-B1: valuePosition is pure and admissible re-values: the same balances at 3000 and 2700 give different wallets, sides and notionals', async () => {
  const h = makeHarness({ live: true });
  const balances = await h.engine.readBalances();
  const a = h.engine.valuePosition(balances, 3000); const b = h.engine.valuePosition(balances, 2700);
  assert.ok(Math.abs(a.walletUsd - 15) < 1e-9 && Math.abs(b.walletUsd - 13.5) < 1e-9);
  assert.ok(Math.abs(a.ethUsd - 12) < 1e-9 && Math.abs(b.ethUsd - 10.8) < 1e-9);
  assert.equal(a.at, b.at, 'the balance timestamp is the read time, not the valuation');
  const pf = h.engine.admissible({ stage: 'test', target: null, position: balances });
  assert.equal(pf.price, 3000); assert.ok(Math.abs(pf.position.walletUsd - 15) < 1e-9);
  assert.equal(pf.priceSource, 'coinbase:ETH-USD@test');
});

test('R2-E1: a loss first seen after the slow brain latches at the verdict; the rebound and the cooldown do not lift it; only --reset-halt does', async () => {
  const h = makeHarness();
  await h.advance(5);
  h.state.confirmFn = (args) => { h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 2700, trendUp: false }).snapshot; return { ok: true, agrees: true, stance: args.candidate, confidence: 0.8, costUsd: 0.0002 }; };
  const down = await h.last(1);
  assert.ok(down.aborted?.some((p) => /halted/u.test(p)), JSON.stringify(down));
  const halt = h.ledger.stats(10.8).halt;
  // until v2.4 the loss was first seen at the verdict (`pre-switch`); since v2.5 (R4-E4) the billed slow-brain cost is
  // judged against the post-wait valuation, one step earlier, so the same loss latches there — the latch, the abort,
  // the rebound and the reset behave exactly as before
  assert.ok(halt && /^risk \(slow-brain cost\): daily net loss -10\.00%/u.test(halt.reason), JSON.stringify(halt));
  h.state.confirmFn = null;
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3000, trendUp: false }).snapshot;
  h.wait(h.cfg.deepseekCooldownMs);
  const rebound = await h.last(6);
  assert.notEqual(rebound.switched, true, JSON.stringify(rebound));
  assert.equal(h.ledger.totals().switches, 0);
  h.ledger.resetHalt();
  const after = await h.last(1);
  assert.equal(after.switched, true, JSON.stringify(after));
});

test('R2-C1: a cold-start recovery settles the receipt in native units and keeps the gas as an obligation that blocks switching; the first priced tick books it once, with the price and its source', async () => {
  const h = makeHarness({ live: true });
  const { id, leg } = sentLeg(h);
  const cold = new Feed({ clock: h.clock });
  h.feed.snapshot = cold.snapshot.bind(cold);
  const rec = await h.engine.recoverPending();
  const row = h.ledger.getLeg(leg);
  assert.equal(row.status, 'confirmed'); assert.equal(row.accounting, 'pending');
  assert.equal(row.gas_l2_wei, '900000000000'); assert.equal(row.gas_l1_wei, '2000000000'); assert.equal(row.amount_out_raw, '12000000'); assert.equal(row.amount_out_actual, 12);
  assert.equal(row.gas_l2_usd, null, 'no USD without a price');
  assert.equal(h.ledger.totals().costs.gas, undefined, 'nothing booked as zero');
  assert.equal(rec.unbookedLegs, 1); assert.equal(rec.halt, null); assert.equal(h.ledger.getSwitch(id).status, 'done');
  assert.ok(h.ledger.stats(15).pendingSwitches > 0, 'the obligation blocks a new switch');
  // the first priced tick books it before any decision
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), trendUp: false }).snapshot;
  await h.advance(1);
  const booked = h.ledger.getLeg(leg);
  assert.equal(booked.accounting, 'booked'); assert.ok(booked.gas_l2_usd > 0 && booked.gas_l1_usd > 0);
  assert.equal(booked.price_source, 'coinbase:ETH-USD@tick'); assert.equal(booked.price_usd, 3000);
  const costs = rows(h, "SELECT usd, key, price_usd, price_source, estimate FROM costs WHERE kind = 'gas'");
  assert.equal(costs.length, 1); assert.equal(costs[0].key, `leg:${leg}:gas`); assert.equal(costs[0].price_source, 'coinbase:ETH-USD@tick'); assert.equal(costs[0].estimate, 0);
  assert.ok(near(costs[0].usd, usdOf(902_000_000_000n)), `${costs[0].usd}`);
  assert.ok(near(h.ledger.getSwitch(id).spent_usd, costs[0].usd), 'the switch\'s spent figure follows');
  assert.equal(h.ledger.stats(15).pendingSwitches, 0);
  await h.advance(1);
  assert.equal(rows(h, "SELECT id FROM costs WHERE kind = 'gas'").length, 1, 'a later tick does not book it again');
  // a recovery that has a price books at once, and says so
  const g = makeHarness({ live: true });
  const { leg: leg2 } = sentLeg(g, '0xpriced');
  const rec2 = await g.engine.recoverPending();
  assert.equal(rec2.unbookedLegs, 0); assert.equal(g.ledger.getLeg(leg2).price_source, 'coinbase:ETH-USD@recovery');
  assert.ok(g.ledger.totals().costs.gas > 0);
});

test('R2-C1: a receipt without an L1 fee books the pre-send L1 bound as an estimate, never zero; a leg without any bound says so in the ledger', async () => {
  const h = makeHarness({ live: true, chainOptions: { l1Known: false } });
  const { leg } = sentLeg(h);
  await h.engine.recoverPending();
  const row = h.ledger.getLeg(leg);
  assert.equal(row.l1_known, 0); assert.equal(row.gas_l1_wei, null);
  assert.ok(near(row.gas_l1_usd, usdOf(2_500_000_000n)), `the bound, in USD: ${row.gas_l1_usd}`);
  const cost = rows(h, "SELECT usd, estimate FROM costs WHERE kind = 'gas'")[0];
  assert.equal(cost.estimate, 1); assert.ok(near(cost.usd, usdOf(902_500_000_000n)), `${cost.usd}`);
  const g = makeHarness({ live: true, chainOptions: { l1Known: false } });
  const id = g.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'old', notionalUsd: 12 });
  const bare = g.ledger.openLeg({ switchId: id, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
  g.ledger.updateLeg(bare, { status: 'sent', tx_hash: '0xbare', nonce: 7 });
  await g.engine.recoverPending();
  const c = rows(g, "SELECT usd, estimate, ref FROM costs WHERE kind = 'gas'")[0];
  assert.equal(c.estimate, 1); assert.match(c.ref, /L1 fee unknown/u); assert.ok(near(c.usd, usdOf(900_000_000_000n)), `${c.usd}`);
});

test('R2-C2: a crash after ANY durable step of the settlement, with the file DB closed and reopened, replays to exactly one cost row, one confirmed leg and one done switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-r2c2-'));
  try {
    const steps = ['status', 'accounting', 'spent', 'after'];
    for (const [i, step] of steps.entries()) {
      const path = join(dir, `crash-${i}.db`);
      const cfg = makeCfg({ MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real', AGENT_DB_PATH: path });
      let now = 1_800_000_000_000; const clock = () => now;
      const open = () => openLedger(cfg, { clock });
      const engineOn = (ledger, chain) => createEngine({ cfg, armed: true, chain, ledger, feed: makeFeed({ eventAt: now, trendUp: false }), judge: fakeJudge(() => agreeingSummary('USDC')), slowBrain: {}, clock, fsx: { existsSync: () => false } });
      // run 1: the leg is sent; the settlement crashes after step `step`
      let ledger = open(); let chain = fakeChain({ clock });
      const id = ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'run 1', notionalUsd: 12 });
      const leg = ledger.openLeg({ switchId: id, seq: 1, kind: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 0.004 });
      ledger.updateLeg(leg, { status: 'sent', tx_hash: '0xcrash', nonce: 7, l1_bound_wei: '2500000000' });
      chain.fills.set('0xcrash', { tokenOut: USDC, amountOutRaw: 12_000_000n });
      const realUpdate = ledger.updateLeg; const realSpent = ledger.recomputeSpent; let armed = true;
      ledger.updateLeg = (legId, fields) => { const out = realUpdate(legId, fields); if (armed && ((step === 'status' && fields.status === 'confirmed') || (step === 'accounting' && fields.accounting === 'booked'))) { armed = false; throw new Error(`synthetic crash after ${step}`); } return out; };
      ledger.recomputeSpent = (swId) => { realSpent(swId); if (armed && step === 'spent') { armed = false; throw new Error('synthetic crash after spent'); } };
      if (step === 'after') await engineOn(ledger, chain).recoverPending(); else await assert.rejects(engineOn(ledger, chain).recoverPending(), /synthetic crash/u);
      ledger.close(); // the process dies here
      // run 2: reopen the same file and recover again
      ledger = open(); chain = fakeChain({ clock }); chain.fills.set('0xcrash', { tokenOut: USDC, amountOutRaw: 12_000_000n });
      const rec = await engineOn(ledger, chain).recoverPending();
      const costs = ledger.db.prepare("SELECT usd, key FROM costs WHERE kind = 'gas'").all();
      assert.equal(costs.length, 1, `${step}: one cost row after replay, got ${JSON.stringify(costs)}`);
      assert.equal(costs[0].key, `leg:${leg}:gas`);
      const row = ledger.getLeg(leg);
      assert.equal(row.status, 'confirmed', step); assert.equal(row.accounting, 'booked', step); assert.equal(row.amount_out_actual, 12, step);
      assert.equal(ledger.getSwitch(id).status, 'done', step);
      assert.ok(Math.abs(ledger.getSwitch(id).spent_usd - costs[0].usd) < 1e-9, step);
      assert.equal(rec.unresolvedLegs, 0, step); assert.equal(rec.unbookedLegs, 0, step);
      if (step !== 'after') assert.ok(rec.halt === null || !/after restart/u.test(rec.halt.reason), `${step}: a settled switch latches nothing`);
      await engineOn(ledger, chain).recoverPending();
      assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM costs WHERE kind = 'gas'").get().n, 1, `${step}: a third recovery changes nothing`);
      ledger.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R2-C2: the same exactly-once rule holds on the normal path: a settlement is one transaction, a duplicate key is ignored, the ledger says so', async () => {
  const h = makeHarness({ live: true });
  const out = await h.last(6);
  assert.equal(out.switched, true, JSON.stringify(out));
  const leg = h.ledger.legsOf(1)[0];
  assert.equal(leg.accounting, 'booked'); assert.equal(leg.price_source, 'coinbase:ETH-USD@swap ETH'); assert.ok(leg.gas_l2_wei && leg.gas_l1_wei);
  const costs = rows(h, "SELECT key FROM costs WHERE kind = 'gas'");
  assert.deepEqual(costs, [{ key: `leg:${leg.id}:gas` }]);
  assert.equal(h.ledger.recordCost('gas', 1, 'replay', { key: `leg:${leg.id}:gas`, external: false }), false, 'the ledger refuses the duplicate');
  assert.equal(rows(h, "SELECT id FROM costs WHERE kind = 'gas'").length, 1);
  assert.ok(near(h.ledger.getSwitch(1).spent_usd, usdOf(902_000_000_000n)), `${h.ledger.getSwitch(1).spent_usd}`);
});

test('R2-C3: an RPC exception after the broadcast leaves the switch UNKNOWN (not failed) and halted; recovery revisits the sent leg, settles it once, and the halt stays', async () => {
  const h = makeHarness({ live: true });
  const facts = h.chain.receiptFacts;
  h.chain.receiptFacts = async () => { throw new Error('synthetic temporary RPC outage'); };
  const out = await h.last(6);
  assert.equal(out.switched, false, JSON.stringify(out));
  assert.equal(h.ledger.getSwitch(1).status, 'unknown', 'an exception is not a proven failure');
  assert.match(h.ledger.getSwitch(1).reason, /outcome unknown/u);
  assert.equal(h.ledger.legsOf(1)[0].status, 'sent');
  const halt = h.ledger.stats(15).halt; assert.ok(halt);
  assert.ok(h.ledger.switchesToSettle().some((s) => s.id === 1), 'the switch is on the settle list through its leg');
  // a recovery during the outage propagates the error and leaves everything as it was
  await assert.rejects(h.engine.recoverPending(), /synthetic temporary RPC outage/u);
  assert.equal(h.ledger.legsOf(1)[0].status, 'sent');
  h.chain.receiptFacts = facts;
  const before = h.chain.calls.receiptQueries.length;
  const rec = await h.engine.recoverPending();
  assert.ok(h.chain.calls.receiptQueries.length > before, 'recovery visited the sent leg despite the parent\'s label');
  assert.equal(h.ledger.pendingLegs().length, 0);
  assert.deepEqual(h.ledger.legsOf(1).map((l) => [l.status, l.accounting]), [['confirmed', 'booked']]);
  assert.equal(h.ledger.getSwitch(1).status, 'done');
  assert.equal(rows(h, "SELECT id FROM costs WHERE kind = 'gas'").length, 1);
  assert.deepEqual(rec.halt, halt, 'recovery never resets a halt');
  const more = await h.last(6);
  assert.ok(more.blocked?.some((p) => /halted/u.test(p)) || more.candidate === null, JSON.stringify(more));
  // a failed-labelled switch from an older run with a sent leg is found too
  const g = makeHarness({ live: true });
  const { id, leg } = sentLeg(g, '0xold');
  g.ledger.updateSwitch(id, { status: 'failed', reason: 'mislabelled by an older run' });
  await g.engine.recoverPending();
  assert.equal(g.ledger.getLeg(leg).status, 'confirmed'); assert.equal(g.ledger.getSwitch(id).status, 'done');
});

test('R2-C3: an exception before any broadcast cancels the planned legs and closes the switch as never sent; a partial plan derives partial', async () => {
  const h = makeHarness({ live: true });
  h.chain.estimateTx = async () => { throw new Error('synthetic estimate outage'); };
  const out = await h.last(6);
  assert.equal(out.switched, false);
  assert.equal(h.ledger.getSwitch(1).status, 'failed_before_send');
  assert.deepEqual(h.ledger.legsOf(1).map((l) => l.status), ['cancelled']);
  assert.ok(h.ledger.stats(15).halt, 'an exception inside a switch still latches');
  const g = makeHarness({ live: true, chainOptions: { balances: { eth: 0.002, weth: 0, usdc: 12 } }, summary: () => agreeingSummary('ETH'), trendUp: true });
  // estimate calls: 1 = the approval's bound, 2 = the approval right before its broadcast, 3 = the swap after the approval confirmed
  const est = g.chain.estimateTx; let n = 0;
  g.chain.estimateTx = async (...args) => { n += 1; if (n === 3) throw new Error('synthetic outage after the approval'); return est(...args); };
  const o = await g.last(6);
  assert.equal(o.switched, false);
  assert.deepEqual(g.ledger.legsOf(1).map((l) => [l.kind, l.status]), [['approve', 'confirmed'], ['swap', 'cancelled']]);
  assert.equal(g.ledger.getSwitch(1).status, 'partial');
});

test('negative controls on restart: successful, reverted and receipt-less legs; a receipt-less leg stays unknown and keeps blocking after a priced tick', async () => {
  const ok = makeHarness({ live: true }); sentLeg(ok, '0xok');
  const rOk = await ok.engine.recoverPending();
  assert.equal(rOk.halt, null); assert.equal(ok.ledger.getSwitch(1).status, 'done');
  const rv = makeHarness({ live: true, chainOptions: { receipt: 'revert' } }); sentLeg(rv, '0xrv');
  const rRv = await rv.engine.recoverPending();
  assert.match(rRv.halt.reason, /failed after restart/u); assert.equal(rv.ledger.getSwitch(1).status, 'failed'); assert.ok(rv.ledger.totals().costs.gas > 0, 'a revert still cost gas');
  const none = makeHarness({ live: true, chainOptions: { receipt: 'missing' } }); sentLeg(none, '0xnone');
  const rNone = await none.engine.recoverPending();
  assert.match(rNone.halt.reason, /unknown after restart/u); assert.equal(rNone.unresolvedLegs, 1);
  const later = await none.last(1);
  assert.notEqual(later.switched, true);
  assert.equal(none.ledger.pendingLegs().length, 1, 'still unknown, still pending');
  assert.equal(none.ledger.totals().costs.gas, undefined, 'nothing booked for a transaction whose outcome is unknown');
});
