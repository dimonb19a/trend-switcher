// Agent configuration with a strict startup schema (TR-09). Reads ../.env once
// unless AGENT_TEST=1. Secrets stay in process.env and are read only where they
// are used (PRIVATE_KEY in chain.mjs when armed, DEEPSEEK_API_KEY in
// deepseek.mjs); nothing here logs them. Every number below is a limit the
// code enforces regardless of what any model says. Invalid or out-of-range
// values refuse to start: a misconfigured agent must not run.
import { RecordableError } from './errors.mjs';
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialPolicy, priceConfigured, priceProblems } from './judge-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const OWNER_CAP_USD = 100; // the real-money ceiling of this pilot: the live notional cap never exceeds it
export const FEATURE_SCHEMA = 'features-v2.1';
export const AGENT_VERSION = '2.14.0';

/**
 * Named starting points for the vote rule (README: Presets). `trend` (the default) and `trend-fast` vote
 * on the judge's multi-hour regime call. `forecast` is the rule of the first paper sessions and the control
 * mode: a judgment votes only on a judged 15-minute move beyond the execution cost, which produced no
 * qualifying vote in the sessions recorded so far. Explicit VOTE_* keys override a preset's values.
 */
export const RISK_PRESETS = Object.freeze({
  trend: Object.freeze({ voteBasis: 'regime', voteWindow: 6, voteMin: 5 }),
  'trend-fast': Object.freeze({ voteBasis: 'regime', voteWindow: 4, voteMin: 3 }),
  forecast: Object.freeze({ voteBasis: 'forecast', voteWindow: 6, voteMin: 5 }),
});
export const DEFAULT_RISK_PRESET = 'trend';

/**
 * The strategies (README: Strategies): how the bot leaves ETH and how it comes back. All of them vote the same way
 * (RISK_PRESET); they differ in the price condition, in what a latched loss blocks, and in the re-entry rule.
 * Explicit BREAKOUT_MIN_PCT, RISK_LATCH_BLOCKS_EXITS and REENTRY override a strategy's values.
 *   votes     — the judge alone: a switch on the votes and the trend filter                      (bot 1)
 *   breakout  — votes + a 0.9 % price breakout beyond the last two hours, both ways; a latched loss blocks every switch (bot 2)
 *   hedge     — votes + the breakout, and a latched loss never blocks a sale into USDC            (bot 3)
 *   rebuy     — the hedge's exit, and back into ETH as soon as the price is back above the last sale (bot 4)
 */
export const STRATEGIES = Object.freeze({
  votes: Object.freeze({ breakoutMinPct: 0, riskLatchBlocksExits: true, reentry: 'breakout' }),
  breakout: Object.freeze({ breakoutMinPct: 0.9, riskLatchBlocksExits: true, reentry: 'breakout' }),
  hedge: Object.freeze({ breakoutMinPct: 0.9, riskLatchBlocksExits: false, reentry: 'breakout' }),
  rebuy: Object.freeze({ breakoutMinPct: 0.9, riskLatchBlocksExits: false, reentry: 'above-sale' }),
});
export const DEFAULT_STRATEGY = 'hedge';
export const REENTRY_RULES = Object.freeze(['breakout', 'above-sale', 'above-sale-votes']);

/**
 * Markets (README: Markets): which token the bot holds against which dollar, on which chain. A market is always spot
 * against a USD stablecoin. Every address below was checked on-chain on 2026-10-04 — the quoter's and the router's
 * factory, the router's wrapped native token, the tokens' symbols and decimals, the pool of the pair at the fee tier —
 * and every fee tier is the deepest of its pair for a $1 000–$10 000 quote on that day; the Coinbase product of every
 * asset was online. Only `base-eth-usdc` has run in this repository's sessions and replays: the others are supported,
 * not tested, and refuse MODE=live. MARKET_* keys override a preset's fields; MARKET=custom needs all of them.
 */
const UNISWAP_V3 = Object.freeze({ factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' });
const OP_STACK_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const CHAINS = Object.freeze({
  base: { chainId: 8453, chain: 'Base', rpcUrl: 'https://mainnet.base.org', factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', router: '0x2626664c2603336E57B271c5C0b26F421741e481', wrappedNative: '0x4200000000000000000000000000000000000006', gasOracle: OP_STACK_GAS_ORACLE, quote: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  ethereum: { chainId: 1, chain: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com', ...UNISWAP_V3, wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', gasOracle: null, quote: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  arbitrum: { chainId: 42161, chain: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc', ...UNISWAP_V3, wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', gasOracle: null, quote: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  optimism: { chainId: 10, chain: 'OP Mainnet', rpcUrl: 'https://mainnet.optimism.io', ...UNISWAP_V3, wrappedNative: '0x4200000000000000000000000000000000000006', gasOracle: OP_STACK_GAS_ORACLE, quote: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  polygon: { chainId: 137, chain: 'Polygon PoS', rpcUrl: 'https://polygon-bor-rpc.publicnode.com', ...UNISWAP_V3, wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', gasOracle: null, quote: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
});
const market = (chain, m) => Object.freeze({ ...CHAINS[chain], quoteToken: 'USDC', quoteDecimals: 6, baseDecimals: 18, tested: false, ...m });
export const MARKETS = Object.freeze({
  'base-eth-usdc': market('base', { asset: 'ETH', baseToken: 'WETH', base: '0x4200000000000000000000000000000000000006', poolFee: 500, pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', product: 'ETH-USD', binanceSymbol: 'ETHUSDT', tested: true }),
  'ethereum-eth-usdc': market('ethereum', { asset: 'ETH', baseToken: 'WETH', base: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', poolFee: 100, pool: '0xE0554a476A092703abdB3Ef35c80e0D76d32939F', product: 'ETH-USD', binanceSymbol: 'ETHUSDT' }),
  'arbitrum-eth-usdc': market('arbitrum', { asset: 'ETH', baseToken: 'WETH', base: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', poolFee: 500, pool: '0xC6962004f452bE9203591991D15f6b388e09E8D0', product: 'ETH-USD', binanceSymbol: 'ETHUSDT' }),
  'arbitrum-arb-usdc': market('arbitrum', { asset: 'ARB', baseToken: 'ARB', base: '0x912CE59144191C1204E64559FE8253a0e49E6548', poolFee: 3000, pool: '0xaEBDcA1Bc8d89177EbE2308d62af5e74885DcCc3', product: 'ARB-USD', binanceSymbol: 'ARBUSDT' }),
  'optimism-eth-usdc': market('optimism', { asset: 'ETH', baseToken: 'WETH', base: '0x4200000000000000000000000000000000000006', poolFee: 500, pool: '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b', product: 'ETH-USD', binanceSymbol: 'ETHUSDT' }),
  'optimism-op-usdc': market('optimism', { asset: 'OP', baseToken: 'OP', base: '0x4200000000000000000000000000000000000042', poolFee: 3000, pool: '0xB533c12fB4e7b53b5524EAb9b47d93fF6C7A456F', product: 'OP-USD', binanceSymbol: 'OPUSDT' }),
  'polygon-eth-usdc': market('polygon', { asset: 'ETH', baseToken: 'WETH', base: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', poolFee: 500, pool: '0xA4D8c89f0c20efbe54cBa9e7e7a7E509056228D9', product: 'ETH-USD', binanceSymbol: 'ETHUSDT' }),
  'polygon-pol-usdc': market('polygon', { asset: 'POL', baseToken: 'WPOL', base: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', poolFee: 500, pool: '0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB', product: 'POL-USD', binanceSymbol: 'POLUSDT' }),
});
export const DEFAULT_MARKET = 'base-eth-usdc';
/** MARKET_* overrides: env key → [field, kind]. */
const MARKET_KEYS = Object.freeze({
  MARKET_CHAIN_ID: ['chainId', 'int'], MARKET_CHAIN: ['chain', 'text'], MARKET_RPC_URL: ['rpcUrl', 'text'], MARKET_PRODUCT: ['product', 'product'],
  MARKET_BINANCE_SYMBOL: ['binanceSymbol', 'symbolOrNone'], MARKET_ASSET: ['asset', 'symbol'], MARKET_BASE_TOKEN: ['baseToken', 'symbol'], MARKET_BASE: ['base', 'address'],
  MARKET_BASE_DECIMALS: ['baseDecimals', 'decimals'], MARKET_QUOTE_TOKEN: ['quoteToken', 'symbol'], MARKET_QUOTE: ['quote', 'address'], MARKET_QUOTE_DECIMALS: ['quoteDecimals', 'decimals'],
  MARKET_POOL_FEE: ['poolFee', 'fee'], MARKET_POOL: ['pool', 'address'], MARKET_FACTORY: ['factory', 'address'], MARKET_QUOTER: ['quoter', 'address'], MARKET_ROUTER: ['router', 'address'],
  MARKET_WRAPPED_NATIVE: ['wrappedNative', 'address'], MARKET_GAS_ORACLE: ['gasOracle', 'addressOrNone'],
});

/** The market of a configuration: a preset (MARKET) with MARKET_* overrides, or MARKET=custom built from them alone. */
export function resolveMarket(env, problems) {
  const name = String(env.MARKET ?? DEFAULT_MARKET).trim().toLowerCase();
  const preset = name === 'custom' ? {} : MARKETS[name];
  if (!preset) { problems.push(`MARKET must be one of ${Object.keys(MARKETS).join(', ')} or custom`); return { ...MARKETS[DEFAULT_MARKET], name: DEFAULT_MARKET }; }
  const m = { ...preset, name, overridden: [] };
  for (const [key, [field, kind]] of Object.entries(MARKET_KEYS)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const v = String(raw).trim();
    const bad = (what) => problems.push(`${key} ${what}`);
    if (kind === 'int') { const n = Number(v); if (!Number.isInteger(n) || n <= 0) bad('must be a positive integer'); else m[field] = n; }
    else if (kind === 'decimals') { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 36) bad('must be an integer 0..36'); else m[field] = n; }
    else if (kind === 'fee') { const n = Number(v); if (![100, 500, 3000, 10000].includes(n)) bad('must be one of the Uniswap v3 fee tiers 100, 500, 3000, 10000'); else m[field] = n; }
    else if (kind === 'address' || kind === 'addressOrNone') { if (kind === 'addressOrNone' && /^none$/iu.test(v)) m[field] = null; else if (!/^0x[0-9a-fA-F]{40}$/u.test(v)) bad('is not a hex address'); else m[field] = v; }
    else if (kind === 'product') { if (!/^[A-Z0-9]{2,12}-USD$/u.test(v)) bad('must be a Coinbase USD product such as ETH-USD'); else m[field] = v; }
    else if (kind === 'symbol' || kind === 'symbolOrNone') { if (kind === 'symbolOrNone' && /^none$/iu.test(v)) m[field] = null; else if (!/^[A-Za-z0-9.]{1,12}$/u.test(v)) bad('must be a short symbol'); else m[field] = v; }
    else m[field] = v;
    m.overridden.push(key);
  }
  if (m.overridden.length) m.tested = false; // an edited preset is a different market
  for (const field of ['chainId', 'chain', 'rpcUrl', 'product', 'asset', 'baseToken', 'base', 'baseDecimals', 'quoteToken', 'quote', 'quoteDecimals', 'poolFee', 'pool', 'factory', 'quoter', 'router', 'wrappedNative']) {
    if (m[field] === undefined || m[field] === null) problems.push(`market ${name}: ${field} is not set (MARKET=custom needs every MARKET_* key except MARKET_BINANCE_SYMBOL and MARKET_GAS_ORACLE)`);
  }
  if (m.binanceSymbol === undefined) m.binanceSymbol = null;
  if (m.gasOracle === undefined) m.gasOracle = null;
  if (m.tested === undefined) m.tested = false;
  delete m.overridden;
  return m;
}
/** The pool fee as the state text writes it: 500 → "0.05", 3000 → "0.3", 100 → "0.01". */
export const feePctText = (poolFee) => String(Number((poolFee / 10_000).toFixed(4)));

export class ConfigError extends RecordableError {}

const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : !/^(0|false|no|off)$/iu.test(String(value));

/** Build and validate the configuration from an environment object. Throws ConfigError listing every problem. */
export function loadConfig(env = process.env) {
  const problems = [];
  const num = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) { problems.push(`${name} is not a finite number`); return fallback; }
    if (value < min || value > max) problems.push(`${name}=${value} is outside [${min}, ${max}]`);
    return value;
  };
  // discrete contracts (counts, basis points, milliseconds) must be integers (R1-H)
  const int = (name, fallback, min, max) => {
    const value = num(name, fallback, min, max);
    if (!Number.isInteger(value)) problems.push(`${name}=${value} must be an integer`);
    return value;
  };
  const modeRaw = String(env.MODE ?? 'paper').toLowerCase();
  if (modeRaw !== 'paper' && modeRaw !== 'live') problems.push('MODE must be "paper" or "live"');
  const mode = modeRaw === 'live' ? 'live' : 'paper';
  // The wallet address is never built in: live needs it (the signer must match it); paper needs it only to
  // mirror a real wallet — a paper run with a virtual capital (PAPER_CAPITAL_USD) works without any wallet.
  const accountAddress = typeof env.ACCOUNT_ADDRESS === 'string' && env.ACCOUNT_ADDRESS.trim() !== '' ? env.ACCOUNT_ADDRESS.trim() : null;
  if (accountAddress !== null && !/^0x[0-9a-fA-F]{40}$/u.test(accountAddress)) problems.push('ACCOUNT_ADDRESS is not a hex address');
  if (mode === 'live' && accountAddress === null) problems.push('ACCOUNT_ADDRESS is required in live mode');
  // vote acceptance: which switch_quality answers may count as a vote (a risk-profile knob; default good only)
  const acceptQualityRaw = String(env.VOTE_ACCEPT_QUALITY ?? 'good').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const voteAcceptQuality = [...new Set(acceptQualityRaw)].sort();
  if (!voteAcceptQuality.length || voteAcceptQuality.some((q) => !['good', 'marginal', 'bad'].includes(q))) problems.push('VOTE_ACCEPT_QUALITY must be a comma-separated subset of good,marginal,bad');
  // risk preset: the named starting point for the vote basis and the window; explicit VOTE_BASIS / VOTE_WINDOW / VOTE_MIN override it
  const presetName = String(env.RISK_PRESET ?? DEFAULT_RISK_PRESET).trim().toLowerCase();
  const preset = RISK_PRESETS[presetName];
  if (!preset) problems.push(`RISK_PRESET must be one of ${Object.keys(RISK_PRESETS).join(', ')}`);
  const voteBasis = env.VOTE_BASIS !== undefined && env.VOTE_BASIS !== '' ? String(env.VOTE_BASIS).trim().toLowerCase() : (preset?.voteBasis ?? 'forecast');
  if (!['forecast', 'regime'].includes(voteBasis)) problems.push('VOTE_BASIS must be "forecast" or "regime"');
  const strategyName = String(env.STRATEGY ?? DEFAULT_STRATEGY).trim().toLowerCase();
  const strategy = STRATEGIES[strategyName];
  if (!strategy) problems.push(`STRATEGY must be one of ${Object.keys(STRATEGIES).join(', ')}`);
  const reentry = env.REENTRY !== undefined && env.REENTRY !== '' ? String(env.REENTRY).trim().toLowerCase() : (strategy?.reentry ?? 'breakout');
  if (!REENTRY_RULES.includes(reentry)) problems.push(`REENTRY must be one of ${REENTRY_RULES.join(', ')}`);
  const mkt = resolveMarket(env, problems);
  const rpcUrl = env.RPC_URL || mkt.rpcUrl;
  try { if (new URL(rpcUrl).protocol !== 'https:') problems.push('RPC_URL must be https'); } catch { problems.push('RPC_URL is not a URL'); }

  const c = {
    mode,
    rpcUrl,
    chainId: mkt.chainId,
    // the market (README: Markets): the asset, the stablecoin, the pool and the contracts; the fields below keep their
    // historical names — `weth` is the base token of the pair and `usdc` the stablecoin, whatever the market
    market: Object.freeze({ name: mkt.name, chain: mkt.chain, product: mkt.product, binanceSymbol: mkt.binanceSymbol, asset: mkt.asset, baseToken: mkt.baseToken, quoteToken: mkt.quoteToken, poolFee: mkt.poolFee, factory: mkt.factory, wrappedNative: mkt.wrappedNative, tested: mkt.tested }),
    baseDecimals: mkt.baseDecimals,
    quoteDecimals: mkt.quoteDecimals,
    accountAddress,
    hasPrivateKey: typeof env.PRIVATE_KEY === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(env.PRIVATE_KEY),
    // chain contracts of the market (the default, Base WETH/USDC 0.05 %, verified on-chain 2026-09-22 and 2026-10-04)
    weth: mkt.base,             // the base token of the pair (WETH on the default market)
    usdc: mkt.quote,            // the USD stablecoin
    router: mkt.router,         // Uniswap SwapRouter02; swaps go through multicall(deadline, [exactInputSingle])
    quoter: mkt.quoter,         // Uniswap QuoterV2
    gasOracle: mkt.gasOracle,   // OP-stack GasPriceOracle predeploy (L1 data fee) where the chain has one
    pool: mkt.pool,
    poolFee: mkt.poolFee,
    // stream and freshness (event time, not receive time)
    product: mkt.product,
    tickMs: int('TICK_MS', 5000, 2000, 300_000),
    candlesRefreshMs: int('CANDLES_REFRESH_MS', 60_000, 10_000, 600_000),
    maxDataAgeSec: int('MAX_DATA_AGE_SEC', 30, 5, 120),
    maxCandleAgeSec: int('MAX_CANDLE_AGE_SEC', 900, 300, 3600),
    quoteMaxAgeSec: int('QUOTE_MAX_AGE_SEC', 10, 3, 60),
    positionMaxAgeSec: int('POSITION_MAX_AGE_SEC', 20, 5, 120), // balances older than this at the verdict are re-read
    // RPC reads behind a quote: one wall-clock deadline for the block read, the quote and every retry wait between
    // them, a timeout per attempt, and the cooldown a paper session keeps after a quote failed before any effect
    quoteDeadlineMs: int('QUOTE_DEADLINE_MS', 20_000, 2_000, 60_000),
    rpcTimeoutMs: int('RPC_TIMEOUT_MS', 8_000, 1_000, 30_000),
    quoteFailureCooldownMs: int('QUOTE_FAILURE_COOLDOWN_MS', 120_000, 10_000, 3_600_000),
    // execution
    slippageBps: int('SLIPPAGE_BPS', 50, 1, 300),
    expectedSlippageBps: int('EXPECTED_SLIPPAGE_BPS', 2, 0, 100),
    gasReserveEth: num('GAS_RESERVE_ETH', 0.001, 0.0002, 0.01),
    minNotionalUsd: num('MIN_NOTIONAL_USD', 5, 1, 50),
    maxGasPctOfNotional: num('MAX_GAS_PCT_OF_NOTIONAL', 1, 0.1, 5),
    gasLimitMarginPct: int('GAS_LIMIT_MARGIN_PCT', 20, 0, 100),   // the serialized gas limit = estimate + margin; the bound uses the same limit
    l1FeeMarginPct: int('L1_FEE_MARGIN_PCT', 25, 0, 200),         // stated assumption on L1 data-fee drift between estimate and inclusion
    paperGasUsdPerLeg: num('PAPER_GAS_USD_PER_LEG', 0.003, 0, 1), // paper fills book this as an external estimated cost
    swapDeadlineSec: int('SWAP_DEADLINE_SEC', 60, 15, 300),
    receiptTimeoutMs: int('RECEIPT_TIMEOUT_MS', 90_000, 15_000, 600_000),
    // virtual capital (paper only): the virtual wallet opens with this many dollars in ETH at the tape's price
    // instead of mirroring a real wallet; null = mirror the real wallet at ACCOUNT_ADDRESS
    paperCapitalUsd: mode === 'paper' ? num('PAPER_CAPITAL_USD', null, 10, 1_000_000) : null, // up to one million: a size ladder shows the pool's price impact in real quotes
    // hard limits (code, never delegated to a model)
    maxCapitalUsd: null, // set below: the owner's real-money cap, or the paper cap of a virtual-capital run
    maxSwitchesPerDay: int('MAX_SWITCHES_PER_DAY', 6, 1, 24),
    minHoldMinutes: int('MIN_HOLD_MINUTES', 20, 1, 1440),
    maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 3, 0.5, 10),
    killLossPct: num('KILL_LOSS_PCT', 30, 1, 50),
    inferenceBudgetUsdPerDay: num('INFERENCE_BUDGET_USD_PER_DAY', 1, 0.05, 10),
    // Paper-only exception: keep observing after an inference bill could not be established (UNKNOWN).
    // A planning reserve per unknown call counts against the daily inference gate; it is not a vendor invoice.
    paperContinueUnknownBilling: mode === 'paper' && bool(env.PAPER_CONTINUE_UNKNOWN_BILLING, false),
    paperUnknownBillReserveUsd: 0,
    // judge: bring your own provider (endpoint, model pin, key and prices come from the environment only; see judge-client.mjs).
    // Without an endpoint or a model pin the runner refuses to judge; a bare configuration still loads for tools and tests.
    judgeBaseUrl: typeof env.JUDGE_BASE_URL === 'string' && env.JUDGE_BASE_URL.trim() !== '' ? env.JUDGE_BASE_URL.trim() : null,
    judgeModel: typeof env.JUDGE_MODEL === 'string' && env.JUDGE_MODEL.trim() !== '' ? env.JUDGE_MODEL.trim() : null,
    hasJudgeKey: ['JUDGE_API_KEY'].some((k) => typeof env[k] === 'string' && env[k].trim() !== ''),
    judgePriceConfigured: priceConfigured(env), // one parser with the client: blank or malformed is a problem below, never a zero price
    // votes (README: Presets). forecast basis: regime + 15-minute direction ≥ minDirectionP + quality in voteAcceptQuality;
    // regime basis: the regime call itself with ≥ minRegimeP of the mass, vetoed by a contrary forecast ≥ minDirectionP
    riskPreset: presetName,
    voteBasis,
    voteAcceptQuality,
    voteWindow: int('VOTE_WINDOW', preset?.voteWindow ?? 6, 2, 20),
    voteMin: int('VOTE_MIN', preset?.voteMin ?? 5, 1, 20),
    minDirectionP: num('MIN_DIRECTION_P', 0.7, 0.5, 0.99),
    minRegimeP: num('MIN_REGIME_P', 0.5, 0.5, 0.99),
    // breakout condition (README: Strategies), 0.9 % over the last 120 minutes unless the strategy says otherwise (0 turns it off): a candidate passes
    // only when the price has moved beyond the high/low of the closed candles of the last BREAKOUT_LOOKBACK_MIN minutes by
    // at least BREAKOUT_MIN_PCT percent — new information, not another judgment of the same state. The default is the
    // arm the 2022 replay was judged by (SESSIONS.md, session 10). Part of the hashed configuration.
    strategy: strategyName,
    breakoutMinPct: num('BREAKOUT_MIN_PCT', strategy?.breakoutMinPct ?? 0.9, 0, 20),
    breakoutLookbackMin: int('BREAKOUT_LOOKBACK_MIN', 120, 60, 240),
    maxRiskOffP: num('MAX_RISK_OFF_P', 0.6, 0.1, 0.9),
    // RISK_LATCH_BLOCKS_EXITS (false unless the strategy says otherwise): a latched daily or total loss limit halts only switches INTO ETH; a switch
    // into USDC — the risk-reducing move a hedge exists for — stays allowed. true: the latch halts every switch until
    // --reset-halt (the rule of sessions 1–9). Halts of other kinds (an unresolved on-chain outcome, an UNKNOWN bill) block
    // both directions either way. Part of the hashed configuration.
    riskLatchBlocksExits: bool(env.RISK_LATCH_BLOCKS_EXITS, strategy?.riskLatchBlocksExits ?? false),
    // REENTRY (set by STRATEGY): how the bot comes back into ETH after a sale — breakout | above-sale | above-sale-votes
    // (policy.mjs reentryCandidate). Part of the hashed configuration.
    reentry,
    // REENTRY_MARGIN_PCT: how far above the last sale the price must be for an above-sale re-entry; by default the exit's own breakout bar
    reentryMarginPct: num('REENTRY_MARGIN_PCT', strategy?.breakoutMinPct ?? 0.9, 0, 20),
    // slow brain. SLOW_BRAIN_FRAME: the question the slow brain is asked — `forecast` (the candidate against the
    // next 15 minutes and the execution cost) or `regime` (whether the judge's multi-hour regime is likely to
    // persist long enough to pay for the switch). Part of the hashed configuration.
    slowBrainFrame: (() => { const f = String(env.SLOW_BRAIN_FRAME ?? 'forecast').trim().toLowerCase(); if (!['forecast', 'regime'].includes(f)) problems.push('SLOW_BRAIN_FRAME must be "forecast" or "regime"'); return f; })(),
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    deepseekMinConfidence: num('DEEPSEEK_MIN_CONFIDENCE', 0.6, 0.5, 0.99),
    deepseekCooldownMs: int('DEEPSEEK_COOLDOWN_MS', 300_000, 30_000, 3_600_000),
    hasDeepseekKey: typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim() !== '',
    // live always requires the slow brain; REQUIRE_DEEPSEEK=false is honoured in paper only
    requireDeepseek: mode === 'live' ? true : bool(env.REQUIRE_DEEPSEEK, true),
    // files
    databasePath: env.AGENT_DB_PATH || resolve(ROOT, 'data', 'agent.db'),
    killFile: resolve(ROOT, 'KILL'),
    // one execution owner per account and chain: the lock is scoped by both (R1-C)
    lockFile: env.AGENT_LOCK_PATH || resolve(ROOT, 'data', `agent-8453-${(accountAddress ?? 'paper').toLowerCase()}.lock`),
  };
  // (A paper run without ACCOUNT_ADDRESS and without PAPER_CAPITAL_USD has nothing to mirror; the runner and the
  // self-check refuse it at start, so a bare configuration still loads for tools and tests.)
  // The notional cap. Real money: the owner's ceiling, which the environment can lower but never raise.
  // A virtual-capital paper run: the cap must sit ABOVE the capital, otherwise the first gain makes the
  // whole position unswitchable (S1-05 / V12-A); default 2 × the virtual capital, range [1×, 10×]. The
  // two are kept apart on purpose: PAPER_* keys are refused in live, and MAX_CAPITAL_USD (a real-money
  // setting) is refused next to a virtual capital, so no combination quietly raises the live cap.
  if (mode === 'live' && !mkt.tested) problems.push(`MODE=live is refused on market ${mkt.name}: only base-eth-usdc has run in this repository (README: Markets)`);
  if (mode === 'paper' && !mkt.tested && c.paperCapitalUsd === null) problems.push(`market ${mkt.name} runs on a virtual capital only: set PAPER_CAPITAL_USD (mirroring a real wallet is wired for base-eth-usdc)`);
  if (mode === 'live' && (env.PAPER_CAPITAL_USD || env.PAPER_NOTIONAL_CAP_USD)) problems.push('PAPER_CAPITAL_USD / PAPER_NOTIONAL_CAP_USD are paper-only; unset them for MODE=live');
  if (mode === 'live' && env.PAPER_CONTINUE_UNKNOWN_BILLING) problems.push('PAPER_CONTINUE_UNKNOWN_BILLING is paper-only');
  if (c.paperContinueUnknownBilling) {
    c.paperUnknownBillReserveUsd = num('PAPER_UNKNOWN_BILL_RESERVE_USD', 0.001, 0.0001, 0.01);
    if (c.paperCapitalUsd === null) problems.push('PAPER_CONTINUE_UNKNOWN_BILLING needs a virtual capital (PAPER_CAPITAL_USD)');
  } else if (env.PAPER_UNKNOWN_BILL_RESERVE_USD) {
    problems.push('PAPER_UNKNOWN_BILL_RESERVE_USD requires PAPER_CONTINUE_UNKNOWN_BILLING');
  }
  if (c.paperCapitalUsd !== null) {
    if (env.MAX_CAPITAL_USD) problems.push('MAX_CAPITAL_USD is the real-money cap; with PAPER_CAPITAL_USD set the paper cap is PAPER_NOTIONAL_CAP_USD');
    c.maxCapitalUsd = num('PAPER_NOTIONAL_CAP_USD', 2 * c.paperCapitalUsd, c.paperCapitalUsd, 10 * c.paperCapitalUsd);
  } else {
    if (env.PAPER_NOTIONAL_CAP_USD) problems.push('PAPER_NOTIONAL_CAP_USD needs PAPER_CAPITAL_USD; without a virtual capital the paper wallet mirrors the real one under the owner cap');
    c.maxCapitalUsd = num('MAX_CAPITAL_USD', OWNER_CAP_USD, 1, OWNER_CAP_USD);
  }
  if (mode === 'live' && !(c.maxCapitalUsd <= OWNER_CAP_USD)) problems.push(`live cap $${c.maxCapitalUsd} above the owner ceiling $${OWNER_CAP_USD}`); // unreachable by construction; stated so the guarantee is explicit
  if (c.voteMin > c.voteWindow) problems.push(`VOTE_MIN=${c.voteMin} exceeds VOTE_WINDOW=${c.voteWindow}`);
  if (![60, 120, 240].includes(c.breakoutLookbackMin)) problems.push('BREAKOUT_LOOKBACK_MIN must be 60, 120 or 240 (the ranges the features compute)');
  if (c.killLossPct <= c.maxDailyLossPct) problems.push('KILL_LOSS_PCT must exceed MAX_DAILY_LOSS_PCT');
  if (c.expectedSlippageBps > c.slippageBps) problems.push('EXPECTED_SLIPPAGE_BPS must not exceed SLIPPAGE_BPS');
  if (c.rpcTimeoutMs > c.quoteDeadlineMs) problems.push('RPC_TIMEOUT_MS must not exceed QUOTE_DEADLINE_MS');
  // a configured judge endpoint must satisfy the credential policy at startup: the key goes to an allowed origin only
  if (c.judgeBaseUrl !== null) { try { credentialPolicy(c.judgeBaseUrl, env); } catch (error) { problems.push(`JUDGE_BASE_URL: ${error.message}`); } }
  problems.push(...priceProblems(env));
  c.voteMaxSpanMs = Math.round(c.voteWindow * c.tickMs * 1.5);
  c.voteMaxGapMs = 2 * c.tickMs;
  if (problems.length) throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  return Object.freeze(c);
}

if (process.env.AGENT_TEST !== '1') loadEnv({ path: resolve(ROOT, '.env'), quiet: true });
export const cfg = loadConfig(process.env);

/** Keys that are not decision or execution parameters: secrets, local paths, the RPC URL (may carry a key). */
const NOT_DESCRIBED = new Set(['rpcUrl', 'hasPrivateKey', 'hasDeepseekKey', 'hasJudgeKey', 'judgeBaseUrl', 'databasePath', 'killFile', 'lockFile']);

/**
 * The complete non-secret effective configuration: every decision and execution parameter
 * with its unit in the key name (Ms, Sec, Pct, Bps, Usd, Eth, P = probability), plus the
 * derived windows. This is what the ledger hashes (R1-H); two runs with any different limit
 * get different hashes. Secrets appear only as set/unset; the RPC host only as its hostname.
 */
export function describeConfig(c = cfg) {
  const out = { version: AGENT_VERSION, units: 'Ms=milliseconds Sec=seconds Pct=percent Bps=basis points Usd=US dollars Eth=ether P=probability [0,1]' };
  for (const key of Object.keys(c).sort()) if (!NOT_DESCRIBED.has(key)) out[key] = c[key];
  out.privateKey = c.hasPrivateKey ? 'set' : 'unset';
  out.deepseekKey = c.hasDeepseekKey ? 'set' : 'unset';
  out.judgeKey = c.hasJudgeKey ? 'set' : 'unset';
  try { out.rpcHost = new URL(c.rpcUrl).hostname; } catch { out.rpcHost = null; }
  try { out.judgeHost = new URL(c.judgeBaseUrl).hostname; } catch { out.judgeHost = null; }
  return out;
}

/** Canonical JSON (sorted keys at every level) so the hash does not depend on insertion order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
