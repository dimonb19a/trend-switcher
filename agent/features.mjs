// Features are computed here, in code, from the tape and the candles. The
// judge never sees raw prices to add up: it receives categorical and
// pre-computed lines. A horizon that the data does not cover continuously
// yields null and is rendered as "unavailable" (TR-06): unknown is never
// reported as "the market is quiet".
import { FEATURE_SCHEMA, cfg, feePctText } from './config.mjs';
import { TAPE_GAP_MS } from './feed.mjs';

const CANDLE_MS = 300_000;
const pct = (a, b) => (a > 0 && b > 0 ? ((a / b) - 1) * 100 : null);
const finite = (v) => Number.isFinite(v);

/** True when the tape covers [fromT, toT] continuously: it starts early enough and no recorded gap overlaps. */
export function covered(snapshot, fromT, toT) {
  const { ticks, gaps = [] } = snapshot;
  if (!ticks.length || ticks[0].t > fromT + TAPE_GAP_MS) return false;
  for (const g of gaps) if (g.to > fromT && g.from < toT) return false;
  return true;
}

function priceAgo(snapshot, ms, now) {
  const target = now - ms;
  if (!covered(snapshot, target, now)) return null;
  const { ticks } = snapshot;
  let lo = 0; let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ticks[mid].t <= target) lo = mid; else hi = mid - 1;
  }
  const tick = ticks[lo];
  return tick.t <= target && target - tick.t <= TAPE_GAP_MS ? tick.p : null;
}

/** Close of the candle that closed at or just before `target` (within one candle), only from a contiguous set. */
function candleCloseAt(snapshot, target) {
  if (!snapshot.candlesContiguous) return null;
  const { candles } = snapshot;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const end = candles[i].t + CANDLE_MS;
    if (end <= target) return end > target - CANDLE_MS ? candles[i].close : null;
  }
  return null;
}

function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const alpha = 2 / (period + 1);
  const series = [value];
  for (let i = period; i < values.length; i += 1) { value += alpha * (values[i] - value); series.push(value); }
  return { last: value, series };
}

function stdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

/** Per-hour realized volatility (%) from 1-minute samples of a continuously covered tape window. */
function realizedVolFromTicks(snapshot, minutes, now) {
  if (!covered(snapshot, now - minutes * 60_000, now)) return null;
  const samples = [];
  for (let m = minutes; m >= 0; m -= 1) {
    const p = priceAgo(snapshot, m * 60_000, now);
    if (p === null) return null;
    samples.push(p);
  }
  const returns = [];
  for (let i = 1; i < samples.length; i += 1) returns.push(Math.log(samples[i] / samples[i - 1]));
  const sd = stdev(returns);
  return sd === null ? null : sd * Math.sqrt(60) * 100;
}

function realizedVolFromCandles(snapshot, count) {
  if (!snapshot.candlesContiguous || snapshot.candles.length < count + 1) return null;
  const closes = snapshot.candles.slice(-count - 1).map((c) => c.close);
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) returns.push(Math.log(closes[i] / closes[i - 1]));
  const sd = stdev(returns);
  return sd === null ? null : sd * Math.sqrt(12) * 100;
}

export function computeFeatures(snapshot, quotes, now = Date.now()) {
  const { last, candles } = snapshot;
  const tapeFresh = finite(snapshot.eventAgeMs) && snapshot.eventAgeMs <= cfg.maxDataAgeSec * 1000;
  const candlesFresh = finite(snapshot.candlesEventAgeMs) && snapshot.candlesEventAgeMs <= cfg.maxCandleAgeSec * 1000;
  const price = tapeFresh && last ? last.p : null;
  if (price === null) return null;

  const ret = (ms) => {
    const fromTape = priceAgo(snapshot, ms, now);
    if (fromTape !== null) return pct(price, fromTape);
    if (ms < 2 * CANDLE_MS || !candlesFresh) return null;
    const base = candleCloseAt(snapshot, now - ms);
    return base === null ? null : pct(price, base);
  };

  const closes = candlesFresh ? candles.map((c) => c.close) : [];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const emaSlopePct = ema20 && ema20.series.length > 12 ? pct(ema20.series[ema20.series.length - 1], ema20.series[ema20.series.length - 13]) : null;

  const day = candlesFresh && snapshot.candlesContiguous ? candles.filter((c) => c.t >= now - 24 * 3600 * 1000) : [];
  const dayComplete = day.length >= 280;
  const hi24 = dayComplete ? Math.max(...day.map((c) => c.high)) : null;
  const lo24 = dayComplete ? Math.min(...day.map((c) => c.low)) : null;
  const rangePos = hi24 !== null && lo24 !== null && hi24 > lo24 ? ((price - lo24) / (hi24 - lo24)) * 100 : null;
  // the high and low of the CLOSED candles of the last N minutes that do not contain the current price: the candle
  // still forming is left out, and so is a candle that closed at the very instant the price was printed (a replay
  // ticking on candle boundaries), so a price beyond the range is new information, not the candle's own extreme;
  // null unless the window is fresh, contiguous and at least 80 % populated. Read by the optional breakout condition.
  const rangeOver = (minutes) => {
    if (!candlesFresh || !snapshot.candlesContiguous) return null;
    const from = now - minutes * 60_000;
    const closed = candles.filter((c) => c.t >= from && c.t + CANDLE_MS < last.t);
    if (closed.length < Math.ceil((minutes / 5) * 0.8)) return null;
    return { minutes, high: Math.max(...closed.map((c) => c.high)), low: Math.min(...closed.map((c) => c.low)), candles: closed.length };
  };
  const range1h = rangeOver(60); const range2h = rangeOver(120); const range4h = rangeOver(240);
  let volumeRatio = null;
  if (dayComplete) {
    const recent = day.slice(-12).reduce((s, c) => s + c.volume, 0);
    const windows = [];
    for (let i = 12; i <= day.length; i += 12) windows.push(day.slice(i - 12, i).reduce((s, c) => s + c.volume, 0));
    const sorted = [...windows].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    volumeRatio = median ? recent / median : null;
  }

  const fiveMinutesAgo = now - 5 * 60_000;
  // a replay tape carries one sample per minute, which is not a trade: its activity is unknown, never "1 trade per minute"
  const tickRate = snapshot.synthetic === true ? null : covered(snapshot, fiveMinutesAgo, now) ? snapshot.ticks.filter((t) => t.t >= fiveMinutesAgo).length / 5 : null;
  const spreadBps = last?.bid && last?.ask && last.ask > last.bid ? ((last.ask - last.bid) / last.ask) * 10_000 : null;

  const coverageMinutes = (() => {
    for (const m of [60, 30, 15, 5, 1]) if (covered(snapshot, now - m * 60_000, now)) return m;
    return 0;
  })();
  const reasons = [];
  if (!candlesFresh) reasons.push('candles stale or missing');
  if (candlesFresh && !snapshot.candlesContiguous) reasons.push('candles not contiguous');
  if (snapshot.candlesDegraded) reasons.push(`candles from fallback source ${snapshot.candlesSource}`);
  if (coverageMinutes < 15) reasons.push(`tape continuous for only ${coverageMinutes} min`);
  if (snapshot.disconnected) reasons.push('feed disconnected');

  return {
    schema: FEATURE_SCHEMA,
    now,
    price,
    spreadBps,
    tapeEventAgeSec: snapshot.eventAgeMs / 1000,
    candlesEventAgeSec: finite(snapshot.candlesEventAgeMs) ? snapshot.candlesEventAgeMs / 1000 : null,
    candlesSource: snapshot.candlesSource,
    tapeCoverageMinutes: coverageMinutes,
    ret1m: ret(60_000),
    ret5m: ret(5 * 60_000),
    ret15m: ret(15 * 60_000),
    ret1h: ret(60 * 60_000),
    ret4h: ret(4 * 3600_000),
    ret24h: ret(24 * 3600_000),
    vol15m: realizedVolFromTicks(snapshot, 15, now),
    vol1h: realizedVolFromTicks(snapshot, 60, now) ?? realizedVolFromCandles(snapshot, 12),
    vol24h: dayComplete ? realizedVolFromCandles(snapshot, 288) : null,
    ema20: ema20?.last ?? null,
    ema50: ema50?.last ?? null,
    emaSpreadPct: ema20 && ema50 ? pct(ema20.last, ema50.last) : null,
    emaSlopePct,
    hi24, lo24, rangePos, volumeRatio, tickRate,
    range1h, range2h, range4h,
    quotes: quotes ?? null,
    dataQuality: { degraded: reasons.length > 0, reasons },
  };
}

const f = (v, digits = 2, suffix = '') => (!finite(v) ? 'unavailable' : `${v >= 0 && suffix === '%' ? '+' : ''}${v.toFixed(digits)}${suffix}`);
const money = (v) => (!finite(v) ? 'unavailable' : v.toFixed(2));

/** Plain-text state for the judge. English, one fact per line, no secrets, no absolute balances, no addresses. */
export function renderState(features, position, market = cfg.market) {
  const x = features;
  const m = market; const fee = feePctText(m.poolFee); // the default market renders byte-identically to the text of every recorded session
  const trend = x.emaSpreadPct === null ? 'unavailable' : `EMA20 is ${x.emaSpreadPct >= 0 ? 'above' : 'below'} EMA50 by ${Math.abs(x.emaSpreadPct).toFixed(2)}%`;
  const cost = x.quotes && finite(x.quotes.costPct)
    ? `switching the whole position costs about ${x.quotes.costPct.toFixed(2)}% (pool fee ${fee}% + price impact ${x.quotes.impactBps.toFixed(1)} bps + expected slippage ${x.quotes.expectedSlippagePct.toFixed(2)}%); the code rejects any fill worse than ${x.quotes.tolerancePct.toFixed(2)}% from the quote; gas is negligible`
    : 'switching cost estimate unavailable (assume about 0.10%)';
  const quality = x.dataQuality.degraded ? `DEGRADED: ${x.dataQuality.reasons.join('; ')}` : 'good';
  return [
    `Market: ${m.product} spot tape from Coinbase; execution on ${m.chain}, Uniswap v3 ${m.baseToken}/${m.quoteToken} ${fee}% pool.`,
    `Time (UTC): ${new Date(x.now).toISOString().replace('T', ' ').slice(0, 19)}.`,
    `Data quality: ${quality}. Tape event age ${f(x.tapeEventAgeSec, 0)} s, continuous tape for the last ${x.tapeCoverageMinutes} min; candles ${x.candlesSource ?? 'unavailable'}, newest closed ${f(x.candlesEventAgeSec === null ? null : x.candlesEventAgeSec / 60, 0)} min ago. "unavailable" means the data does not cover that horizon; do not treat it as calm.`,
    `Price: ${money(x.price)} USD. Bid/ask spread: ${f(x.spreadBps, 1)} bps. Trade activity: ${f(x.tickRate, 0)} trades per minute over the last 5 minutes.`,
    `Returns: 1m ${f(x.ret1m, 2, '%')}, 5m ${f(x.ret5m, 2, '%')}, 15m ${f(x.ret15m, 2, '%')}, 1h ${f(x.ret1h, 2, '%')}, 4h ${f(x.ret4h, 2, '%')}, 24h ${f(x.ret24h, 2, '%')}.`,
    `Realized volatility (per-hour standard deviation of returns): last 15m ${f(x.vol15m, 2)}%, last 1h ${f(x.vol1h, 2)}%, last 24h ${f(x.vol24h, 2)}%.`,
    `Trend on 5-minute candles: EMA20 ${money(x.ema20)}, EMA50 ${money(x.ema50)}; ${trend}; EMA20 slope over the last hour ${f(x.emaSlopePct, 2, '%')}.`,
    `24h range: low ${money(x.lo24)}, high ${money(x.hi24)}; the price sits at ${f(x.rangePos, 0)}% of the range (0% = low, 100% = high). Volume in the last hour is ${f(x.volumeRatio, 2)}x the median hour of the day.`,
    `Execution cost: ${cost}. A switch only pays off if the price then moves more than that cost in the intended direction.`,
    `Position: ${position.side === 'ETH' ? `in ${m.asset}` : position.side === 'USDC' ? `in ${m.quoteToken} (stablecoin, out of the market)` : 'mixed'} (${position.ethPct.toFixed(0)}% ${m.asset} / ${(100 - position.ethPct).toFixed(0)}% ${m.quoteToken} of the pilot capital). Last switch: ${position.lastSwitchMinutes === null ? 'none yet' : `${position.lastSwitchMinutes.toFixed(0)} minutes ago`}. Switches today: ${position.switchesToday} of ${position.maxSwitchesPerDay} allowed.`,
  ].join('\n');
}
