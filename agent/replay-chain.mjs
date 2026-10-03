// The chain of a replay: no network, no signer, no wallet — a cost scenario instead of a quoter.
// The fill of a switch decided at the simulated instant T is the OPEN of the minute that starts at T
// (the first price observed after the decision) times the scenario; the decision itself only ever
// saw the close of the minute before. The pool fee is the pool's (0.05 %); the price impact is the
// one measured on the Base WETH/USDC pool on 2026-10-02 with round-trip quotes at four sizes, read
// at the notional of the switch; the engine applies its expected slippage on top, as live. Nothing
// here knows the historical liquidity of a pool that did not exist: the numbers are a scenario, and
// the report says so.
import { formatEther, formatUnits, parseUnits } from 'ethers';
import { RecordableError } from './errors.mjs';
import { cfg as defaultCfg } from './config.mjs';

export const POOL_FEE_PCT = 0.05;
/** One-way price impact in basis points by notional (USD), from the 2026-10-02 probe: round trips of −0.103 / −0.126 / −0.356 / −2.760 % minus two pool fees, halved. */
export const IMPACT_TABLE_BPS = Object.freeze([[1_000, 0.15], [10_000, 1.3], [100_000, 12.8], [1_000_000, 133]]);

/** Impact for a notional: log-linear between the probed sizes, clamped at both ends. */
export function impactBpsFor(notionalUsd, table = IMPACT_TABLE_BPS) {
  if (!(notionalUsd > 0) || notionalUsd <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i += 1) {
    const [n0, b0] = table[i - 1]; const [n1, b1] = table[i];
    if (notionalUsd <= n1) return b0 + ((Math.log(notionalUsd) - Math.log(n0)) / (Math.log(n1) - Math.log(n0))) * (b1 - b0);
  }
  return table[table.length - 1][1];
}

/** The typed pre-effect failure the engine understands (a paper switch is cancelled without a halt and a cooldown follows). */
export class ReplayQuoteError extends RecordableError {
  constructor(message) {
    super(message);
    this.name = 'ReplayQuoteError';
    this.code = 'QUOTE_UNAVAILABLE';
    this.shortMessage = message;
    this.preEffect = true;
    this.stage = 'quote';
    this.attempts = 1;
    this.elapsedMs = 0;
    this.transient = true;
    this.stopped = false;
  }
}

export function createReplayChain({ minutes, clock, cfg = defaultCfg, impactBps = null }) {
  const byStart = new Map(minutes.map((r) => [r.t, r]));
  const impact = (notionalUsd) => (impactBps === null ? impactBpsFor(notionalUsd) : impactBps);
  const oneWay = (notionalUsd) => POOL_FEE_PCT / 100 + impact(notionalUsd) / 10_000; // a fraction of the price
  const calls = { quotes: 0, costPictures: 0 };

  /** The first price observed after the simulated instant: the open of the minute that starts there. */
  function fillPriceAt(now) {
    const start = now - (now % 60_000);
    const row = byStart.get(start);
    if (!row) throw new ReplayQuoteError(`no executable minute at ${new Date(start).toISOString()} in the history`);
    return row.open;
  }

  const notImplemented = (name) => () => { throw new RecordableError(`${name} is not part of a replay (paper only, no chain)`); };

  return {
    calls,
    raw: { parseUnits, formatUnits, formatEther },
    address: () => null,
    async balances() { return { ethRaw: 0n, wethRaw: 0n, usdcRaw: 0n, eth: 0, weth: 0, usdc: 0 }; },
    async costPicture({ ethSide, usdc, midPrice }) {
      calls.costPictures += 1;
      const notional = ethSide * midPrice + usdc;
      const bps = impact(notional);
      const w = oneWay(notional);
      return {
        at: clock(), impactBps: bps,
        expectedSlippagePct: cfg.expectedSlippageBps / 100, tolerancePct: cfg.slippageBps / 100,
        costPct: POOL_FEE_PCT + bps / 100 + cfg.expectedSlippageBps / 100,
        sellQuotePrice: midPrice * (1 - w), buyQuotePrice: midPrice * (1 + w), block: null, scenario: 'replay',
      };
    },
    async quote(tokenIn, tokenOut, amountInRaw) {
      calls.quotes += 1;
      const sell = tokenOut === cfg.usdc;
      const amountIn = sell ? Number(formatEther(amountInRaw)) : Number(formatUnits(amountInRaw, 6));
      const price = fillPriceAt(clock());
      const notional = sell ? amountIn * price : amountIn;
      const w = oneWay(notional);
      const out = sell ? amountIn * price * (1 - w) : amountIn / (price * (1 + w));
      return { amountOut: sell ? parseUnits(out.toFixed(6), 6) : parseUnits(out.toFixed(18), 18), gasEstimate: 0n, at: clock(), block: null, source: 'replay-scenario', fillPrice: price, impactBps: impact(notional) };
    },
    minOut: (v) => (v * BigInt(10_000 - cfg.slippageBps)) / 10_000n,
    feeCaps: notImplemented('feeCaps'), nonceState: notImplemented('nonceState'), allowance: notImplemented('allowance'),
    buildSwapTx: notImplemented('buildSwapTx'), buildApproveTx: notImplemented('buildApproveTx'), estimateTx: notImplemented('estimateTx'),
    send: notImplemented('send'), waitReceipt: notImplemented('waitReceipt'), receiptFacts: notImplemented('receiptFacts'),
    fillPriceAt,
  };
}
