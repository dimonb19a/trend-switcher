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
export const AGENT_VERSION = '2.11.0';

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
  const rpcUrl = env.RPC_URL || 'https://mainnet.base.org';
  try { if (new URL(rpcUrl).protocol !== 'https:') problems.push('RPC_URL must be https'); } catch { problems.push('RPC_URL is not a URL'); }

  const c = {
    mode,
    rpcUrl,
    chainId: 8453,
    accountAddress,
    hasPrivateKey: typeof env.PRIVATE_KEY === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(env.PRIVATE_KEY),
    // chain (Base mainnet) — addresses verified on-chain 2026-09-22
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap SwapRouter02; swaps go through multicall(deadline, [exactInputSingle])
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // Uniswap QuoterV2
    gasOracle: '0x420000000000000000000000000000000000000F', // Base GasPriceOracle predeploy (L1 data fee)
    pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',   // WETH/USDC 0.05%
    poolFee: 500,
    // stream and freshness (event time, not receive time)
    product: 'ETH-USD',
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
    // breakout condition (README: Presets), off by default: a candidate passes only when the price has moved beyond the
    // high/low of the closed candles of the last BREAKOUT_LOOKBACK_MIN minutes by at least BREAKOUT_MIN_PCT percent —
    // new information, not another judgment of the same state. Part of the hashed configuration.
    breakoutMinPct: num('BREAKOUT_MIN_PCT', 0, 0, 20),
    breakoutLookbackMin: int('BREAKOUT_LOOKBACK_MIN', 120, 60, 240),
    maxRiskOffP: num('MAX_RISK_OFF_P', 0.6, 0.1, 0.9),
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
