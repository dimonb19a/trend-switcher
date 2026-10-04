// Markets: a market is a preset (or MARKET=custom) of chain, tokens, pool and contracts; the bot always trades the asset
// spot against a USD stablecoin. The default market must render the judge's state and questions byte for byte as every
// recorded session did (the golden texts below were rendered by the 2.13.0 code before markets existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits, parseUnits } from 'ethers';
import { MARKETS, DEFAULT_MARKET, loadConfig } from './config.mjs';
import { renderState } from './features.mjs';
import { questionsFor } from './judge.mjs';
import { runReplay } from './replay.mjs';
import { createReplayChain } from './replay-chain.mjs';

const env = (over = {}) => ({ AGENT_TEST: '1', PAPER_CAPITAL_USD: '1000', ...over });
const ADDR = /^0x[0-9a-fA-F]{40}$/u;

const features = { now: Date.parse('2027-01-15T08:00:00Z'), price: 3012.34, spreadBps: 1.23, tapeEventAgeSec: 2, candlesEventAgeSec: 60, candlesSource: 'coinbase:ETH-USD', tapeCoverageMinutes: 60,
  ret1m: 0.01, ret5m: -0.12, ret15m: 0.34, ret1h: -0.56, ret4h: 1.2, ret24h: -2.3, vol15m: 0.4, vol1h: 0.5, vol24h: 0.6, ema20: 3001.2, ema50: 2990.8, emaSpreadPct: 0.35, emaSlopePct: 0.12,
  hi24: 3100, lo24: 2900, rangePos: 56, volumeRatio: 1.4, tickRate: 37, dataQuality: { degraded: false, reasons: [] },
  quotes: { costPct: 0.0712, impactBps: 0.12, expectedSlippagePct: 0.02, tolerancePct: 0.5 } };
const GOLDEN = {
  "eth": "Market: ETH-USD spot tape from Coinbase; execution on Base, Uniswap v3 WETH/USDC 0.05% pool.\nTime (UTC): 2027-01-15 08:00:00.\nData quality: good. Tape event age 2 s, continuous tape for the last 60 min; candles coinbase:ETH-USD, newest closed 1 min ago. \"unavailable\" means the data does not cover that horizon; do not treat it as calm.\nPrice: 3012.34 USD. Bid/ask spread: 1.2 bps. Trade activity: 37 trades per minute over the last 5 minutes.\nReturns: 1m +0.01%, 5m -0.12%, 15m +0.34%, 1h -0.56%, 4h +1.20%, 24h -2.30%.\nRealized volatility (per-hour standard deviation of returns): last 15m 0.40%, last 1h 0.50%, last 24h 0.60%.\nTrend on 5-minute candles: EMA20 3001.20, EMA50 2990.80; EMA20 is above EMA50 by 0.35%; EMA20 slope over the last hour +0.12%.\n24h range: low 2900.00, high 3100.00; the price sits at 56% of the range (0% = low, 100% = high). Volume in the last hour is 1.40x the median hour of the day.\nExecution cost: switching the whole position costs about 0.07% (pool fee 0.05% + price impact 0.1 bps + expected slippage 0.02%); the code rejects any fill worse than 0.50% from the quote; gas is negligible. A switch only pays off if the price then moves more than that cost in the intended direction.\nPosition: in ETH (100% ETH / 0% USDC of the pilot capital). Last switch: none yet. Switches today: 0 of 6 allowed.",
  "usdc": "Market: ETH-USD spot tape from Coinbase; execution on Base, Uniswap v3 WETH/USDC 0.05% pool.\nTime (UTC): 2027-01-15 08:00:00.\nData quality: DEGRADED: tape stale 40 s. Tape event age 2 s, continuous tape for the last 60 min; candles coinbase:ETH-USD, newest closed 1 min ago. \"unavailable\" means the data does not cover that horizon; do not treat it as calm.\nPrice: 3012.34 USD. Bid/ask spread: 1.2 bps. Trade activity: 37 trades per minute over the last 5 minutes.\nReturns: 1m +0.01%, 5m -0.12%, 15m +0.34%, 1h -0.56%, 4h +1.20%, 24h -2.30%.\nRealized volatility (per-hour standard deviation of returns): last 15m 0.40%, last 1h 0.50%, last 24h 0.60%.\nTrend on 5-minute candles: EMA20 3001.20, EMA50 2990.80; EMA20 is above EMA50 by 0.35%; EMA20 slope over the last hour +0.12%.\n24h range: low 2900.00, high 3100.00; the price sits at 56% of the range (0% = low, 100% = high). Volume in the last hour is 1.40x the median hour of the day.\nExecution cost: switching cost estimate unavailable (assume about 0.10%). A switch only pays off if the price then moves more than that cost in the intended direction.\nPosition: in USDC (stablecoin, out of the market) (0% ETH / 100% USDC of the pilot capital). Last switch: 42 minutes ago. Switches today: 2 of 6 allowed.",
  "mixed": "Market: ETH-USD spot tape from Coinbase; execution on Base, Uniswap v3 WETH/USDC 0.05% pool.\nTime (UTC): 2027-01-15 08:00:00.\nData quality: good. Tape event age 2 s, continuous tape for the last 60 min; candles coinbase:ETH-USD, newest closed 1 min ago. \"unavailable\" means the data does not cover that horizon; do not treat it as calm.\nPrice: 3012.34 USD. Bid/ask spread: 1.2 bps. Trade activity: 37 trades per minute over the last 5 minutes.\nReturns: 1m +0.01%, 5m -0.12%, 15m +0.34%, 1h -0.56%, 4h +1.20%, 24h -2.30%.\nRealized volatility (per-hour standard deviation of returns): last 15m 0.40%, last 1h 0.50%, last 24h 0.60%.\nTrend on 5-minute candles: EMA20 3001.20, EMA50 2990.80; EMA20 is above EMA50 by 0.35%; EMA20 slope over the last hour +0.12%.\n24h range: low 2900.00, high 3100.00; the price sits at 56% of the range (0% = low, 100% = high). Volume in the last hour is 1.40x the median hour of the day.\nExecution cost: switching the whole position costs about 0.07% (pool fee 0.05% + price impact 0.1 bps + expected slippage 0.02%); the code rejects any fill worse than 0.50% from the quote; gas is negligible. A switch only pays off if the price then moves more than that cost in the intended direction.\nPosition: mixed (56% ETH / 45% USDC of the pilot capital). Last switch: 3 minutes ago. Switches today: 1 of 6 allowed."
};

test('every preset resolves: hex addresses, a Uniswap v3 fee tier, a Coinbase USD product; only the default is tested', () => {
  assert.equal(DEFAULT_MARKET, 'base-eth-usdc');
  for (const name of Object.keys(MARKETS)) {
    const c = loadConfig(env({ MARKET: name }));
    assert.equal(c.market.name, name);
    for (const a of [c.weth, c.usdc, c.pool, c.router, c.quoter, c.market.factory, c.market.wrappedNative]) assert.match(a, ADDR, `${name} ${a}`);
    assert.ok([100, 500, 3000, 10000].includes(c.poolFee));
    assert.match(c.product, /^[A-Z0-9]+-USD$/u);
    assert.equal(c.market.quoteToken, 'USDC'); assert.equal(c.quoteDecimals, 6);
    assert.equal(c.market.tested, name === 'base-eth-usdc');
  }
  const d = loadConfig(env());
  assert.equal(d.chainId, 8453); assert.equal(d.weth, '0x4200000000000000000000000000000000000006'); assert.equal(d.usdc, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(d.pool, '0xd0b53D9277642d899DF5C87A3966A349A798F224'); assert.equal(d.poolFee, 500); assert.equal(d.product, 'ETH-USD'); assert.equal(d.rpcUrl, 'https://mainnet.base.org');
});

test('an untested market is paper only, on a virtual capital; an edited preset is untested', () => {
  assert.throws(() => loadConfig(env({ MARKET: 'arbitrum-eth-usdc', MODE: 'live', PAPER_CAPITAL_USD: '', ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111' })), /MODE=live is refused on market arbitrum-eth-usdc/u);
  assert.throws(() => loadConfig({ AGENT_TEST: '1', MARKET: 'arbitrum-eth-usdc', ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111' }), /virtual capital only/u);
  const edited = loadConfig(env({ MARKET_POOL_FEE: '3000', MARKET_POOL: '0x6c561B446416E1A00E8E93E221854d6eA4171372' }));
  assert.equal(edited.poolFee, 3000); assert.equal(edited.market.tested, false);
  assert.throws(() => loadConfig(env({ MARKET_POOL_FEE: '3000', MODE: 'live', PAPER_CAPITAL_USD: '', ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111' })), /MODE=live is refused/u);
});

test('MARKET=custom needs every key; malformed values refuse to start', () => {
  // the custom market's addresses here are well-formed examples for the schema; selfcheck verifies a real one on-chain
  const full = { MARKET: 'custom', MARKET_CHAIN_ID: '8453', MARKET_CHAIN: 'Base', MARKET_RPC_URL: 'https://mainnet.base.org', MARKET_PRODUCT: 'BTC-USD', MARKET_ASSET: 'BTC', MARKET_BASE_TOKEN: 'cbBTC',
    MARKET_BASE: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', MARKET_BASE_DECIMALS: '8', MARKET_QUOTE_TOKEN: 'USDC', MARKET_QUOTE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', MARKET_QUOTE_DECIMALS: '6',
    MARKET_POOL_FEE: '500', MARKET_POOL: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', MARKET_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', MARKET_QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    MARKET_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481', MARKET_WRAPPED_NATIVE: '0x4200000000000000000000000000000000000006' };
  const c = loadConfig(env(full));
  assert.equal(c.market.asset, 'BTC'); assert.equal(c.baseDecimals, 8); assert.equal(c.market.tested, false); assert.equal(c.market.binanceSymbol, null);
  const { MARKET_POOL: _omit, ...missing } = full;
  assert.throws(() => loadConfig(env(missing)), /pool is not set/u);
  assert.throws(() => loadConfig(env({ MARKET: 'nowhere' })), /MARKET must be one of/u);
  assert.throws(() => loadConfig(env({ MARKET_POOL: '0x123' })), /MARKET_POOL is not a hex address/u);
  assert.throws(() => loadConfig(env({ MARKET_POOL_FEE: '250' })), /fee tiers/u);
  assert.throws(() => loadConfig(env({ MARKET_PRODUCT: 'ETH-EUR' })), /Coinbase USD product/u);
});

test('the default market renders the state byte for byte as before markets existed', () => {
  const m = loadConfig(env()).market;
  assert.equal(renderState(features, { side: 'ETH', ethPct: 100, lastSwitchMinutes: null, switchesToday: 0, maxSwitchesPerDay: 6 }, m), GOLDEN.eth);
  assert.equal(renderState({ ...features, quotes: null, dataQuality: { degraded: true, reasons: ['tape stale 40 s'] } }, { side: 'USDC', ethPct: 0, lastSwitchMinutes: 42.4, switchesToday: 2, maxSwitchesPerDay: 6 }, m), GOLDEN.usdc);
  assert.equal(renderState(features, { side: 'mixed', ethPct: 55.5, lastSwitchMinutes: 3, switchesToday: 1, maxSwitchesPerDay: 6 }, m), GOLDEN.mixed);
});

test('another market names its own asset, pool and fee in the state and the questions', () => {
  const m = loadConfig(env({ MARKET: 'arbitrum-arb-usdc' })).market;
  const text = renderState({ ...features, candlesSource: 'coinbase:ARB-USD' }, { side: 'USDC', ethPct: 0, lastSwitchMinutes: 5, switchesToday: 1, maxSwitchesPerDay: 6 }, m);
  assert.match(text, /^Market: ARB-USD spot tape from Coinbase; execution on Arbitrum One, Uniswap v3 ARB\/USDC 0\.3% pool\.$/mu);
  assert.match(text, /\(pool fee 0\.3% \+ price impact/u);
  assert.match(text, /Position: in USDC \(stablecoin, out of the market\) \(0% ARB \/ 100% USDC of the pilot capital\)/u);
  const q = questionsFor(m);
  assert.match(q.regime.instructions, /best describes ARB over the last hours/u);
  assert.match(q.direction_15m.instructions, /Where is the ARB price/u);
  assert.match(q.switch_quality.instructions, /between ARB and USDC\?/u);
  const d = questionsFor(loadConfig(env()).market);
  assert.equal(d.switch_quality.instructions, 'Given the current position, the data quality and the execution cost, is this a good moment to switch the whole position between ETH and USDC?');
});

test('a replay of another market needs that pool\'s impact table; the replay chain uses the market\'s fee and decimals', async () => {
  const cfg = loadConfig(env({ MARKET: 'arbitrum-arb-usdc', TICK_MS: '300000', REQUIRE_DEEPSEEK: 'false' }));
  const minutes = Array.from({ length: 3000 }, (_, i) => ({ t: Date.parse('2024-01-01T00:00:00Z') + i * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  await assert.rejects(() => runReplay({ cfg, minutes, fiveMinutes: [], fromMs: Date.parse('2024-01-02T04:00:00Z'), toMs: Date.parse('2024-01-02T05:00:00Z'), judge: null }), /impact table/u);
  const btc = loadConfig(env({ MARKET: 'custom', MARKET_CHAIN_ID: '8453', MARKET_CHAIN: 'Base', MARKET_RPC_URL: 'https://mainnet.base.org', MARKET_PRODUCT: 'BTC-USD', MARKET_ASSET: 'BTC', MARKET_BASE_TOKEN: 'cbBTC',
    MARKET_BASE: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', MARKET_BASE_DECIMALS: '8', MARKET_QUOTE_TOKEN: 'USDC', MARKET_QUOTE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', MARKET_QUOTE_DECIMALS: '6',
    MARKET_POOL_FEE: '3000', MARKET_POOL: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', MARKET_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', MARKET_QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    MARKET_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481', MARKET_WRAPPED_NATIVE: '0x4200000000000000000000000000000000000006' }));
  const t = Date.parse('2024-01-02T04:00:00Z');
  const chain = createReplayChain({ minutes: [{ t, open: 40_000, high: 40_000, low: 40_000, close: 40_000, volume: 1 }], clock: () => t, cfg: btc, impactTable: [[1000, 0], [10_000, 0]] });
  const sold = await chain.quote(btc.weth, btc.usdc, parseUnits('0.5', 8));
  assert.equal(Number(formatUnits(sold.amountOut, 6)), 20_000 * (1 - 0.003), '0.5 BTC at 40 000 less the 0.3 % fee');
  const bought = await chain.quote(btc.usdc, btc.weth, parseUnits('20000', 6));
  assert.ok(Math.abs(Number(formatUnits(bought.amountOut, 8)) - 0.5 / 1.003) < 1e-8);
  const pic = await chain.costPicture({ ethSide: 0.5, usdc: 0, midPrice: 40_000 });
  assert.ok(Math.abs(pic.costPct - (0.3 + 0.02)) < 1e-9, `cost ${pic.costPct}`);
});
