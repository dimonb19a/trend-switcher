// Data honesty tests (TR-06): AGENT_TEST=1 node --test agent/test-feed-features.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from './feed.mjs';
import { computeFeatures, covered } from './features.mjs';
import { T0, makeSnapshot } from './test-helpers.mjs';

const clockAt = (t) => () => t;

test('a two-hour-old ticker is reported two hours old, not fresh', () => {
  const now = T0;
  const f = new Feed({ clock: clockAt(now) });
  assert.equal(f.onMessage({ type: 'ticker', product_id: 'ETH-USD', price: '100', time: new Date(now - 7_200_000).toISOString() }), true);
  const s = f.snapshot(now);
  assert.ok(s.eventAgeMs >= 7_200_000, `event age ${s.eventAgeMs}`);
  assert.equal(computeFeatures(s, null, now), null, 'no features from a stale tape');
});

test('ticker messages for another product, with bad numbers, from the future or out of sequence are rejected', () => {
  const now = T0;
  const f = new Feed({ clock: clockAt(now) });
  assert.equal(f.onMessage({ type: 'ticker', product_id: 'BTC-USD', price: '100', time: new Date(now).toISOString() }), false);
  assert.equal(f.onMessage({ type: 'ticker', product_id: 'ETH-USD', price: 'abc', time: new Date(now).toISOString() }), false);
  assert.equal(f.onMessage({ type: 'ticker', product_id: 'ETH-USD', price: '100', time: new Date(now + 60_000).toISOString() }), false, 'future timestamp');
  assert.equal(f.onMessage({ type: 'ticker', product_id: 'ETH-USD', price: '100', time: new Date(now).toISOString(), sequence: 10 }), true);
  assert.equal(f.onMessage({ type: 'ticker', product_id: 'ETH-USD', price: '101', time: new Date(now).toISOString(), sequence: 9 }), false, 'sequence regression');
  assert.deepEqual(Object.values(f.snapshot(now).rejected).reduce((a, b) => a + b, 0), 4);
});

test('fetching old candles does not make them fresh: stale sets are refused and freshness follows the market clock', async () => {
  const now = T0;
  const old = Array.from({ length: 60 }, (_, i) => [Math.floor((now - 3 * 86_400_000) / 1000) + i * 300, 99, 101, 100, 100, 1]);
  const f = new Feed({ clock: clockAt(now) });
  globalThis.fetch = async () => ({ ok: true, json: async () => old });
  await assert.rejects(() => f.refreshCandles(), /old|HTTP|few/u);
  assert.equal(f.candles.length, 0, 'stale candles were not accepted');
  const fresh = Array.from({ length: 80 }, (_, i) => [Math.floor((now - 80 * 300_000) / 1000) + i * 300, 99, 101, 100, 100, 1]);
  globalThis.fetch = async () => ({ ok: true, json: async () => fresh });
  await f.refreshCandles();
  const s = f.snapshot(now);
  assert.ok(s.candles.length >= 60);
  assert.ok(s.candlesEventAgeMs >= 0 && s.candlesEventAgeMs < 600_000, `candle event age ${s.candlesEventAgeMs}`);
  assert.equal(s.candlesContiguous, true);
  const later = f.snapshot(now + 3 * 3600_000);
  assert.ok(later.candlesEventAgeMs >= 3 * 3600_000, 'age grows with the clock, not with fetch time');
});

test('a 65-minute hole in the tape yields unavailable returns and volatility, never zero', () => {
  const now = T0;
  const ticks = [{ t: now - 65 * 60_000, rt: now - 65 * 60_000, p: 3000, bid: null, ask: null, size: 1 }, { t: now, rt: now, p: 3000, bid: null, ask: null, size: 1 }];
  const gaps = [{ from: ticks[0].t, to: now, reason: 'silence' }];
  // without candles nothing bridges the hole: every horizon is unavailable
  const bare = { ...makeSnapshot({ now }), ticks, last: ticks[1], gaps, candles: [], candlesContiguous: false, candlesEventAgeMs: Infinity, candlesSource: null };
  const f = computeFeatures(bare, null, now);
  for (const k of ['ret1m', 'ret5m', 'ret15m', 'ret1h', 'vol15m', 'vol1h', 'ema20']) assert.equal(f[k], null, `${k} must be unavailable, got ${f[k]}`);
  assert.equal(f.dataQuality.degraded, true);
  assert.equal(covered(bare, now - 3600_000, now), false);
  // with contiguous closed candles the multi-candle horizons come from the candles (a complete source), the tape horizons stay unavailable
  const g = computeFeatures({ ...makeSnapshot({ now }), ticks, last: ticks[1], gaps }, null, now);
  assert.equal(g.ret1m, null); assert.equal(g.ret5m, null); assert.equal(g.vol15m, null);
  assert.ok(Number.isFinite(g.ret1h), 'the 1h return may come from closed candles');
  assert.equal(g.dataQuality.degraded, true, 'a short tape coverage is still flagged');
});

test('a continuous tape and contiguous candles give every horizon and a good data quality', () => {
  const now = T0;
  const f = computeFeatures(makeSnapshot({ now, trendUp: true }), null, now);
  for (const k of ['ret1m', 'ret5m', 'ret15m', 'ret1h', 'ret4h', 'ret24h', 'vol15m', 'vol1h', 'vol24h', 'ema20', 'ema50', 'emaSpreadPct', 'rangePos']) assert.ok(Number.isFinite(f[k]), `${k} = ${f[k]}`);
  assert.ok(f.emaSpreadPct > 0, 'rising candles put EMA20 above EMA50');
  assert.equal(f.dataQuality.degraded, false);
});

test('a fallback candle source or a disconnected feed marks the data degraded', () => {
  const now = T0;
  const f = computeFeatures({ ...makeSnapshot({ now }), candlesSource: 'binance:ETHUSDT-fallback', candlesDegraded: true }, null, now);
  assert.equal(f.dataQuality.degraded, true);
  const g = computeFeatures({ ...makeSnapshot({ now }), disconnected: true }, null, now);
  assert.equal(g.dataQuality.degraded, true);
});
