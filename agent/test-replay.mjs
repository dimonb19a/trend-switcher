// The replay harness: availability of history, the hidden date, the cost scenario and the
// next-minute-open fill, the midnight rule, and one engine run over a synthetic month-of-minutes
// with a fake judge. Fakes only: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEther, formatUnits, parseUnits } from 'ethers';
import { canonicalize, gapsOf } from './history-fetch.mjs';
import { ReplayFeed, MINUTE_MS, CANDLE_MS } from './replay-feed.mjs';
import { createReplayChain, impactBpsFor, IMPACT_TABLE_BPS } from './replay-chain.mjs';
import { renderStateHiddenDate, HIDDEN_TIME_LINE } from './replay-judge.mjs';
import { computeFeatures, renderState } from './features.mjs';
import { liftDailyLatchAtMidnight, runReplay } from './replay.mjs';
import { openLedger } from './ledger.mjs';
import { agreeingSummary, fakeJudge, flatSummary, makeCfg, USDC, WETH } from './test-helpers.mjs';

const T0 = Date.parse('2021-05-01T00:00:00Z');

/** Synthetic minutes from a price function; five-minute candles aggregated from them. */
function synthetic({ fromMs, hours, price, skipMinutes = new Set() }) {
  const minutes = [];
  for (let t = fromMs; t < fromMs + hours * 3600_000; t += MINUTE_MS) {
    if (skipMinutes.has(t)) continue;
    const o = price(t); const c = price(t + MINUTE_MS - 1) * 1.0005; // the close sits visibly above the open, so a fill at the next open is never the decision's close
    minutes.push({ t, open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c, volume: 10 });
  }
  const fives = [];
  for (let t = fromMs; t < fromMs + hours * 3600_000; t += CANDLE_MS) {
    const members = minutes.filter((m) => m.t >= t && m.t < t + CANDLE_MS);
    if (!members.length) continue;
    fives.push({ t, open: members[0].open, high: Math.max(...members.map((m) => m.high)), low: Math.min(...members.map((m) => m.low)), close: members[members.length - 1].close, volume: members.reduce((s, m) => s + m.volume, 0) });
  }
  return { minutes, fives };
}

test('history: canonicalize rejects misaligned and conflicting rows, deduplicates identical ones, and gapsOf names the holes', () => {
  const rows = [{ t: 60_000, open: 1, high: 2, low: 1, close: 2, volume: 1 }, { t: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }, { t: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }, { t: 240_000, open: 2, high: 2, low: 2, close: 2, volume: 1 }];
  const out = canonicalize(rows, MINUTE_MS);
  assert.deepEqual(out.map((r) => r.t), [0, 60_000, 240_000]);
  assert.deepEqual(gapsOf(out, MINUTE_MS), [{ from: '1970-01-01T00:02:00.000Z', to: '1970-01-01T00:04:00.000Z', missing: 2 }]);
  assert.throws(() => canonicalize([{ t: 30_000, open: 1, high: 1, low: 1, close: 1, volume: 0 }], MINUTE_MS), /aligned/u);
  assert.throws(() => canonicalize([{ t: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }, { t: 0, open: 1, high: 2, low: 1, close: 2, volume: 0 }], MINUTE_MS), /conflicting/u);
  assert.throws(() => canonicalize([{ t: 0, open: 3, high: 2, low: 1, close: 1, volume: 0 }], MINUTE_MS), /bound/u);
});

test('replay feed: a minute is observable only once it has closed; a five-minute candle only once its bucket has closed', () => {
  const { minutes, fives } = synthetic({ fromMs: T0, hours: 2, price: (t) => 3000 + (t - T0) / MINUTE_MS });
  const feed = new ReplayFeed({ minutes, fiveMinutes: fives });
  feed.advanceTo(T0 + MINUTE_MS - 1);
  assert.equal(feed.snapshot().last, null, 'nothing before the first minute closes');
  feed.advanceTo(T0 + MINUTE_MS);
  let snap = feed.snapshot();
  assert.equal(snap.ticks.length, 1); assert.equal(snap.last.t, T0 + MINUTE_MS); assert.equal(snap.last.p, minutes[0].close);
  assert.equal(snap.candles.length, 0, 'the first five-minute bucket has not closed');
  feed.advanceTo(T0 + CANDLE_MS);
  snap = feed.snapshot();
  assert.equal(snap.candles.length, 1); assert.equal(snap.candles[0].t, T0); assert.equal(snap.ticks.length, 5);
  assert.equal(snap.eventAgeMs, 0); assert.equal(snap.candlesEventAgeMs, 0); assert.equal(snap.synthetic, true);
  assert.throws(() => feed.advanceTo(T0), /backwards/u);
});

test('replay feed: a missing minute is a gap in the tape; a missing five-minute bucket is filled flat, marked and counted', () => {
  const skip = new Set([T0 + 10 * MINUTE_MS, T0 + 20 * MINUTE_MS, T0 + 21 * MINUTE_MS, T0 + 22 * MINUTE_MS, T0 + 23 * MINUTE_MS, T0 + 24 * MINUTE_MS]);
  const { minutes, fives } = synthetic({ fromMs: T0, hours: 1, price: () => 3000, skipMinutes: skip });
  assert.equal(fives.find((c) => c.t === T0 + 20 * MINUTE_MS), undefined, 'the whole bucket 20–25 is absent from the history');
  const feed = new ReplayFeed({ minutes, fiveMinutes: fives });
  feed.advanceTo(T0 + 60 * MINUTE_MS);
  const snap = feed.snapshot();
  assert.equal(snap.gaps.length, 2);
  assert.equal(feed.missingMinutes, 6);
  assert.equal(snap.candlesContiguous, true);
  const filled = snap.candles.find((c) => c.t === T0 + 20 * MINUTE_MS);
  assert.equal(filled.synthetic, true); assert.equal(filled.volume, 0); assert.equal(snap.syntheticCandles, 1);
});

test('features on a replay snapshot: trade activity and spread unknown, data not degraded after the warm-up, EMA/range present', () => {
  const { minutes, fives } = synthetic({ fromMs: T0, hours: 27, price: (t) => 3000 + 50 * Math.sin((t - T0) / 3600_000) });
  const feed = new ReplayFeed({ minutes, fiveMinutes: fives });
  const now = T0 + 26 * 3600_000;
  feed.advanceTo(now);
  const f = computeFeatures(feed.snapshot(now), null, now);
  assert.equal(f.tickRate, null); assert.equal(f.spreadBps, null);
  assert.equal(f.dataQuality.degraded, false, JSON.stringify(f.dataQuality));
  assert.ok(Number.isFinite(f.ema20) && Number.isFinite(f.ema50) && Number.isFinite(f.ret24h) && Number.isFinite(f.vol24h));
  assert.ok(f.range2h && Number.isFinite(f.range2h.high));
  const text = renderState(f, { side: 'ETH', ethPct: 100, lastSwitchMinutes: null, switchesToday: 0, maxSwitchesPerDay: 6 });
  assert.match(text, /Trade activity: unavailable trades per minute/u);
});

test('the hidden-date state: the same text as live with only the time line replaced; no calendar date reaches the models', () => {
  const { minutes, fives } = synthetic({ fromMs: T0, hours: 27, price: () => 3000 });
  const feed = new ReplayFeed({ minutes, fiveMinutes: fives });
  const now = T0 + 26 * 3600_000; feed.advanceTo(now);
  const f = computeFeatures(feed.snapshot(now), null, now);
  const position = { side: 'ETH', ethPct: 100, lastSwitchMinutes: null, switchesToday: 0, maxSwitchesPerDay: 6 };
  const live = renderState(f, position); const hidden = renderStateHiddenDate(f, position);
  assert.match(live, /Time \(UTC\): 2021-05-02 02:00:00\./u);
  assert.ok(hidden.includes(HIDDEN_TIME_LINE));
  assert.doesNotMatch(hidden, /\d{4}-\d{2}-\d{2}/u);
  assert.equal(hidden.replace(HIDDEN_TIME_LINE, 'Time (UTC): 2021-05-02 02:00:00.'), live);
});

test('cost scenario: impact by notional between the probed sizes, clamped outside', () => {
  assert.equal(impactBpsFor(500), IMPACT_TABLE_BPS[0][1]);
  assert.equal(impactBpsFor(1_000), 0.15); assert.equal(impactBpsFor(10_000), 1.3); assert.equal(impactBpsFor(100_000), 12.8); assert.equal(impactBpsFor(1_000_000), 133);
  const mid = impactBpsFor(Math.sqrt(10_000 * 100_000)); assert.ok(mid > 1.3 && mid < 12.8 && Math.abs(mid - (1.3 + 12.8) / 2) < 1e-9, `${mid}`);
  assert.equal(impactBpsFor(5_000_000), 133);
});

test('replay chain: the fill is the open of the minute that starts at the decision instant, times fee and impact; a missing minute is a pre-effect quote failure', async () => {
  const cfg = makeCfg({ PAPER_CAPITAL_USD: '1000' });
  const minutes = [{ t: T0, open: 3000, high: 3010, low: 2990, close: 3005, volume: 1 }, { t: T0 + MINUTE_MS, open: 3100, high: 3110, low: 3090, close: 3105, volume: 1 }];
  let now = T0 + MINUTE_MS; // the decision sees the close 3005 of the first minute; the fill is the next minute's open 3100
  const chain = createReplayChain({ minutes, clock: () => now, cfg });
  const sell = await chain.quote(WETH, USDC, parseUnits('0.5', 18));
  const notional = 0.5 * 3100; const w = 0.0005 + impactBpsFor(notional) / 10_000;
  assert.equal(sell.fillPrice, 3100);
  assert.ok(Math.abs(Number(formatUnits(sell.amountOut, 6)) - 0.5 * 3100 * (1 - w)) < 1e-6);
  const buy = await chain.quote(USDC, WETH, parseUnits('1000', 6));
  const wb = 0.0005 + impactBpsFor(1000) / 10_000;
  assert.ok(Math.abs(Number(formatEther(buy.amountOut)) - 1000 / (3100 * (1 + wb))) < 1e-12);
  const picture = await chain.costPicture({ ethSide: 0.5, usdc: 0, midPrice: 3005 });
  assert.ok(Math.abs(picture.costPct - (0.05 + impactBpsFor(0.5 * 3005) / 100 + cfg.expectedSlippageBps / 100)) < 1e-12);
  assert.equal(picture.at, now);
  now = T0 + 2 * MINUTE_MS; // no minute starts here
  await assert.rejects(chain.quote(WETH, USDC, parseUnits('0.5', 18)), (error) => error.code === 'QUOTE_UNAVAILABLE' && error.preEffect === true && error.transient === true);
  assert.equal(chain.address(), null);
  assert.deepEqual(await chain.balances(), { ethRaw: 0n, wethRaw: 0n, usdcRaw: 0n, eth: 0, weth: 0, usdc: 0 });
});

test('midnight rule: a daily-loss latch is lifted, a kill latch, a switch-level halt and an UNKNOWN-bill latch are not', () => {
  const cfg = makeCfg({ PAPER_CAPITAL_USD: '1000' });
  let now = T0; const clock = () => now;
  const ledger = openLedger(cfg, { clock });
  ledger.latchHalt('risk (tick): daily net loss -3.20% beyond the daily limit 3%');
  assert.equal(liftDailyLatchAtMidnight(ledger), true); assert.equal(ledger.kv.get('halt:paper'), null);
  ledger.latchHalt('risk (tick): total net loss -31.00% beyond the kill limit 30%');
  assert.equal(liftDailyLatchAtMidnight(ledger), false); assert.ok(ledger.kv.get('halt:paper'));
  ledger.resetHalt();
  ledger.latchHalt('inference 7 (judge) billing UNKNOWN; reconcile before another run');
  assert.equal(liftDailyLatchAtMidnight(ledger), false);
  ledger.resetHalt();
  const id = ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'test', notionalUsd: 100 });
  ledger.closeSwitch(id, { status: 'unknown', reason: 'test', halt: `switch ${id}: outcome unknown` });
  ledger.latchHalt('risk (tick): daily net loss -3.20% beyond the daily limit 3%'); // a second latch is ignored while one stands, so the switch halt is the one that stands
  assert.equal(liftDailyLatchAtMidnight(ledger), false, 'a required switch-level halt is never lifted by the calendar');
  ledger.close();
});

test('one replay end to end with a fake judge: the agreeing run sells at the next minute open after the decision, hold and the arm are reported, the manifest is written', async () => {
  const cfg = makeCfg({ PAPER_CAPITAL_USD: '1000', TICK_MS: '60000', REQUIRE_DEEPSEEK: 'false', RISK_PRESET: 'trend' });
  const hours = 27;
  // flat for the warm-up, then a steady fall: the EMA20 drops below the EMA50 and the fake judge votes USDC on every tick
  const price = (t) => (t < T0 + 26 * 3600_000 ? 3000 : 3000 - 0.5 * ((t - (T0 + 26 * 3600_000)) / MINUTE_MS));
  const { minutes, fives } = synthetic({ fromMs: T0, hours, price });
  let votes = 0;
  const judge = fakeJudge(() => (votes++ < 2 ? flatSummary() : agreeingSummary('USDC')));
  const fromMs = T0 + 26 * 3600_000; const toMs = fromMs + 40 * MINUTE_MS;
  const ticks = [];
  const { manifest, ledger } = await runReplay({ cfg, minutes, fiveMinutes: fives, fromMs, toMs, warmupMs: 26 * 3600_000, judge, judgeEnabled: true, keepLedgerOpen: true, onTick: (x) => ticks.push(x) });
  try {
    assert.equal(manifest.status, 'completed'); assert.equal(manifest.completedSlots, 40); assert.equal(ticks.length, 40);
    const sw = ledger.db.prepare('SELECT * FROM switches ORDER BY id').all();
    assert.ok(sw.length >= 1, 'the agreeing run produced a switch');
    assert.equal(sw[0].status, 'done'); assert.equal(sw[0].to_side, 'USDC');
    const leg = ledger.db.prepare('SELECT * FROM legs WHERE switch_id = ?').get(sw[0].id);
    const decidedAt = Date.parse(sw[0].ts);
    const nextOpen = minutes.find((m) => m.t === decidedAt).open; // the minute that STARTS at the decision instant
    const closeBefore = minutes.find((m) => m.t === decidedAt - MINUTE_MS).close; // what the decision saw
    const w = 0.0005 + impactBpsFor(leg.amount_in * nextOpen) / 10_000;
    const expectedOut = leg.amount_in * nextOpen * (1 - w) * (1 - cfg.expectedSlippageBps / 10_000);
    assert.ok(Math.abs(leg.amount_out_actual - expectedOut) < 1e-6, `${leg.amount_out_actual} vs ${expectedOut}`);
    assert.ok(Math.abs(leg.price_usd - closeBefore) < 1e-9 && leg.price_usd !== nextOpen, 'the decision was valued at the tape close, the fill at the next open');
    const session = ledger.kv.get('session:paper');
    assert.equal(session.replay.kind, 'historical replay'); assert.equal(session.replay.dailyLatchLifts, 0); assert.equal(session.status, 'completed');
    const states = ledger.db.prepare('SELECT state FROM judgments').all().map((r) => r.state);
    assert.ok(states.length === 40 && states.every((s) => s.includes(HIDDEN_TIME_LINE) && !/\d{4}-\d{2}-\d{2}/u.test(s)), 'every judged state hides the date');
    const valuations = ledger.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE kind = 'valuation'").get().n;
    assert.ok(valuations >= 40, 'a valuation per tick plus the session end');
  } finally { ledger.close(); }
});
