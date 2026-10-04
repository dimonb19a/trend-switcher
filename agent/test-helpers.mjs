// Shared fakes for the agent tests: a configuration built from an explicit
// environment (never .env), a continuous synthetic tape and candle set, a
// fake chain that records every call and never signs, and a fake feed whose
// freshness follows the injected clock. No network, no keys, no timers.
// Every harness shares ONE clock between the engine, the ledger and the
// fakes (R1-A); the epoch is a parameter, never a way to make a test green.
import { formatEther, formatUnits, parseUnits } from 'ethers';
import { loadConfig } from './config.mjs';
import { openLedger } from './ledger.mjs';
import { createEngine } from './engine.mjs';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const WETH = '0x4200000000000000000000000000000000000006';
export const T0 = 1_800_000_000_000; // 2027-01-15T08:00:00Z, a fixed test epoch
export const REVIEW_EPOCH = Date.parse('2026-09-22T12:00:00Z'); // the review date, a second epoch for clock-independence checks

/**
 * The test baseline is STRATEGY=votes (bot 1: no breakout condition, the strict loss latch, re-entry on the votes), so the
 * tests of the vote machinery, the limits and the execution path exercise one rule at a time on the gentle synthetic tape.
 * The shipped defaults are asserted in test-config.mjs.
 */
export function makeCfg(over = {}) {
  return loadConfig({ AGENT_TEST: '1', AGENT_DB_PATH: ':memory:', AGENT_LOCK_PATH: '/dev/null', ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111', JUDGE_BASE_URL: 'https://judge.example', JUDGE_MODEL: 'judge-model-1', STRATEGY: 'votes', ...over });
}

/** A continuous 65-minute tape (one tick per minute plus one at `now`) and 300 closed contiguous 5-minute candles. */
export function makeSnapshot({ now, price = 3000, trendUp = true, minutes = 65, candleCount = 300, gap = null }) {
  const dir = trendUp ? 1 : -1;
  const ticks = [];
  for (let m = minutes; m >= 1; m -= 1) {
    const t = now - m * 60_000;
    if (gap && t > gap.from && t < gap.to) continue;
    ticks.push({ t, rt: t, p: price * (1 - dir * 0.0001 * m), bid: price - 0.05, ask: price + 0.05, size: 1 });
  }
  ticks.push({ t: now, rt: now, p: price, bid: price - 0.05, ask: price + 0.05, size: 1 });
  const end = now - (now % 300_000);
  const candles = [];
  for (let i = candleCount; i >= 1; i -= 1) {
    const c = price * (1 - dir * 0.0002 * i);
    candles.push({ t: end - i * 300_000, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 10 });
  }
  return {
    product: 'ETH-USD', ticks, last: ticks[ticks.length - 1], gaps: gap ? [gap] : [],
    eventAgeMs: 0, receiveAgeMs: 0, vol24h: 1000,
    candles, candlesContiguous: true, candlesEventAgeMs: now - end, candlesFetchAgeMs: 0,
    candlesSource: 'coinbase:ETH-USD', candlesDegraded: false, rejected: {}, reordered: 0, reconnects: 0, disconnected: false,
  };
}

/**
 * A feed that behaves like a live tape: every snapshot is a continuous tape ending at the clock's `now`.
 * With `frozenAt`, the tape stops at that event time and freshness is measured against the clock (a stalled feed).
 */
export function makeFeed({ eventAt, price = 3000, trendUp = true, frozenAt = null }) {
  return {
    snapshot(now) {
      if (frozenAt !== null) {
        const base = makeSnapshot({ now: frozenAt, price, trendUp });
        return { ...base, eventAgeMs: now - frozenAt, candlesEventAgeMs: now - (base.candles[base.candles.length - 1].t + 300_000) };
      }
      return makeSnapshot({ now: now ?? eventAt, price, trendUp });
    },
    start() {}, stop() {},
  };
}

/**
 * A fake chain: records calls, never signs. `executionPrice` is what QuoterV2 "sees" at execution time.
 * `estimateWei` is the L2 bound of every estimate; receipts can be 'ok', 'revert', 'timeout' or 'missing';
 * `l1Known` = false makes receipts come back without an L1 fee. Fills land in `bal` and are remembered
 * per hash so `receiptFacts` can report the output like the real Transfer logs would.
 */
export function fakeChain({ clock, price = 3000, executionPrice = null, balances = { eth: 0.005, weth: 0, usdc: 0 }, estimateWei = 1_000_000_000_000n, receipt = 'ok', inFlight = 0, allowance = 0n, l1Known = true } = {}) {
  const calls = { quotes: [], sends: [], approveTxs: [], swapTxs: [], estimates: 0, receiptQueries: [] };
  const bal = { ...balances };
  const fills = new Map();
  const nonces = { latest: 7, inFlight };
  const quoteAt = () => (executionPrice ?? price);
  const GAS_WEI = 902_000_000_000n; // what a receipt reports as paid (L2 900e9 + L1 2e9)
  return {
    calls, bal, fills, nonces, raw: { parseUnits, formatUnits, formatEther },
    address: () => '0x1111111111111111111111111111111111111111',
    async balances() { return { ...bal, ethRaw: parseUnits(bal.eth.toFixed(18), 18), wethRaw: parseUnits(bal.weth.toFixed(18), 18), usdcRaw: parseUnits(bal.usdc.toFixed(6), 6) }; },
    async costPicture() { return { at: clock(), impactBps: 0, expectedSlippagePct: 0.02, tolerancePct: 0.5, costPct: 0.07, sellQuotePrice: quoteAt(), buyQuotePrice: quoteAt(), block: 1 }; },
    async quote(tokenIn, tokenOut, amountInRaw) {
      const p = quoteAt();
      calls.quotes.push({ tokenIn, tokenOut, amountInRaw, at: clock() });
      const amountOut = tokenOut === USDC ? parseUnits((Number(formatEther(amountInRaw)) * p).toFixed(6), 6) : parseUnits((Number(formatUnits(amountInRaw, 6)) / p).toFixed(18), 18);
      return { amountOut, gasEstimate: 70_000n, at: clock(), block: 2, source: 'fake' };
    },
    minOut: (v) => (v * 9950n) / 10_000n,
    async feeCaps() { return { maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n }; },
    async nonceState() { return { latest: nonces.latest, pending: nonces.latest + nonces.inFlight, inFlight: nonces.inFlight }; },
    async allowance() { return allowance; },
    buildApproveTx({ token, amountRaw }) { const tx = { to: token, data: '0xapprove', value: 0n, amountRaw }; calls.approveTxs.push(tx); return tx; },
    buildSwapTx(args) { const tx = { to: 'router', data: '0xswap', value: args.useValue ? args.amountInRaw : 0n, deadline: args.deadline, minOutRaw: args.minOutRaw, tokenIn: args.tokenIn, tokenOut: args.tokenOut }; calls.swapTxs.push(tx); return tx; },
    async estimateTx() {
      calls.estimates += 1;
      const l1Wei = 2_000_000_000n; const l1BoundWei = 2_500_000_000n;
      return { gasEstimate: 160_000n, gasLimit: 192_000n, maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n, l1Wei, l1UpperBound: true, l2BoundWei: estimateWei, l1BoundWei, boundWei: estimateWei + l1BoundWei, boundUsd: Number(formatEther(estimateWei + l1BoundWei)) * price };
    },
    async send(tx, { nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas }) {
      calls.sends.push({ tx, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, at: clock() });
      const hash = `0xhash${calls.sends.length}`;
      if (receipt === 'ok' || receipt === 'revert') bal.eth -= Number(formatEther(GAS_WEI)); // gas is paid from the wallet either way
      if (tx.data === '0xswap' && receipt === 'ok') {
        const p = quoteAt();
        if (tx.value > 0n) { const eth = Number(formatEther(tx.value)); bal.eth -= eth; const out = eth * p; bal.usdc += out; fills.set(hash, { tokenOut: USDC, amountOutRaw: parseUnits(out.toFixed(6), 6) }); }
        else if (tx.tokenOut === USDC) { const out = bal.weth * p; bal.weth = 0; bal.usdc += out; fills.set(hash, { tokenOut: USDC, amountOutRaw: parseUnits(out.toFixed(6), 6) }); }
        else { const out = bal.usdc / p; bal.usdc = 0; bal.weth += out; fills.set(hash, { tokenOut: WETH, amountOutRaw: parseUnits(out.toFixed(18), 18) }); }
      }
      nonces.latest += 1;
      return { hash, nonce };
    },
    async waitReceipt() { return receipt === 'timeout' ? null : { status: receipt === 'revert' ? 0 : 1 }; },
    async receiptFacts(hash, { tokenOut = null } = {}) {
      calls.receiptQueries.push(hash);
      if (receipt === 'timeout' || receipt === 'missing') return null;
      const fill = fills.get(hash);
      const amountOutRaw = fill && tokenOut && fill.tokenOut.toLowerCase() === tokenOut.toLowerCase() ? fill.amountOutRaw : null;
      return { status: receipt === 'revert' ? 0 : 1, block: 10, gasUsed: 150_000n, effectiveGasPrice: 6_000_000n, l2Wei: 900_000_000_000n, l1Wei: l1Known ? 2_000_000_000n : null, totalWei: l1Known ? GAS_WEI : 900_000_000_000n, l1Known, amountOutRaw };
    },
  };
}

export const agreeingSummary = (target) => (target === 'USDC'
  ? { regime: 'trend_down', regimeP: 0.85, direction: 'down', directionP: 0.8, upP: 0.1, downP: 0.8, quality: 'good', qualityP: 0.8, riskOffP: 0.05 }
  : { regime: 'trend_up', regimeP: 0.85, direction: 'up', directionP: 0.8, upP: 0.8, downP: 0.1, quality: 'good', qualityP: 0.8, riskOffP: 0.05 });

export const flatSummary = () => ({ regime: 'range', regimeP: 0.6, direction: 'flat', directionP: 0.95, upP: 0.02, downP: 0.03, quality: 'bad', qualityP: 0.9, riskOffP: 0.03 });

export function fakeJudge(summaryFn) {
  return { async judge() { return { model: 'judge-model-1', answers: {}, usage: { input_tokens: 400 }, costUsd: 0.0000168, ms: 300, requestAt: 'r', responseAt: 'r' }; }, summarize() { return summaryFn(); } };
}

/**
 * A full harness on one shared clock. `summary` and `confirmFn` are read through `state` so a test
 * can flip the judge or the slow brain mid-run; the default slow brain agrees with any candidate.
 */
export function makeHarness({ live = false, epoch = T0, env = {}, chainOptions = {}, summary = () => agreeingSummary('USDC'), confirmFn = null, trendUp = false, kill = false } = {}) {
  const liveEnv = { MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real' };
  const cfg = makeCfg({ ...(live ? liveEnv : {}), ...env });
  let now = epoch;
  const clock = () => now;
  const state = { killed: kill, confirmCalls: 0, summary, confirmFn };
  const chain = fakeChain({ clock, ...chainOptions });
  const ledger = openLedger(cfg, { clock });
  const feed = makeFeed({ eventAt: epoch, trendUp });
  const slowBrain = { async confirm(args) { state.confirmCalls += 1; return state.confirmFn ? state.confirmFn(args, state) : { ok: true, agrees: true, stance: args.candidate, confidence: 0.8, model: 'deepseek-flash', costUsd: 0.0002 }; } };
  const judge = fakeJudge(() => state.summary());
  const engine = createEngine({ cfg, armed: live, chain, ledger, feed, judge, slowBrain, clock, fsx: { existsSync: () => state.killed }, log: () => {} });
  const advance = async (ticks) => { const outs = []; for (let i = 0; i < ticks; i += 1) { outs.push(await engine.tick()); now += cfg.tickMs; } return outs; };
  return { cfg, engine, chain, ledger, feed, judge, state, clock, advance, last: async (ticks) => (await advance(ticks))[ticks - 1], wait: (ms) => { now += ms; }, setNow: (t) => { now = t; }, tickMs: cfg.tickMs };
}
