// Safe regressions for the third review round (R3): the verdict judges the exact amount that
// will be sent (V1), a billed cost is judged for risk before any early return (E2/E3), a terminal
// status and its required halt are one durable step that survives SIGKILL and a crash between them
// (C4), and a replay of the same receipt keeps the first valuation while conflicting facts become
// visible (C5). AGENT_TEST=1 node --test agent/test-r3.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USDC, agreeingSummary, flatSummary, makeFeed, makeHarness } from './test-helpers.mjs';

const rows = (h, sql, ...args) => h.ledger.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const near = (a, b, eps = 1e-10) => Math.abs(a - b) < eps;

/** A switch with one leg already sent by an earlier run (optionally a paid approval whose swap never ran). */
function priorSent(h, { partial = false } = {}) {
  const id = h.ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'earlier run', notionalUsd: 12 });
  const leg = h.ledger.openLeg({ switchId: id, seq: 1, kind: partial ? 'approve' : 'swap', tokenIn: 'ETH', tokenOut: partial ? null : 'USDC', amountIn: 0.004 });
  h.ledger.updateLeg(leg, { status: partial ? 'approval_sent' : 'sent', tx_hash: '0xprior', nonce: 7, l1_bound_wei: '2500000000' });
  if (partial) h.ledger.openLeg({ switchId: id, seq: 2, kind: 'swap', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 0.004 });
  h.chain.fills.set('0xprior', { tokenOut: USDC, amountOutRaw: 12_000_000n });
  return { id, leg };
}

function crash(dbPath, scenario) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./probe-r3-crash.mjs', import.meta.url)), dbPath, scenario], { env: { PATH: process.env.PATH, AGENT_TEST: '1', TMPDIR: process.env.TMPDIR ?? tmpdir() }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.error, undefined);
  assert.equal(r.stdout.trim(), `CRASH_BOUNDARY:${scenario}`, 'child reached the exact uncommitted boundary');
  if (process.platform === 'win32') assert.equal(r.status, 1, 'Windows TerminateProcess exit');
  else assert.equal(r.signal, 'SIGKILL', `${scenario}: ${JSON.stringify({ status: r.status, signal: r.signal })}`);
}

test('R3-V1: the verdict judges the exact amount the transaction carries at its own price; a balance that moved since the plan refuses; a price-only cap breach refuses', async () => {
  for (const drift of [true, false]) {
    const h = makeHarness({ live: true, chainOptions: { balances: { eth: 0.034, weth: 0, usdc: 0 } } }); // plan: 0.033 ETH = $99 at 3000
    await h.advance(5);
    const balances = h.chain.balances; let reads = 0;
    h.chain.balances = async (...args) => { if (++reads === 4) { if (drift) h.chain.bal.eth = 0.0338; h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3035, trendUp: false }).snapshot; } return balances(...args); };
    const out = await h.last(1);
    assert.equal(out.switched, false, `drift=${drift}: ${JSON.stringify(out)}`);
    assert.equal(h.chain.calls.sends.length, 0, `drift=${drift}: nothing broadcast`);
    assert.match(out.result.reason, drift ? /balance changed since the plan/u : /above the pilot cap/u, `drift=${drift}`);
    assert.equal(h.ledger.getSwitch(1).status, 'failed_before_send');
  }
  // the honest case: a deposit after the plan does not change what is sent, and the sent amount is what the cap sees
  const g = makeHarness({ live: true, chainOptions: { balances: { eth: 0.034, weth: 0, usdc: 0 } } });
  await g.advance(5);
  const balances = g.chain.balances; let reads = 0;
  g.chain.balances = async (...args) => { if (++reads === 4) g.chain.bal.eth = 0.05; return balances(...args); };
  const ok = await g.last(1);
  assert.equal(ok.switched, true, JSON.stringify(ok));
  assert.ok(near(Number(g.chain.calls.sends[0].tx.value) / 1e18, 0.033), 'the planned amount, not the new holdings, is what left');
  assert.ok(near(g.ledger.getSwitch(1).notional_usd, 99), 'the notional recorded is the sent amount at the pre-switch price');
});

test('R3-V1 paper: the same contract — the fill moves exactly the planned amount and is judged on it', async () => {
  const h = makeHarness();
  const out = await h.last(6);
  assert.equal(out.switched, true, JSON.stringify(out));
  const leg = h.ledger.legsOf(1)[0];
  assert.equal(leg.amount_in, 0.004);
  assert.equal(h.ledger.kv.get('paper:balances').ethSide, 0);
});

test('R3-E2: an ordinary judgment cost that crosses the daily loss limit latches in that tick, with no candidate; the rebound does not lift it', async () => {
  const h = makeHarness({ summary: flatSummary });
  await h.advance(1);
  h.ledger.recordCost('judge', 0.35999 - h.ledger.stats(12).inferenceTodayUsd, 'near-limit prior cost', { external: true });
  assert.ok(h.ledger.stats(12).dailyNetPnlPct > -3, 'not crossed yet');
  const out = await h.last(1);
  assert.equal(out.candidate, null);
  const breach = h.ledger.stats(12);
  assert.ok(breach.dailyNetPnlPct <= -3, `crossed: ${breach.dailyNetPnlPct}`);
  assert.ok(breach.halt && /^risk \(judgment cost\)/u.test(breach.halt.reason), JSON.stringify(breach.halt));
  h.state.summary = () => agreeingSummary('USDC');
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3001, trendUp: false }).snapshot;
  const rebound = await h.advance(6);
  assert.ok(rebound.every((x) => x.switched !== true), JSON.stringify(rebound[5]));
  assert.equal(h.ledger.totals().switches, 0);
});

test('R3-E3: a billed slow-brain reply (held or veto) that crosses the limit latches before the early return', async () => {
  for (const kind of ['held', 'veto']) {
    const h = makeHarness();
    await h.advance(5);
    h.ledger.recordCost('judge', 0.35985 - h.ledger.stats(12).inferenceTodayUsd, 'near-limit prior cost', { external: true });
    h.state.confirmFn = () => (kind === 'held' ? { ok: false, reason: 'billed invalid answer', costUsd: 0.0002 } : { ok: true, agrees: false, stance: 'HOLD', confidence: 0.8, costUsd: 0.0002 });
    const out = await h.last(1);
    assert.ok(kind === 'held' ? out.held : out.vetoed, `${kind}: ${JSON.stringify(out)}`);
    const breach = h.ledger.stats(12);
    assert.ok(breach.dailyNetPnlPct <= -3, `${kind}: crossed ${breach.dailyNetPnlPct}`);
    assert.ok(breach.halt && /^risk \(slow-brain cost\)/u.test(breach.halt.reason), `${kind}: ${JSON.stringify(breach.halt)}`);
    h.state.confirmFn = null;
    h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3001, trendUp: false }).snapshot;
    h.wait(h.cfg.deepseekCooldownMs);
    const rebound = await h.last(6);
    assert.notEqual(rebound.switched, true, kind);
  }
  const control = makeHarness({ summary: flatSummary });
  await control.advance(3);
  assert.equal(control.ledger.stats(12).halt, null, 'sub-limit judging is not an emergency');
});

test('R3-C4: the terminal status and its required halt are one durable step — SIGKILL right after the status row is written leaves the switch open, and the restart settles it WITH the halt', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-r3c4-')));
  try {
    for (const scenario of ['recover-failed', 'recover-partial', 'normal-failed']) {
      const path = join(dir, `${scenario}.db`);
      let h = makeHarness({ live: true, env: { AGENT_DB_PATH: path } });
      if (scenario.startsWith('recover')) priorSent(h, { partial: scenario.includes('partial') });
      h.ledger.close();
      crash(path, scenario);
      h = makeHarness({ live: true, env: { AGENT_DB_PATH: path } });
      const sw = h.ledger.getSwitch(1);
      assert.ok(['planned', 'executing'].includes(sw.status), `${scenario}: the killed transaction left the switch open, got ${sw.status}`);
      const rec = await h.engine.recoverPending();
      assert.ok(rec.halt, `${scenario}: the required halt is there after the restart`);
      const after = h.ledger.getSwitch(1);
      assert.equal(after.status, scenario.includes('partial') ? 'partial' : 'failed', scenario);
      assert.ok(after.halt_reason, `${scenario}: the requirement is recorded on the switch`);
      assert.equal(after.halt_acked_at, null);
      h.wait(21 * 60_000);
      await h.advance(6);
      assert.equal(h.chain.calls.sends.length, 0, `${scenario}: nothing is sent while halted`);
      assert.equal(rows(h, "SELECT id FROM costs WHERE kind = 'gas'").length, 1, `${scenario}: the paid leg is booked once`);
      h.ledger.close();
    }
    // negative control: a legitimate done needs no halt and stays done
    const path = join(dir, 'recover-done.db');
    let h = makeHarness({ live: true, env: { AGENT_DB_PATH: path } });
    priorSent(h); h.ledger.close();
    crash(path, 'recover-done');
    h = makeHarness({ live: true, env: { AGENT_DB_PATH: path } });
    const rec = await h.engine.recoverPending();
    assert.equal(rec.halt, null); assert.equal(h.ledger.getSwitch(1).status, 'done'); assert.equal(h.ledger.getSwitch(1).halt_reason, null);
    assert.equal(rows(h, "SELECT id FROM costs WHERE kind = 'gas'").length, 1);
    h.ledger.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R3-C4: a required halt recorded on a terminal switch is re-latched on every restart until the owner resets, and the reset acknowledges it', async () => {
  const h = makeHarness({ live: true, chainOptions: { receipt: 'revert' } });
  const out = await h.last(6);
  assert.equal(out.switched, false);
  const sw = h.ledger.getSwitch(1);
  assert.equal(sw.status, 'failed'); assert.match(sw.halt_reason, /reverted/u); assert.equal(sw.halt_acked_at, null);
  // simulate the lost global latch (the only thing a crash between the two writes could have cost before v2.4)
  h.ledger.kv.del('halt:live');
  assert.equal(h.ledger.stats(15).halt, null);
  const rec = await h.engine.recoverPending();
  assert.ok(rec.halt && /reverted/u.test(rec.halt.reason), 'restart re-derives the halt from the switch');
  h.ledger.resetHalt();
  assert.equal(h.ledger.stats(15).halt, null);
  assert.ok(h.ledger.getSwitch(1).halt_acked_at, 'the reset acknowledges the requirement');
  const again = await h.engine.recoverPending();
  assert.equal(again.halt, null, 'an acknowledged requirement does not come back');
  assert.equal(h.ledger.requiredHalts().length, 0);
});

test('R3-C4: a paid approval followed by a refused swap stays partial WITHOUT a halt on the normal path, and a restart does not invent one for an acknowledged or halt-free terminal switch', async () => {
  const g = makeHarness({ live: true, chainOptions: { balances: { eth: 0.002, weth: 0, usdc: 12 } }, summary: () => agreeingSummary('ETH'), trendUp: true });
  const est = g.chain.estimateTx;
  g.chain.estimateTx = async (tx, ...rest) => { const e = await est(tx, ...rest); return tx.data === '0xswap' ? { ...e, boundWei: 10n ** 15n, boundUsd: 3 } : e; };
  const o = await g.last(6);
  assert.equal(o.result.partial, true); assert.equal(g.ledger.getSwitch(1).status, 'partial'); assert.equal(g.ledger.getSwitch(1).halt_reason, null);
  assert.equal(g.ledger.stats(1).halt, null);
  const rec = await g.engine.recoverPending();
  assert.equal(rec.halt, null, 'a terminal partial without a recorded requirement is not latched on restart');
});

test('R3-C5: a replay of the same receipt keeps the first committed valuation; different facts for the same leg become a visible conflict, never a silent overwrite', async () => {
  const h = makeHarness({ live: true });
  const { leg } = priorSent(h);
  const facts = await h.chain.receiptFacts('0xprior', { tokenOut: USDC });
  const first = h.engine.settleLeg(h.ledger.getLeg(leg), facts, { price: 3000, priceAt: new Date(h.clock()).toISOString(), priceSource: 'test:first' });
  assert.equal(first.booked, true);
  h.wait(1000);
  const replay = h.engine.settleLeg(h.ledger.getLeg(leg), facts, { price: 3300, priceAt: new Date(h.clock()).toISOString(), priceSource: 'test:replay' });
  assert.equal(replay.replay, true); assert.equal(replay.conflict, false); assert.equal(replay.booked, false);
  const cost = rows(h, "SELECT usd, price_usd FROM costs WHERE kind = 'gas'"); const row = h.ledger.getLeg(leg); const spent = h.ledger.getSwitch(1).spent_usd;
  assert.equal(cost.length, 1); assert.equal(cost[0].price_usd, 3000); assert.equal(row.price_usd, 3000); assert.equal(row.price_source, 'test:first');
  assert.ok(near(cost[0].usd, spent) && near(cost[0].usd, row.gas_l2_usd + row.gas_l1_usd), 'cost, leg and spent agree');
  // conflicting facts
  const other = { ...facts, l2Wei: facts.l2Wei + 1n, totalWei: facts.totalWei + 1n };
  const conflict = h.engine.settleLeg(h.ledger.getLeg(leg), other, { price: 3300, priceAt: new Date(h.clock()).toISOString(), priceSource: 'test:conflict' });
  assert.equal(conflict.conflict, true);
  const after = h.ledger.getLeg(leg);
  assert.equal(after.accounting, 'conflict'); assert.match(after.error, /receipt facts differ/u);
  assert.equal(after.gas_l2_wei, String(facts.l2Wei), 'the settled facts are not overwritten'); assert.equal(after.price_usd, 3000);
  assert.equal(rows(h, "SELECT id FROM costs WHERE kind = 'gas'").length, 1);
  assert.ok(near(h.ledger.getSwitch(1).spent_usd, spent));
  const again = h.engine.settleLeg(h.ledger.getLeg(leg), facts, { price: 3400, priceAt: new Date(h.clock()).toISOString(), priceSource: 'test:after-conflict' });
  assert.equal(again.conflict, true, 'a conflict is not cleared by a later matching replay; a human resolves it');
});

test('R3: the release label matches the schema and README', async () => {
  const { AGENT_VERSION } = await import('./config.mjs');
  const { SCHEMA_VERSION } = await import('./ledger.mjs');
  assert.equal(AGENT_VERSION, '2.16.0'); assert.equal(SCHEMA_VERSION, 6); // v2.7: durable inference and timed-session evidence tables
});
