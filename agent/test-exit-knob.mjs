// RISK_LATCH_BLOCKS_EXITS: by default a latched loss limit halts every switch; with the knob off it halts only
// switches into ETH, and the risk-reducing switch into USDC stays allowed. Any other halt blocks both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limits } from './policy.mjs';
import { computeFeatures } from './features.mjs';
import { T0, agreeingSummary, makeCfg, makeHarness, makeSnapshot } from './test-helpers.mjs';

const features = computeFeatures(makeSnapshot({ now: T0 }), { at: T0, costPct: 0.07, impactBps: 0, expectedSlippagePct: 0.02, tolerancePct: 0.5 }, T0);
const stats = (over = {}) => ({ switchesToday: 0, lastSwitchAt: null, dailyNetPnlPct: 0, totalNetPnlPct: 0, inferenceTodayUsd: 0, inferenceUnknownReserveUsd: 0, inferenceBudgetCommittedUsd: 0, halt: null, pendingSwitches: 0, ...over });
const args = (target, st) => ({ now: T0, features, position: { lastSwitchAt: null }, stats: st, notionalUsd: 50, target });

test('default: a latched daily loss halts switches in both directions', () => {
  const cfg = makeCfg({});
  const st = stats({ halt: { reason: 'risk (tick): daily net loss -3.2% beyond the daily limit 3%', at: 'x' }, dailyNetPnlPct: -3.2 });
  assert.equal(limits(args('USDC', st), cfg).ok, false);
  assert.equal(limits(args('ETH', st), cfg).ok, false);
});

test('knob off: a latched daily or total loss halts only the switch into ETH; the switch into USDC stays allowed', () => {
  const cfg = makeCfg({ RISK_LATCH_BLOCKS_EXITS: 'false' });
  assert.equal(cfg.riskLatchBlocksExits, false);
  const daily = stats({ halt: { reason: 'risk (tick): daily net loss -3.2% beyond the daily limit 3%', at: 'x' }, dailyNetPnlPct: -3.2 });
  assert.equal(limits(args('USDC', daily), cfg).ok, true, JSON.stringify(limits(args('USDC', daily), cfg)));
  assert.equal(limits(args('ETH', daily), cfg).ok, false);
  const total = stats({ halt: { reason: 'risk (tick): total net loss -31.0% beyond the kill limit 30%', at: 'x' }, totalNetPnlPct: -31 });
  assert.equal(limits(args('USDC', total), cfg).ok, true);
  assert.equal(limits(args('ETH', total), cfg).ok, false);
  // a loss beyond the limit that is not latched yet (seen in the stats only) follows the same rule
  const seen = stats({ dailyNetPnlPct: -4 });
  assert.equal(limits(args('USDC', seen), cfg).ok, true);
  assert.equal(limits(args('ETH', seen), cfg).ok, false);
});

test('knob off: a halt that is not a loss latch blocks both directions; a missing target gets the strict rule', () => {
  const cfg = makeCfg({ RISK_LATCH_BLOCKS_EXITS: 'false' });
  const unknown = stats({ halt: { reason: 'switch 3: outcome unknown', at: 'x' } });
  assert.equal(limits(args('USDC', unknown), cfg).ok, false);
  const bill = stats({ halt: { reason: 'inference 9 (judge) billing UNKNOWN; reconcile before another run', at: 'x' } });
  assert.equal(limits(args('USDC', bill), cfg).ok, false);
  const risk = stats({ halt: { reason: 'risk (tick): daily net loss -3.2% beyond the daily limit 3%', at: 'x' } });
  assert.equal(limits({ ...args('USDC', risk), target: null }, cfg).ok, false, 'no target named → every halt blocks');
});

test('engine: with the knob off an agreeing USDC run executes under a latched daily loss; by default it is blocked', async () => {
  for (const [knob, expectSwitch] of [['false', true], ['true', false]]) {
    const h = makeHarness({ env: { RISK_LATCH_BLOCKS_EXITS: knob, REQUIRE_DEEPSEEK: 'false' }, summary: () => agreeingSummary('USDC') });
    await h.advance(1); // opens the paper balances and the initial reference
    h.ledger.latchHalt('risk (tick): daily net loss -3.5% beyond the daily limit 3%');
    const outs = await h.advance(6);
    const switched = outs.some((o) => o?.switched === true);
    assert.equal(switched, expectSwitch, `knob ${knob}: ${JSON.stringify(outs[outs.length - 1])}`);
    if (!expectSwitch) assert.ok(outs.some((o) => o?.blocked?.some((p) => p.startsWith('halted'))), 'blocked by the halt');
    h.ledger.close();
  }
});
