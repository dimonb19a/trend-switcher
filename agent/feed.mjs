// Real-time market feed with event-time bookkeeping (TR-06): Coinbase Exchange
// WebSocket ticker (keyless) for the tape, REST 5-minute candles (keyless) for
// context, Binance public klines (ETH-USDT, a different instrument) only as a
// flagged fallback. Every message is validated; freshness is measured from
// the market timestamp, never from the moment we happened to receive it.
// Gaps in the tape are recorded so features can refuse to bridge them.
import { RecordableError } from './errors.mjs';
import { cfg } from './config.mjs';

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const REST_URL = 'https://api.exchange.coinbase.com';
const BINANCE_URL = 'https://api.binance.com/api/v3/klines';
const TICK_KEEP_MS = 65 * 60 * 1000;
export const TAPE_GAP_MS = 60_000;      // a silence longer than this is a gap
const MAX_FUTURE_SKEW_MS = 5000;        // event time ahead of our clock beyond this is rejected
const CANDLE_MS = 300_000;

const finite = (v) => Number.isFinite(v);

export class Feed {
  constructor({ product = cfg.product, binanceSymbol = cfg.market?.binanceSymbol ?? null, log = () => {}, clock = () => Date.now() } = {}) {
    this.product = product;
    this.binanceSymbol = binanceSymbol; // the fallback for the candles when Coinbase REST fails; null = no fallback
    this.log = log;
    this.clock = clock;
    this.ticks = [];          // { t (event ms), rt (receive ms), p, bid, ask, size }
    this.last = null;
    this.lastEventAt = 0;
    this.lastReceiveAt = 0;
    this.lastSequence = null;
    this.gaps = [];           // { from, to } event-time intervals with no tape
    this.rejected = { product: 0, shape: 0, future: 0, sequence: 0, stale: 0 };
    this.reordered = 0;       // accepted events that arrived after a newer one (kept in history, never the current price)
    this.vol24h = null;
    this.candles = [];        // ascending closed candles { t, open, high, low, close, volume }
    this.candlesFetchedAt = 0;
    this.candlesSource = null;
    this.candlesContiguous = false;
    this.ws = null;
    this.closed = false;
    this.reconnects = 0;
    this.disconnectedAt = null;
  }

  start() {
    this.connect();
    this.refreshCandles().catch((error) => this.log('candles error', { error: error.message }));
    this.candleTimer = setInterval(() => {
      this.refreshCandles().catch((error) => this.log('candles error', { error: error.message }));
    }, cfg.candlesRefreshMs);
  }

  stop() {
    this.closed = true;
    clearInterval(this.candleTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(WS_URL); } catch (error) {
      this.log('websocket create failed', { error: error.message });
      setTimeout(() => this.connect(), 5000);
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: [this.product], channels: ['ticker', 'heartbeat'] }));
      if (this.disconnectedAt !== null) {
        this.gaps.push({ from: this.lastEventAt || this.disconnectedAt, to: this.clock(), reason: 'reconnect' });
        this.disconnectedAt = null;
      }
      this.log('feed connected', { product: this.product, reconnects: this.reconnects });
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { this.rejected.shape += 1; return; }
      this.onMessage(message);
    });
    ws.addEventListener('close', () => {
      if (this.closed) return;
      this.reconnects += 1;
      if (this.disconnectedAt === null) this.disconnectedAt = this.clock();
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnects, 5));
      this.log('feed closed, reconnecting', { inMs: wait });
      setTimeout(() => this.connect(), wait);
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }

  /** Validate and record one ticker message. Returns true when accepted. */
  onMessage(message) {
    if (!message || message.type !== 'ticker') return false;
    if (message.product_id !== undefined && message.product_id !== this.product) { this.rejected.product += 1; return false; }
    const p = Number(message.price);
    const t = Date.parse(message.time);
    if (!finite(p) || p <= 0 || !finite(t)) { this.rejected.shape += 1; return false; }
    const rt = this.clock();
    if (t > rt + MAX_FUTURE_SKEW_MS) { this.rejected.future += 1; return false; }
    if (message.sequence !== undefined) {
      const seq = Number(message.sequence);
      if (finite(seq)) {
        if (this.lastSequence !== null && seq <= this.lastSequence) { this.rejected.sequence += 1; return false; }
        this.lastSequence = seq;
      }
    }
    if (this.lastEventAt && t < this.lastEventAt - TAPE_GAP_MS) { this.rejected.stale += 1; return false; }
    const bid = Number(message.best_bid); const ask = Number(message.best_ask);
    const tick = { t, rt, p, bid: finite(bid) && bid > 0 ? bid : null, ask: finite(ask) && ask > 0 ? ask : null, size: finite(Number(message.last_size)) ? Number(message.last_size) : 0 };
    if (this.lastEventAt && t < this.lastEventAt) {
      // an older event delivered late: it takes its place in the sorted history and never becomes the current price;
      // the age of the price we use stays the age of the newest event (R1-F)
      let i = this.ticks.length;
      while (i > 0 && this.ticks[i - 1].t > t) i -= 1;
      this.ticks.splice(i, 0, tick);
      this.reordered += 1;
      this.lastReceiveAt = rt;
      return true;
    }
    if (this.lastEventAt && t - this.lastEventAt > TAPE_GAP_MS) this.gaps.push({ from: this.lastEventAt, to: t, reason: 'silence' });
    this.ticks.push(tick);
    this.last = tick;
    this.lastEventAt = t;
    this.lastReceiveAt = rt;
    if (finite(Number(message.volume_24h))) this.vol24h = Number(message.volume_24h);
    this.prune(rt);
    return true;
  }

  prune(now) {
    const cutoff = now - TICK_KEEP_MS;
    if (this.ticks.length && this.ticks[0].t < cutoff) {
      let i = 0;
      while (i < this.ticks.length && this.ticks[i].t < cutoff) i += 1;
      this.ticks.splice(0, i);
    }
    this.gaps = this.gaps.filter((g) => g.to >= cutoff);
  }

  /** Validate a candle list: numeric, ascending, deduplicated; returns { candles, contiguous }. */
  static normalizeCandles(rows) {
    const clean = rows
      .filter((c) => [c.t, c.open, c.high, c.low, c.close, c.volume].every(finite) && c.close > 0 && c.high >= c.low)
      .sort((a, b) => a.t - b.t);
    const dedup = [];
    for (const c of clean) if (!dedup.length || dedup[dedup.length - 1].t !== c.t) dedup.push(c);
    let contiguous = dedup.length > 1;
    for (let i = 1; i < dedup.length; i += 1) if (dedup[i].t - dedup[i - 1].t !== CANDLE_MS) { contiguous = false; break; }
    return { candles: dedup, contiguous };
  }

  /** Accept a normalized candle set only when its newest closed candle is recent enough; never replace good data with stale data. */
  acceptCandles(rows, source) {
    const { candles, contiguous } = Feed.normalizeCandles(rows);
    if (candles.length < 60) throw new RecordableError(`${source}: too few candles (${candles.length})`);
    const now = this.clock();
    const newestEnd = candles[candles.length - 1].t + CANDLE_MS;
    if (now - newestEnd > cfg.maxCandleAgeSec * 1000) throw new RecordableError(`${source}: newest closed candle is ${Math.round((now - newestEnd) / 60_000)} min old`);
    this.candles = candles;
    this.candlesContiguous = contiguous;
    this.candlesSource = source;
    this.candlesFetchedAt = now;
  }

  async refreshCandles() {
    try {
      const response = await fetch(`${REST_URL}/products/${this.product}/candles?granularity=300`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new RecordableError(`coinbase candles HTTP ${response.status}`);
      const rows = await response.json(); // [ time, low, high, open, close, volume ] newest first
      if (!Array.isArray(rows)) throw new RecordableError('coinbase candles: not an array');
      // drop the currently forming candle: only closed candles are context
      const now = this.clock();
      const closed = rows.map(([time, low, high, open, close, volume]) => ({ t: time * 1000, open, high, low, close, volume }))
        .filter((c) => c.t + CANDLE_MS <= now);
      this.acceptCandles(closed, `coinbase:${this.product}`);
      return;
    } catch (error) {
      this.log('coinbase candles failed, trying binance fallback', { error: error.message });
    }
    if (!this.binanceSymbol) throw new RecordableError(`coinbase candles failed and market ${cfg.market?.name ?? ''} has no fallback`);
    const response = await fetch(`${BINANCE_URL}?symbol=${this.binanceSymbol}&interval=5m&limit=300`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new RecordableError(`binance klines HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new RecordableError('binance klines: not an array');
    const now = this.clock();
    const closed = rows.map((r) => ({ t: r[0], open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .filter((c) => c.t + CANDLE_MS <= now);
    this.acceptCandles(closed, `binance:${this.binanceSymbol}-fallback`);
  }

  snapshot(now = this.clock()) {
    const newestCandleEnd = this.candles.length ? this.candles[this.candles.length - 1].t + CANDLE_MS : null;
    return {
      product: this.product,
      ticks: this.ticks,
      last: this.last,
      gaps: this.gaps,
      eventAgeMs: this.lastEventAt ? now - this.lastEventAt : Infinity,
      receiveAgeMs: this.lastReceiveAt ? now - this.lastReceiveAt : Infinity,
      vol24h: this.vol24h,
      candles: this.candles,
      candlesContiguous: this.candlesContiguous,
      candlesEventAgeMs: newestCandleEnd ? now - newestCandleEnd : Infinity,
      candlesFetchAgeMs: this.candlesFetchedAt ? now - this.candlesFetchedAt : Infinity,
      candlesSource: this.candlesSource,
      candlesDegraded: this.candlesSource !== null && !this.candlesSource.startsWith('coinbase'),
      rejected: { ...this.rejected },
      reordered: this.reordered,
      reconnects: this.reconnects,
      disconnected: this.disconnectedAt !== null,
    };
  }
}
