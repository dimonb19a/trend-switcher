// Shadow arms of the prospective experiment: virtual portfolios that start
// from the SAME capital as the main position at the same instant and then
// decide independently, each from its own side, under the same hold, count,
// notional and data-quality rules and the same fill model (fresh quote minus
// expected slippage, paper gas per fill). Nothing here trades.
//
// STATUS (R1-G): experimental. These numbers are diagnostics for a later,
// separately designed paper experiment; they are not evidence for or against
// the strategy and no decision in the engine reads them.
//
//   hold_eth   everything in ETH from the start (one virtual buy if the main started in USDC)
//   hold_usdc  everything in USDC from the start (one virtual sell if the main started in ETH)
//   ema_only   switch on the EMA20/EMA50 side alone
//   code_judge   the judge's candidate for THIS arm's side + the trend filter, without the slow brain;
//              it carries the judge's cost because it consumes the same judgments
import { trendFilter } from './policy.mjs';

export const ARM_NAMES = ['hold_eth', 'hold_usdc', 'ema_only', 'code_judge'];

export function createArms({ cfg, ledger, clock = () => Date.now() }) {
  const key = `arms:${cfg.mode}`;
  let state = ledger.kv.get(key);
  const slip = 1 - cfg.expectedSlippageBps / 10_000;
  const fresh = (quotes, now) => Boolean(quotes) && Number.isFinite(quotes.at) && now - quotes.at <= cfg.quoteMaxAgeSec * 1000;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

  const side = (arm, price) => {
    const ethUsd = arm.ethSide * price; const total = ethUsd + arm.usdc;
    return total <= 0 ? 'MIXED' : ethUsd / total >= 0.8 ? 'ETH' : arm.usdc / total >= 0.8 ? 'USDC' : 'MIXED';
  };

  /** Virtual fill at a fresh quote minus expected slippage, booking paper gas; false when the quote is missing or stale. */
  function fill(arm, target, quotes, now) {
    if (!fresh(quotes, now)) return false;
    if (target === 'USDC' && arm.ethSide > 0 && Number.isFinite(quotes.sellQuotePrice)) {
      arm.usdc += arm.ethSide * quotes.sellQuotePrice * slip; arm.ethSide = 0;
    } else if (target === 'ETH' && arm.usdc > 0 && Number.isFinite(quotes.buyQuotePrice)) {
      arm.ethSide += (arm.usdc / quotes.buyQuotePrice) * slip; arm.usdc = 0;
    } else return false;
    const day = dayOf(now);
    if (arm.switchesDay !== day) { arm.switchesDay = day; arm.switchesToday = 0; }
    arm.switches += 1; arm.switchesToday += 1; arm.lastSwitchAt = now; arm.costsUsd += cfg.paperGasUsdPerLeg;
    return true;
  }

  /** The same rules the main arm lives under, for one arm; returns the reason it may not switch now, or null. */
  function blocked(arm, now, notionalUsd) {
    if (Number.isFinite(arm.lastSwitchAt) && now - arm.lastSwitchAt < cfg.minHoldMinutes * 60_000) return 'minimum hold';
    if (arm.switchesDay === dayOf(now) && arm.switchesToday >= cfg.maxSwitchesPerDay) return 'daily maximum';
    if (!(notionalUsd >= cfg.minNotionalUsd)) return 'notional below minimum';
    if (notionalUsd > cfg.maxCapitalUsd) return 'notional above the pilot cap';
    return null;
  }

  /** Start every arm from the main position's capital at one instant. Needs a fresh two-sided quote; returns null until it has one. */
  function init({ ethSide, usdc, price, quotes, now = clock() }) {
    if (state) return state;
    if (!fresh(quotes, now) || !Number.isFinite(price) || price <= 0) return null;
    const base = () => ({ ethSide, usdc, switches: 0, switchesToday: 0, switchesDay: null, lastSwitchAt: null, costsUsd: 0 });
    const holdEth = base(); const holdUsdc = base();
    if (holdUsdc.ethSide > 0 && !fill(holdUsdc, 'USDC', quotes, now)) return null;
    if (holdEth.usdc > 0 && !fill(holdEth, 'ETH', quotes, now)) return null;
    for (const arm of [holdEth, holdUsdc]) { arm.switches = 0; arm.switchesToday = 0; arm.switchesDay = null; arm.lastSwitchAt = null; } // the benchmark's opening fill is not a decision
    state = { hold_eth: holdEth, hold_usdc: holdUsdc, ema_only: base(), code_judge: base(), since: new Date(now).toISOString(), startCapitalUsd: ethSide * price + usdc };
    ledger.kv.set(key, state);
    return state;
  }

  /**
   * One tick for every arm. `candidateFor(side)` returns the vote window's target for a position on
   * that side (the judge's run of agreeing judgments, no slow brain) or null. `judgeCostUsd` is the
   * cost of this tick's judgment, attributed to code_judge.
   */
  function tick({ price, features, quotes, candidateFor = null, now = clock(), judgeCostUsd = 0 }) {
    if (!state) return null;
    const notes = {};
    const degraded = !features || Boolean(features.dataQuality?.degraded);
    const decide = (name, want) => {
      const arm = state[name];
      if (!want || degraded || !trendFilter(features, want).ok) return;
      if (side(arm, price) === want) return;
      const notionalUsd = want === 'USDC' ? arm.ethSide * price : arm.usdc;
      const why = blocked(arm, now, notionalUsd);
      if (why) { notes[name] = `wants ${want}: ${why}`; return; }
      notes[name] = fill(arm, want, quotes, now) ? `switched to ${want}` : `wants ${want}: no fill, quote stale or missing`;
    };
    if (features && Number.isFinite(features.emaSpreadPct)) decide('ema_only', features.emaSpreadPct > 0 ? 'ETH' : 'USDC');
    decide('code_judge', candidateFor ? candidateFor(side(state.code_judge, price)) : null);
    if (Number.isFinite(judgeCostUsd) && judgeCostUsd > 0) state.code_judge.costsUsd += judgeCostUsd;
    ledger.kv.set(key, state);
    for (const name of ARM_NAMES) {
      const arm = state[name]; const equityUsd = arm.ethSide * price + arm.usdc;
      ledger.insertArm({ arm: name, side: side(arm, price), ethSide: arm.ethSide, usdc: arm.usdc, equityUsd, costsUsd: arm.costsUsd, netUsd: equityUsd - arm.costsUsd, switches: arm.switches, note: notes[name] ?? null });
    }
    return notes;
  }

  return { init, tick, state: () => state };
}
