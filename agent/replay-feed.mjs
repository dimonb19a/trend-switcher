// A tape and candle set replayed from historical candles under a simulated clock. The engine, the
// features and the policy are the live ones; only the source of the data is replaced, and the
// snapshot has the same shape as the live feed's.
//
// Availability, not bucket time: Coinbase stamps a candle with the START of its bucket, so the
// minute [t, t+60 s) is observable at t+60 s and never earlier — its close becomes the tape's sample
// at that instant, and a five-minute candle enters the context only when its bucket has closed.
// A minute the exchange has no trades for is absent from the data: it stays absent here, recorded as
// a gap in the tape (the features then refuse to bridge it, as live). A five-minute bucket that is
// absent would make the whole 25-hour candle window non-contiguous for a day, so it is filled with
// a flat candle at the previous close, volume zero, marked and counted — a named approximation.
// One sample per minute is not a trade: the snapshot is marked `synthetic`, and the features report
// the trade activity as unknown. Nothing here looks past the simulated instant.
import { RecordableError } from './errors.mjs';

export const MINUTE_MS = 60_000;
export const CANDLE_MS = 300_000;
const TICK_KEEP_MS = 65 * 60 * 1000;
const CANDLE_KEEP = 300;

const finite = (v) => Number.isFinite(v);

function checkRows(rows, stepMs, label) {
  if (!Array.isArray(rows) || rows.length === 0) throw new RecordableError(`${label}: no rows`);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (![r.t, r.open, r.high, r.low, r.close, r.volume].every(finite) || r.close <= 0) throw new RecordableError(`${label}: bad row ${i}`);
    if (r.t % stepMs !== 0) throw new RecordableError(`${label}: row ${i} is not aligned to ${stepMs} ms`);
    if (i > 0 && r.t <= rows[i - 1].t) throw new RecordableError(`${label}: rows are not strictly ascending at ${i}`);
  }
}

export class ReplayFeed {
  constructor({ minutes, fiveMinutes, product = 'ETH-USD', fillMissingCandles = true }) {
    checkRows(minutes, MINUTE_MS, 'minutes');
    checkRows(fiveMinutes, CANDLE_MS, 'five-minute candles');
    this.minutes = minutes;
    this.fives = fiveMinutes;
    this.product = product;
    this.fillMissingCandles = fillMissingCandles;
    this.now = null;
    this.mi = 0;
    this.fi = 0;
    this.ticks = [];
    this.gaps = [];
    this.candles = [];
    this.lastEventAt = 0;
    this.syntheticCandles = 0;
    this.missingMinutes = 0;
  }

  start() {}
  stop() {}

  /** Move the simulated clock forward; everything that became observable at or before `now` enters the tape and the context. */
  advanceTo(now) {
    if (!finite(now)) throw new RecordableError('replay clock needs a finite instant');
    if (this.now !== null && now < this.now) throw new RecordableError('replay clock cannot move backwards');
    this.now = now;
    while (this.mi < this.minutes.length && this.minutes[this.mi].t + MINUTE_MS <= now) {
      const r = this.minutes[this.mi];
      const t = r.t + MINUTE_MS; // the instant the minute became observable
      if (this.lastEventAt && t - this.lastEventAt > MINUTE_MS) {
        this.gaps.push({ from: this.lastEventAt, to: t, reason: 'minutes without trades' });
        this.missingMinutes += Math.round((t - this.lastEventAt) / MINUTE_MS) - 1;
      }
      this.ticks.push({ t, rt: t, p: r.close, bid: null, ask: null, size: r.volume });
      this.lastEventAt = t;
      this.mi += 1;
    }
    const cutoff = now - TICK_KEEP_MS;
    if (this.ticks.length && this.ticks[0].t < cutoff) {
      let i = 0;
      while (i < this.ticks.length && this.ticks[i].t < cutoff) i += 1;
      this.ticks.splice(0, i);
    }
    this.gaps = this.gaps.filter((g) => g.to >= cutoff);
    while (this.fi < this.fives.length && this.fives[this.fi].t + CANDLE_MS <= now) {
      const c = this.fives[this.fi];
      const last = this.candles[this.candles.length - 1];
      if (last && this.fillMissingCandles) {
        for (let expected = last.t + CANDLE_MS; expected < c.t; expected += CANDLE_MS) {
          this.candles.push({ t: expected, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0, synthetic: true });
          this.syntheticCandles += 1;
        }
      }
      this.candles.push({ t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      this.fi += 1;
    }
    if (this.candles.length > CANDLE_KEEP) this.candles.splice(0, this.candles.length - CANDLE_KEEP);
  }

  /** The live feed's snapshot shape, at the simulated instant. */
  snapshot(now = this.now) {
    const last = this.ticks.length ? this.ticks[this.ticks.length - 1] : null;
    const newestCandleEnd = this.candles.length ? this.candles[this.candles.length - 1].t + CANDLE_MS : null;
    let contiguous = this.candles.length > 1;
    for (let i = 1; contiguous && i < this.candles.length; i += 1) if (this.candles[i].t - this.candles[i - 1].t !== CANDLE_MS) contiguous = false;
    return {
      product: this.product,
      ticks: this.ticks,
      last,
      gaps: this.gaps,
      eventAgeMs: last ? now - last.t : Infinity,
      receiveAgeMs: last ? now - last.rt : Infinity,
      vol24h: null,
      candles: this.candles,
      candlesContiguous: contiguous,
      candlesEventAgeMs: newestCandleEnd !== null ? now - newestCandleEnd : Infinity,
      candlesFetchAgeMs: 0,
      candlesSource: `coinbase:${this.product}`,
      candlesDegraded: false,
      rejected: {},
      reordered: 0,
      reconnects: 0,
      disconnected: false,
      synthetic: true,
      syntheticCandles: this.syntheticCandles,
    };
  }
}
