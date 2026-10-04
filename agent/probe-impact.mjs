#!/usr/bin/env node
// The price impact of the configured market's pool, measured the way the default replay table was (2026-10-02, Base
// WETH/USDC): a round trip at each size through Uniswap QuoterV2 — buy the asset with N dollars of the stablecoin, quote
// selling exactly what came out — and the one-way impact is half of the round trip's loss beyond two pool fees. Read-only:
// two staticCall quotes per size against the market's RPC, no key, no transaction. The last line is the table a replay of
// this market needs:  REPLAY_IMPACT_TABLE_BPS='<that line>' node agent/replay.mjs ...
//   MARKET=arbitrum-arb-usdc PAPER_CAPITAL_USD=1000 node agent/probe-impact.mjs [--sizes 1000,10000,100000,1000000]
import { parseArgs } from 'node:util';
import { formatUnits, parseUnits } from 'ethers';
import { cfg } from './config.mjs';
import { quote } from './chain.mjs';

const { values } = parseArgs({ options: { sizes: { type: 'string', default: '1000,10000,100000,1000000' } } });
const sizes = values.sizes.split(',').map(Number);
if (!sizes.length || sizes.some((n) => !(n > 0))) { console.error('--sizes must be positive dollar amounts'); process.exit(2); }
const m = cfg.market;
const feeBps = cfg.poolFee / 100; // 500 → 5 bps one way
console.log(`market ${m.name}: ${m.baseToken}/${m.quoteToken} ${cfg.poolFee / 10_000}% on ${m.chain}, quoter ${cfg.quoter}`);
const table = [];
for (const usd of sizes) {
  const bought = await quote(cfg.usdc, cfg.weth, parseUnits(String(usd), cfg.quoteDecimals));
  const back = await quote(cfg.weth, cfg.usdc, bought.amountOut);
  const out = Number(formatUnits(back.amountOut, cfg.quoteDecimals));
  const roundTripPct = (out / usd - 1) * 100;
  const oneWayBps = Math.max(0, (-roundTripPct * 100 - 2 * feeBps) / 2);
  table.push([usd, Number(oneWayBps.toFixed(2))]);
  console.log(`  $${usd.toLocaleString('en-US')}: round trip ${roundTripPct.toFixed(3)} %, one-way impact ${oneWayBps.toFixed(2)} bps beyond the ${cfg.poolFee / 10_000}% fee (block ${back.block})`);
}
console.log(JSON.stringify(table));
