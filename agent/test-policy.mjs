// Unit tests for the pure decision logic: AGENT_TEST=1 node --test agent/test-policy.mjs
// No network, no keys, no ledger. Non-finite inputs must veto (TR-09); votes carry time (TR-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoteWindow, agreesWith, limits, trendFilter } from './policy.mjs';
import { T0, agreeingSummary, flatSummary, makeCfg } from './test-helpers.mjs';

// These tests state the forecast basis (the rule of the first sessions); the regime basis is covered in test-presets.mjs.
const cfg = makeCfg({ RISK_PRESET: 'forecast' });
const up = (over = {}) => ({ ...agreeingSummary('ETH'), ...over });
const down = (over = {}) => ({ ...agreeingSummary('USDC'), ...over });

test('a judgment agrees with a switch only when regime, direction, quality and risk all line up', () => {
  assert.equal(agreesWith(up(), 'ETH', cfg), true);
  assert.equal(agreesWith(up(), 'USDC', cfg), false);
  assert.equal(agreesWith(down(), 'USDC', cfg), true);
  assert.equal(agreesWith(up({ directionP: cfg.minDirectionP - 0.01 }), 'ETH', cfg), false, 'direction probability below the floor');
  assert.equal(agreesWith(up({ quality: 'marginal' }), 'ETH', cfg), false, 'marginal quality never counts');
  assert.equal(agreesWith(up({ riskOffP: cfg.maxRiskOffP + 0.01 }), 'ETH', cfg), false, 'risk-off above the ceiling');
  assert.equal(agreesWith(up({ regime: 'range' }), 'ETH', cfg), false, 'no switch without a trend regime');
  assert.equal(agreesWith(flatSummary(), 'ETH', cfg), false);
  assert.equal(agreesWith(up({ directionP: NaN }), 'ETH', cfg), false, 'NaN probability never agrees');
  assert.equal(agreesWith(up({ riskOffP: undefined }), 'ETH', cfg), false, 'missing risk never agrees');
});

test('the vote window needs a full, recent, gap-free window with at least voteMin agreeing judgments', () => {
  const w = new VoteWindow(cfg);
  for (let i = 0; i < cfg.voteWindow - 1; i += 1) w.push(down(), T0 + i * cfg.tickMs);
  assert.equal(w.candidate({ side: 'ETH' }, T0 + (cfg.voteWindow - 1) * cfg.tickMs).target, null, 'window not full yet');
  w.push(down(), T0 + (cfg.voteWindow - 1) * cfg.tickMs);
  const now = T0 + cfg.voteWindow * cfg.tickMs;
  assert.equal(w.candidate({ side: 'ETH' }, now).target, 'USDC', 'full window of agreeing judgments');
  assert.equal(w.candidate({ side: 'USDC' }, now).target, null, 'already in the target asset');
  assert.equal(w.candidate({ side: 'ETH' }, now + cfg.voteMaxSpanMs).target, null, 'votes too old after a wait');
  assert.equal(w.candidate({ side: 'ETH' }, NaN).target, null, 'no clock, no candidate');
  const w2 = new VoteWindow(cfg);
  for (let i = 0; i < cfg.voteWindow; i += 1) w2.push(i < cfg.voteMin - 1 ? down() : flatSummary(), T0 + i * cfg.tickMs);
  assert.equal(w2.candidate({ side: 'ETH' }, T0 + cfg.voteWindow * cfg.tickMs).target, null, 'one vote short');
  const w3 = new VoteWindow(cfg);
  for (let i = 0; i < cfg.voteWindow; i += 1) w3.push(down(), T0 + i * cfg.tickMs + (i === 3 ? 3 * cfg.tickMs : 0));
  assert.equal(w3.candidate({ side: 'ETH' }, T0 + cfg.voteWindow * cfg.tickMs + 3 * cfg.tickMs).target, null, 'a gap between judgments breaks the run');
  assert.throws(() => w3.push(down(), undefined), /timestamp/u);
});

test('an outage clears the window: a fresh full run is required afterwards', () => {
  const w = new VoteWindow(cfg);
  for (let i = 0; i < cfg.voteWindow; i += 1) w.push(up(), T0 + i * cfg.tickMs);
  assert.equal(w.candidate({ side: 'USDC' }, T0 + cfg.voteWindow * cfg.tickMs).target, 'ETH');
  w.clear();
  w.push(up(), T0);
  assert.equal(w.candidate({ side: 'USDC' }, T0 + cfg.tickMs).target, null);
});

test('the trend filter follows EMA20 against EMA50 and refuses unknowns', () => {
  assert.equal(trendFilter({ emaSpreadPct: 0.2 }, 'ETH').ok, true);
  assert.equal(trendFilter({ emaSpreadPct: -0.2 }, 'ETH').ok, false);
  assert.equal(trendFilter({ emaSpreadPct: -0.2 }, 'USDC').ok, true);
  assert.equal(trendFilter({ emaSpreadPct: 0.2 }, 'USDC').ok, false);
  assert.equal(trendFilter({ emaSpreadPct: null }, 'USDC').ok, false);
  assert.equal(trendFilter({ emaSpreadPct: NaN }, 'ETH').ok, false, 'NaN spread refuses');
  assert.equal(trendFilter({}, 'USDC').ok, false, 'missing spread refuses');
  assert.equal(trendFilter(undefined, 'ETH').ok, false);
});

const base = () => ({
  now: T0,
  features: { tapeEventAgeSec: 2, candlesEventAgeSec: 60, dataQuality: { degraded: false, reasons: [] } },
  position: { lastSwitchAt: null },
  stats: { halt: null, pendingSwitches: 0, totalNetPnlPct: 0, dailyNetPnlPct: 0, inferenceTodayUsd: 0, switchesToday: 0 },
  notionalUsd: 11,
});

test('hard limits veto stale tape, degraded data, losses, budget, halt, pending, hold, count and notional bounds', () => {
  assert.equal(limits(base(), cfg).ok, true, 'baseline passes');
  const withFeatures = (f) => ({ ...base(), features: { ...base().features, ...f } });
  const withStats = (s) => ({ ...base(), stats: { ...base().stats, ...s } });
  assert.equal(limits(withFeatures({ tapeEventAgeSec: cfg.maxDataAgeSec + 1 }), cfg).ok, false, 'stale tape');
  assert.equal(limits(withFeatures({ candlesEventAgeSec: cfg.maxCandleAgeSec + 1 }), cfg).ok, false, 'stale candles');
  assert.equal(limits(withFeatures({ dataQuality: { degraded: true, reasons: ['gap'] } }), cfg).ok, false, 'degraded data');
  assert.equal(limits(withStats({ dailyNetPnlPct: -cfg.maxDailyLossPct }), cfg).ok, false, 'daily net loss stop');
  assert.equal(limits(withStats({ totalNetPnlPct: -cfg.killLossPct }), cfg).ok, false, 'kill loss');
  assert.equal(limits(withStats({ halt: { reason: 'manual' } }), cfg).ok, false, 'latched halt');
  assert.equal(limits(withStats({ pendingSwitches: 1 }), cfg).ok, false, 'pending switch');
  assert.equal(limits(withStats({ inferenceTodayUsd: cfg.inferenceBudgetUsdPerDay }), cfg).ok, false, 'inference budget');
  assert.equal(limits(withStats({ switchesToday: cfg.maxSwitchesPerDay }), cfg).ok, false, 'daily switch count');
  assert.equal(limits({ ...base(), position: { lastSwitchAt: T0 - (cfg.minHoldMinutes - 1) * 60_000 } }, cfg).ok, false, 'minimum hold');
  assert.equal(limits({ ...base(), position: { lastSwitchAt: T0 - (cfg.minHoldMinutes + 1) * 60_000 } }, cfg).ok, true, 'hold satisfied');
  assert.equal(limits({ ...base(), notionalUsd: cfg.minNotionalUsd - 0.01 }, cfg).ok, false, 'notional too small');
  assert.equal(limits({ ...base(), notionalUsd: cfg.maxCapitalUsd + 0.01 }, cfg).ok, false, 'notional above the pilot cap');
});

test('non-finite or missing safety inputs veto instead of passing (TR-09)', () => {
  assert.equal(limits({ now: T0, features: { tapeEventAgeSec: NaN, candlesEventAgeSec: undefined }, position: {}, stats: {}, notionalUsd: NaN }, cfg).ok, false);
  assert.equal(limits({ ...base(), notionalUsd: undefined }, cfg).ok, false);
  assert.equal(limits({ ...base(), now: NaN }, cfg).ok, false);
  assert.equal(limits({ ...base(), stats: { ...base().stats, switchesToday: undefined } }, cfg).ok, false);
});

test('the pilot cap cannot exceed 100 dollars', () => {
  assert.ok(cfg.maxCapitalUsd <= 100);
});

// ---- breakout condition (experiment 1, 2026-10-02): new information, not another vote ----
import { breakoutFilter } from './policy.mjs';
import { computeFeatures } from './features.mjs';
import { makeSnapshot } from './test-helpers.mjs';

test('the breakout condition is off by default and, when on, vetoes a switch inside the lookback range and passes one beyond it by the bar', () => {
  const off = makeCfg({ RISK_PRESET: 'trend' });
  const range = { minutes: 120, high: 3100, low: 3000, candles: 24 };
  assert.deepEqual(breakoutFilter({ price: 3050, range2h: range }, 'USDC', off), { ok: true, skipped: true });
  const on = makeCfg({ RISK_PRESET: 'trend', BREAKOUT_MIN_PCT: '0.9', BREAKOUT_LOOKBACK_MIN: '120' });
  assert.equal(on.breakoutMinPct, 0.9); assert.equal(on.breakoutLookbackMin, 120);
  assert.equal(breakoutFilter({ price: 3050, range2h: range }, 'USDC', on).ok, false, 'inside the range');
  assert.equal(breakoutFilter({ price: 2980, range2h: range }, 'USDC', on).ok, false, 'below the low but not by the bar');
  assert.equal(breakoutFilter({ price: 3000 * (1 - 0.009) - 0.01, range2h: range }, 'USDC', on).ok, true, 'below the low by more than 0.9 %');
  assert.equal(breakoutFilter({ price: 3120, range2h: range }, 'ETH', on).ok, false, 'above the high but not by the bar');
  assert.equal(breakoutFilter({ price: 3100 * 1.009 + 0.01, range2h: range }, 'ETH', on).ok, true, 'above the high by more than 0.9 %');
  assert.equal(breakoutFilter({ price: 2900, range2h: null }, 'USDC', on).ok, false, 'a missing range vetoes');
  assert.equal(breakoutFilter({ price: NaN, range2h: range }, 'USDC', on).ok, false, 'a non-finite price vetoes');
  assert.equal(breakoutFilter({ price: 2900, range2h: range }, 'XYZ', on).ok, false, 'an unknown target vetoes');
  const four = makeCfg({ RISK_PRESET: 'trend', BREAKOUT_MIN_PCT: '0.9', BREAKOUT_LOOKBACK_MIN: '240' });
  assert.equal(breakoutFilter({ price: 2900, range2h: range, range4h: null }, 'USDC', four).ok, false, 'the lookback picks its own range');
  assert.throws(() => makeCfg({ BREAKOUT_LOOKBACK_MIN: '90' }), /BREAKOUT_LOOKBACK_MIN/u);
});

test('the features expose the closed-candle ranges of the last 1, 2 and 4 hours and leave the forming candle out', () => {
  const now = T0 + 120_000; // two minutes into a candle
  const f = computeFeatures(makeSnapshot({ now, price: 3000, trendUp: true, candleCount: 300 }), null, now);
  for (const key of ['range1h', 'range2h', 'range4h']) {
    assert.ok(f[key], key); assert.ok(f[key].high > f[key].low); assert.ok(f[key].candles >= (f[key].minutes / 5) * 0.8, `${key} populated`);
  }
  assert.equal(f.range1h.candles <= 12, true); assert.equal(f.range2h.candles <= 24, true);
  assert.ok(f.range2h.high - f.range2h.low >= f.range1h.high - f.range1h.low, 'a longer window spans at least as much');
  const stale = computeFeatures(makeSnapshot({ now, price: 3000, candleCount: 5 }), null, now);
  assert.equal(stale.range2h, null, 'too few closed candles: no range');
});
