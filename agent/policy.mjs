// Policy: code decides. The judge's answers are timestamped votes; a candidate
// switch needs a run of agreeing, time-valid judgments, the deterministic
// trend filter, the slow brain's agreement, and every hard limit, re-checked
// right before each paid effect (TR-02). Non-finite inputs veto (TR-09).
// What a judgment votes on is the risk preset's choice (`agreesWith`): the
// judge's multi-hour regime call (trend, the default) or its 15-minute
// forecast (forecast, the control mode of the first sessions).
//
// Stop semantics (TR-10), stated plainly: every limit here is a HALT of new
// actions. None of them is a stop-loss order, none exits ETH into USDC, none
// bounds the loss of a position that is already held.
//
// What LATCHES (stays until the owner runs `--reset-halt`, R1-E): a daily or
// total net loss beyond its limit (`riskBreach`, evaluated every tick whether
// or not a candidate exists); any paid effect whose outcome is failed,
// reverted, timed out or unknown; a broadcast whose acceptance is unknown; an
// intent found incomplete or unresolved on restart; a transaction of ours in
// flight at startup; an exception inside a switch; a ledger write that fails
// mid-fill. What does NOT latch (a plain veto, re-evaluated next tick): the
// minimum hold, the daily switch count, notional bounds, stale tape or
// candles, degraded data, a stale quote or balances, a changed candidate, the
// exhausted inference budget (resets at UTC midnight), a KILL file (the
// owner's brake), our own transaction pending in the mempool.
import { RecordableError } from './errors.mjs';
import { cfg as defaultCfg } from './config.mjs';

const finite = (v) => Number.isFinite(v);

/** The latched risk state: the reason a loss limit is crossed, or null. Independent of any candidate (R1-E). */
export function riskBreach(stats, cfg = defaultCfg) {
  if (finite(stats?.totalNetPnlPct) && stats.totalNetPnlPct <= -cfg.killLossPct) return `total net loss ${stats.totalNetPnlPct.toFixed(2)}% beyond the kill limit ${cfg.killLossPct}%`;
  if (finite(stats?.dailyNetPnlPct) && stats.dailyNetPnlPct <= -cfg.maxDailyLossPct) return `daily net loss ${stats.dailyNetPnlPct.toFixed(2)}% beyond the daily limit ${cfg.maxDailyLossPct}%`;
  return null;
}

export class VoteWindow {
  constructor(cfg = defaultCfg) {
    this.cfg = cfg;
    this.size = cfg.voteWindow;
    this.items = []; // { summary, at }
  }

  push(summary, at) {
    if (!finite(at)) throw new RecordableError('a vote needs a timestamp');
    this.items.push({ summary, at });
    if (this.items.length > this.size) this.items.shift();
  }

  clear() { this.items = []; }

  votesFor(target) { return this.items.filter((v) => agreesWith(v.summary, target, this.cfg)).length; }

  /** The candidate the last `size` judgments support, or null with the reason. Votes must be recent and gap-free. */
  candidate(position, now) {
    const votes = { ETH: this.votesFor('ETH'), USDC: this.votesFor('USDC') };
    if (this.items.length < this.size) return { target: null, votes, reason: 'window not full' };
    if (!finite(now)) return { target: null, votes, reason: 'no clock' };
    const oldest = this.items[0].at;
    if (now - oldest > this.cfg.voteMaxSpanMs) return { target: null, votes, reason: `votes span ${Math.round((now - oldest) / 1000)} s, older than ${Math.round(this.cfg.voteMaxSpanMs / 1000)} s` };
    for (let i = 1; i < this.items.length; i += 1) {
      if (this.items[i].at - this.items[i - 1].at > this.cfg.voteMaxGapMs) return { target: null, votes, reason: 'gap between judgments' };
    }
    if (now - this.items[this.items.length - 1].at > this.cfg.voteMaxGapMs) return { target: null, votes, reason: 'latest judgment too old' };
    if (position.side !== 'ETH' && votes.ETH >= this.cfg.voteMin) return { target: 'ETH', votes, reason: `${votes.ETH}/${this.size} judgments agree` };
    if (position.side !== 'USDC' && votes.USDC >= this.cfg.voteMin) return { target: 'USDC', votes, reason: `${votes.USDC}/${this.size} judgments agree` };
    return { target: null, votes, reason: 'no majority for a switch' };
  }
}

/**
 * Does one judgment vote for `target`? Two bases (VOTE_BASIS, set by the preset):
 * - forecast: the judge calls the matching trend regime AND expects the matching 15-minute move with
 *   probability ≥ minDirectionP AND rates the moment acceptable (VOTE_ACCEPT_QUALITY, default good only);
 * - regime: the judge's regime call is the vote when it holds ≥ minRegimeP of the probability mass; a
 *   confident contrary 15-minute forecast (≥ minDirectionP) vetoes it; the 15-minute switch quality is not
 *   consulted, because it rates a horizon this basis does not trade.
 * Both: risk-off above the ceiling never votes; a non-finite probability never votes.
 */
export function agreesWith(s, target, cfg = defaultCfg) {
  if (!s || !finite(s.riskOffP) || !finite(s.directionP)) return false;
  if (s.riskOffP > cfg.maxRiskOffP) return false;
  if (target !== 'ETH' && target !== 'USDC') return false;
  const regime = target === 'ETH' ? 'trend_up' : 'trend_down';
  if (s.regime !== regime) return false;
  if ((cfg.voteBasis ?? 'forecast') === 'regime') {
    if (!finite(s.regimeP) || s.regimeP < (cfg.minRegimeP ?? 0.5)) return false;
    const contrary = target === 'ETH' ? 'down' : 'up';
    return !(s.direction === contrary && s.directionP >= cfg.minDirectionP);
  }
  if (!(cfg.voteAcceptQuality ?? ['good']).includes(s.quality)) return false;
  return s.direction === (target === 'ETH' ? 'up' : 'down') && s.directionP >= cfg.minDirectionP;
}

/** Deterministic trend filter on 5-minute candles: the switch must agree with EMA20 vs EMA50. Unknown → refuse. */
export function trendFilter(features, target) {
  const spread = features?.emaSpreadPct;
  if (!finite(spread)) return { ok: false, reason: 'trend filter: EMA unavailable' };
  if (target === 'ETH' && spread <= 0) return { ok: false, reason: 'trend filter: EMA20 not above EMA50' };
  if (target === 'USDC' && spread >= 0) return { ok: false, reason: 'trend filter: EMA20 not below EMA50' };
  if (target !== 'ETH' && target !== 'USDC') return { ok: false, reason: 'trend filter: unknown target' };
  return { ok: true };
}

/**
 * The optional breakout condition (BREAKOUT_MIN_PCT > 0): a switch to USDC needs the price at least that many
 * percent BELOW the low of the closed candles of the lookback window, a switch to ETH the same ABOVE its high.
 * Judgments a minute apart see almost the same state, so agreeing votes are one opinion repeated; this makes the
 * candidate depend on new information. A missing or stale range vetoes. Deterministic; no model involved.
 */
export function breakoutFilter(features, target, cfg = defaultCfg) {
  const pct = cfg.breakoutMinPct;
  if (!finite(pct) || pct <= 0) return { ok: true, skipped: true };
  const range = features?.[`range${cfg.breakoutLookbackMin / 60}h`];
  const price = features?.price;
  if (!range || !finite(range.high) || !finite(range.low) || !finite(price)) return { ok: false, reason: `breakout filter: ${cfg.breakoutLookbackMin}-min range unavailable` };
  const minutes = cfg.breakoutLookbackMin;
  if (target === 'USDC') {
    const bar = range.low * (1 - pct / 100);
    if (price > bar) return { ok: false, reason: `breakout filter: price ${price.toFixed(2)} is not ${pct}% below the ${minutes}-min low ${range.low.toFixed(2)} (bar ${bar.toFixed(2)})` };
    return { ok: true, bar, low: range.low };
  }
  if (target === 'ETH') {
    const bar = range.high * (1 + pct / 100);
    if (price < bar) return { ok: false, reason: `breakout filter: price ${price.toFixed(2)} is not ${pct}% above the ${minutes}-min high ${range.high.toFixed(2)} (bar ${bar.toFixed(2)})` };
    return { ok: true, bar, high: range.high };
  }
  return { ok: false, reason: 'breakout filter: unknown target' };
}

/**
 * Hard limits. Every one is a veto that no model can lift. Every input must be
 * a finite number or a known value; anything unknown vetoes.
 */
export function limits({ now, features, position, stats, notionalUsd }, cfg = defaultCfg) {
  const problems = [];
  const need = (name, v) => { if (!finite(v)) problems.push(`${name} unknown`); };
  need('now', now); need('notionalUsd', notionalUsd);
  need('tape age', features?.tapeEventAgeSec); need('candles age', features?.candlesEventAgeSec);
  need('switchesToday', stats?.switchesToday);
  if (problems.length) return { ok: false, problems };
  if (features.tapeEventAgeSec > cfg.maxDataAgeSec) problems.push(`tape stale (${features.tapeEventAgeSec.toFixed(0)} s)`);
  if (features.candlesEventAgeSec > cfg.maxCandleAgeSec) problems.push('candles stale');
  if (features.dataQuality?.degraded) problems.push(`data degraded: ${features.dataQuality.reasons.join('; ')}`);
  if (stats.halt) problems.push(`halted: ${stats.halt.reason ?? stats.halt} (reset with --reset-halt)`);
  if (stats.pendingSwitches > 0) problems.push(`${stats.pendingSwitches} switch(es) pending or unresolved`);
  if (finite(stats.totalNetPnlPct) && stats.totalNetPnlPct <= -cfg.killLossPct) problems.push(`total net loss ${stats.totalNetPnlPct.toFixed(1)}% beyond the kill limit ${cfg.killLossPct}%`);
  if (finite(stats.dailyNetPnlPct) && stats.dailyNetPnlPct <= -cfg.maxDailyLossPct) problems.push(`daily net loss ${stats.dailyNetPnlPct.toFixed(1)}% beyond the daily limit ${cfg.maxDailyLossPct}%`);
  const inferenceCommittedUsd = finite(stats.inferenceBudgetCommittedUsd) ? stats.inferenceBudgetCommittedUsd : stats.inferenceTodayUsd;
  if (finite(inferenceCommittedUsd) && inferenceCommittedUsd >= cfg.inferenceBudgetUsdPerDay) problems.push(`inference budget commitment $${inferenceCommittedUsd.toFixed(2)} at the daily budget $${cfg.inferenceBudgetUsdPerDay}`);
  if (stats.switchesToday >= cfg.maxSwitchesPerDay) problems.push(`switches today ${stats.switchesToday} at the daily maximum`);
  if (finite(position?.lastSwitchAt) && now - position.lastSwitchAt < cfg.minHoldMinutes * 60_000) problems.push(`minimum hold ${cfg.minHoldMinutes} min not reached`);
  if (notionalUsd < cfg.minNotionalUsd) problems.push(`notional $${notionalUsd.toFixed(2)} below the $${cfg.minNotionalUsd} minimum`);
  if (notionalUsd > cfg.maxCapitalUsd) problems.push(`notional $${notionalUsd.toFixed(2)} above the pilot cap $${cfg.maxCapitalUsd}`);
  return { ok: problems.length === 0, problems };
}
