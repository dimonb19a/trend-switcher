// REENTRY and STRATEGY: how the bot comes back into ETH after a sale. `breakout` keeps the vote path and every filter;
// `above-sale` makes "the price is back at or above the last sale" the entry by itself and forbids any entry below it;
// `above-sale-votes` keeps the votes and the trend filter and replaces the breakout bar with the last sale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEther, formatUnits, parseUnits } from 'ethers';
import { reentryCandidate } from './policy.mjs';
import { STRATEGIES, DEFAULT_STRATEGY } from './config.mjs';
import { USDC, agreeingSummary, flatSummary, makeCfg, makeHarness, makeSnapshot } from './test-helpers.mjs';

const votedEth = { target: 'ETH', votes: { ETH: 5, USDC: 0 }, reason: '5/6 judgments agree' };
const none = { target: null, votes: { ETH: 1, USDC: 0 }, reason: 'no majority for a switch' };

test('breakout re-entry: the vote candidate passes through with every filter', () => {
  const cfg = makeCfg({ STRATEGY: 'hedge' });
  assert.equal(cfg.reentry, 'breakout');
  const r = reentryCandidate({ candidate: votedEth, side: 'USDC', price: 3100, lastSalePrice: 3000 }, cfg);
  assert.deepEqual(r, { candidate: votedEth, rule: 'breakout', trendFilter: true, breakout: true });
});

test('above-sale: back at or above the last sale is an entry without votes; below it no entry, even with votes', () => {
  const cfg = makeCfg({ STRATEGY: 'rebuy', REENTRY_MARGIN_PCT: '0' });
  assert.equal(cfg.reentry, 'above-sale');
  const up = reentryCandidate({ candidate: none, side: 'USDC', price: 3000, lastSalePrice: 3000 }, cfg);
  assert.equal(up.candidate.target, 'ETH'); assert.equal(up.trendFilter, false); assert.equal(up.breakout, false);
  assert.match(up.candidate.reason, /back at or above the last sale 3000\.00/u);
  const down = reentryCandidate({ candidate: votedEth, side: 'USDC', price: 2999.99, lastSalePrice: 3000 }, cfg);
  assert.equal(down.candidate.target, null);
  assert.match(down.candidate.reason, /below the last sale/u);
});

test('above-sale-votes: the votes and the trend filter decide; the last sale replaces the breakout bar', () => {
  const cfg = makeCfg({ STRATEGY: 'rebuy', REENTRY: 'above-sale-votes', REENTRY_MARGIN_PCT: '0' });
  const ok = reentryCandidate({ candidate: votedEth, side: 'USDC', price: 3010, lastSalePrice: 3000 }, cfg);
  assert.equal(ok.candidate.target, 'ETH'); assert.equal(ok.trendFilter, true); assert.equal(ok.breakout, false);
  assert.equal(reentryCandidate({ candidate: votedEth, side: 'USDC', price: 2990, lastSalePrice: 3000 }, cfg).candidate.target, null);
  assert.equal(reentryCandidate({ candidate: none, side: 'USDC', price: 3500, lastSalePrice: 3000 }, cfg).candidate.target, null, 'no votes, no entry');
});

test('the re-entry margin: by default the exit bar (0.9 %) above the last sale; a retest of the sale level is not an entry', () => {
  const cfg = makeCfg({ STRATEGY: 'rebuy' });
  assert.equal(cfg.reentryMarginPct, 0.9);
  const at = (price) => reentryCandidate({ candidate: none, side: 'USDC', price, lastSalePrice: 2000 }, cfg).candidate.target;
  assert.equal(at(2000), null, 'the retest of the sale level');
  assert.equal(at(2017.99), null);
  assert.equal(at(2018), 'ETH', '0.9 % above the sale');
  assert.equal(makeCfg({ STRATEGY: 'rebuy', REENTRY_MARGIN_PCT: '2' }).reentryMarginPct, 2);
  assert.throws(() => makeCfg({ REENTRY_MARGIN_PCT: '-1' }), /REENTRY_MARGIN_PCT/u);
});

test('the re-entry rule never touches a sale, and without a completed sale it falls back to the breakout path', () => {
  const cfg = makeCfg({ STRATEGY: 'rebuy' });
  const sell = { target: 'USDC', votes: { ETH: 0, USDC: 5 }, reason: '5/6 judgments agree' };
  assert.equal(reentryCandidate({ candidate: sell, side: 'ETH', price: 3000, lastSalePrice: 3100 }, cfg).rule, 'breakout');
  const fresh = reentryCandidate({ candidate: votedEth, side: 'USDC', price: 3000, lastSalePrice: null }, cfg);
  assert.equal(fresh.rule, 'breakout'); assert.equal(fresh.breakout, true);
});

test('strategies: the four bots and their knobs; explicit keys override; unknown names refuse to start', () => {
  assert.deepEqual(Object.keys(STRATEGIES), ['votes', 'breakout', 'hedge', 'rebuy']);
  const pick = (c) => ({ breakout: c.breakoutMinPct, latchBlocksExits: c.riskLatchBlocksExits, reentry: c.reentry });
  assert.deepEqual(pick(makeCfg({ STRATEGY: 'votes' })), { breakout: 0, latchBlocksExits: true, reentry: 'breakout' });
  assert.deepEqual(pick(makeCfg({ STRATEGY: 'breakout' })), { breakout: 0.9, latchBlocksExits: true, reentry: 'breakout' });
  assert.deepEqual(pick(makeCfg({ STRATEGY: 'hedge' })), { breakout: 0.9, latchBlocksExits: false, reentry: 'breakout' });
  assert.deepEqual(pick(makeCfg({ STRATEGY: 'rebuy' })), { breakout: 0.9, latchBlocksExits: false, reentry: 'above-sale' });
  assert.deepEqual(pick(makeCfg({ STRATEGY: 'rebuy', BREAKOUT_MIN_PCT: '0.5', RISK_LATCH_BLOCKS_EXITS: 'true', REENTRY: 'breakout' })), { breakout: 0.5, latchBlocksExits: true, reentry: 'breakout' });
  assert.equal(STRATEGIES[DEFAULT_STRATEGY] !== undefined, true);
  assert.throws(() => makeCfg({ STRATEGY: 'yolo' }), /STRATEGY/u);
  assert.throws(() => makeCfg({ REENTRY: 'whenever' }), /REENTRY/u);
});

/** A harness whose tape and quotes follow a price the test sets. */
function movingHarness(env) {
  const h = makeHarness({ env: { REQUIRE_DEEPSEEK: 'false', BREAKOUT_MIN_PCT: '0', ...env }, summary: () => agreeingSummary('USDC') });
  const m = { px: 3000 };
  h.feed.snapshot = (now) => makeSnapshot({ now, price: m.px, trendUp: false });
  h.chain.costPicture = async () => ({ at: h.clock(), impactBps: 0, expectedSlippagePct: 0.02, tolerancePct: 0.5, costPct: 0.07, sellQuotePrice: m.px, buyQuotePrice: m.px, block: 1 });
  h.chain.quote = async (tokenIn, tokenOut, amountInRaw) => ({
    amountOut: tokenOut === USDC ? parseUnits((Number(formatEther(amountInRaw)) * m.px).toFixed(6), 6) : parseUnits((Number(formatUnits(amountInRaw, 6)) / m.px).toFixed(18), 18),
    gasEstimate: 70_000n, at: h.clock(), block: 2, source: 'fake',
  });
  return { h, m };
}

test('engine, above-sale: after a sale the bot stays out until the price is 0.9 % above the sale, then comes back without votes', async () => {
  const { h, m } = movingHarness({ STRATEGY: 'rebuy' });
  const sold = (await h.advance(8)).some((o) => o?.switched === true);
  assert.equal(sold, true, 'the agreeing votes sell');
  const sale = h.ledger.lastSalePrice();
  assert.ok(Math.abs(sale / 3000 - 1) < 0.005, `the sale's fill price ${sale}`);
  h.state.summary = flatSummary; // the judge no longer votes either way
  h.wait(25 * 60_000); // past the minimum hold
  m.px = sale * 0.99;
  assert.equal((await h.advance(6)).some((o) => o?.switched === true), false, 'below the sale: no entry');
  m.px = sale * 1.005;
  assert.equal((await h.advance(6)).some((o) => o?.switched === true), false, 'above the sale but inside the 0.9 % margin: no entry');
  m.px = sale * 1.012;
  const back = await h.advance(3);
  assert.equal(back.some((o) => o?.switched === true), true, `back above the sale: ${JSON.stringify(back[back.length - 1])}`);
  h.ledger.close();
});

test('engine, breakout re-entry: the same price path without votes never buys back', async () => {
  const { h, m } = movingHarness({ STRATEGY: 'hedge' });
  assert.equal((await h.advance(8)).some((o) => o?.switched === true), true);
  const sale = h.ledger.lastSalePrice();
  h.state.summary = flatSummary;
  h.wait(25 * 60_000);
  m.px = sale * 1.012;
  assert.equal((await h.advance(6)).some((o) => o?.switched === true), false);
  h.ledger.close();
});
