#!/usr/bin/env node
// Replay: the live engine, policy and judge over historical candles under a simulated clock, as a
// paper session into a fresh ledger that report.mjs reads like any other. What is replaced: the feed
// (replay-feed.mjs: candles become a tape, each minute observable only once it has closed), the
// chain (replay-chain.mjs: a cost scenario and a next-minute-open fill instead of a quoter), the
// state text (the date line is hidden from both models). What is not: the features, the vote window,
// the filters, the limits, the risk latches, the ledger, the report.
//
// The simulated clock is the engine's and the ledger's one clock; a tick's model calls take real
// seconds while the simulated instant stands still. The daily-loss latch, which live waits for the
// owner's --reset-halt, is lifted at the next simulated UTC midnight, because a replay has no owner
// at the keyboard; the kill latch (total loss) and any switch-level halt are never lifted here.
//
// What a replay cannot say: the models may have seen the period in their training (the date is
// hidden, the price level is not); the fill is a scenario, not a historical quote; a treadmill of
// candles is not a live tape. The report names all three.
//
//   node agent/replay.mjs --from 2021-05-01T00:00:00Z --to 2021-06-01T00:00:00Z \
//     --minutes data/history/ETH-USD-60s-....jsonl --candles data/history/ETH-USD-300s-....jsonl [--warmup-hours 26] [--no-judge]
//   (MODE=paper, PAPER_CAPITAL_USD, TICK_MS 60000 or 300000, AGENT_DB_PATH fresh, the judge environment, REQUIRE_DEEPSEEK=false unless a key is given)
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg as defaultCfg, describeConfig } from './config.mjs';
import { openLedger } from './ledger.mjs';
import { createEngine } from './engine.mjs';
import * as deepseek from './deepseek.mjs';
import { ReplayFeed, MINUTE_MS } from './replay-feed.mjs';
import { createReplayChain, IMPACT_TABLE_BPS, POOL_FEE_PCT } from './replay-chain.mjs';
import { createReplayJudge, renderStateHiddenDate, HIDDEN_TIME_LINE } from './replay-judge.mjs';
import { gapsOf, readHistory, sha256File } from './history-fetch.mjs';
import { RecordableError, describeError } from './errors.mjs';

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The replay's midnight rule: a latched DAILY loss limit is lifted when the simulated UTC day changes,
 * and nothing else is — the kill limit, a switch-level halt, an UNKNOWN bill keep their latch.
 * Returns true when a latch was lifted.
 */
export function liftDailyLatchAtMidnight(ledger, mode = 'paper') {
  const halt = ledger.kv.get(`halt:${mode}`);
  if (!halt || typeof halt.reason !== 'string') return false;
  if (!/daily net loss/u.test(halt.reason) || /kill limit/u.test(halt.reason)) return false;
  if (ledger.requiredHalts().length > 0) return false;
  ledger.resetHalt();
  return true;
}

/**
 * Run one replay. Everything is injectable for the tests; the CLI below wires the real judge and the
 * slow brain. Returns the manifest written to the ledger.
 */
export async function runReplay({
  cfg = defaultCfg, minutes, fiveMinutes, fromMs, toMs, warmupMs = 26 * 3600_000,
  judge, slowBrain = deepseek, judgeEnabled = true, log = () => {}, onTick = null, meta = {}, keepLedgerOpen = false,
}) {
  const tickMs = cfg.tickMs;
  if (cfg.mode !== 'paper') throw new RecordableError('a replay is paper only');
  if (cfg.paperCapitalUsd === null) throw new RecordableError('a replay needs PAPER_CAPITAL_USD (a virtual capital)');
  if (tickMs % MINUTE_MS !== 0) throw new RecordableError('TICK_MS must be a whole number of minutes in a replay (60000 or 300000)');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new RecordableError('the window must be non-empty');
  if (fromMs % tickMs !== 0) throw new RecordableError('the window start must be aligned to the tick');
  if (minutes[0].t > fromMs - warmupMs) throw new RecordableError(`the minute history starts at ${new Date(minutes[0].t).toISOString()}, after the warm-up start ${new Date(fromMs - warmupMs).toISOString()}`);
  if (minutes[minutes.length - 1].t + MINUTE_MS < toMs) throw new RecordableError('the minute history ends before the window does');

  let now = fromMs - warmupMs;
  const clock = () => now; // the one clock of the engine and the ledger (R1-A), simulated
  const ledger = openLedger(cfg, { clock });
  let keep = false;
  try {
    const feed = new ReplayFeed({ minutes, fiveMinutes });
    const chain = createReplayChain({ minutes, clock, cfg });
    const engine = createEngine({
      cfg, armed: false, chain, ledger, feed, judge, slowBrain, arms: null, clock, log,
      judgeEnabled, canAct: () => true, captureInputs: false, renderState: renderStateHiddenDate,
    });
    now = fromMs; feed.advanceTo(now); // the warm-up: context only, no decision, no row
    const recovered = await engine.recoverPending();
    if (recovered.halt || recovered.unresolvedLegs || recovered.unbookedLegs) throw new RecordableError('a replay needs a fresh ledger');
    const planned = Math.ceil((toMs - fromMs) / tickMs);
    const manifest = {
      status: 'running', startedAt: new Date(fromMs).toISOString(), deadlineAt: new Date(toMs).toISOString(), tickMs, plannedSlots: planned,
      attemptedSlots: 0, missedSlots: 0, unattemptedSlots: 0, completedSlots: 0, stopReason: null, endedAt: null,
      configHash: ledger.provenance?.configHash ?? null, sourceHash: ledger.provenance?.sourceHash ?? null,
      replay: {
        kind: 'historical replay', warmupHours: warmupMs / 3600_000, hiddenDateLine: HIDDEN_TIME_LINE,
        fill: 'open of the minute that starts at the decision instant, times the scenario; the engine adds its expected slippage',
        costScenario: { poolFeePct: POOL_FEE_PCT, impactBpsByNotionalUsd: IMPACT_TABLE_BPS.map(([n, b]) => ({ notionalUsd: n, bps: b })), measuredOn: '2026-10-02 Base WETH/USDC 0.05 % QuoterV2 round trips' },
        midnightRule: 'a latched daily loss limit is lifted at the next simulated UTC midnight; kill and switch-level halts never',
        dailyLatchLifts: 0, syntheticCandles: 0, missingMinutes: 0, judgeErrors: 0, wallSeconds: null, ...meta,
      },
    };
    ledger.kv.set('session:paper', manifest);
    const startedWall = Date.now();
    let lastDay = dayOf(fromMs);
    let index = 0;
    for (let t = fromMs; t < toMs; t += tickMs, index += 1) {
      now = t;
      feed.advanceTo(t);
      const day = dayOf(t);
      if (day !== lastDay) { lastDay = day; if (liftDailyLatchAtMidnight(ledger, cfg.mode)) { manifest.replay.dailyLatchLifts += 1; log('daily-loss latch lifted at simulated midnight', { day }); } }
      manifest.attemptedSlots += 1;
      let out;
      try { out = await engine.tick(); } catch (error) { out = { error: describeError(error) }; }
      manifest.completedSlots += 1;
      if (out?.error) { manifest.stopReason = out.error; log('replay stopped on an engine error', { error: out.error }); break; }
      if (onTick) onTick({ index, t, out });
      if (index % 288 === 0) ledger.kv.set('session:paper', { ...manifest, wallSecondsSoFar: Math.round((Date.now() - startedWall) / 1000) });
    }
    manifest.unattemptedSlots = planned - manifest.attemptedSlots;
    manifest.stopReason ??= 'deadline';
    manifest.status = manifest.stopReason === 'deadline' ? 'completed' : 'stopped';
    now = Math.min(toMs, now);
    engine.finalizeValuation('session end');
    manifest.endedAt = new Date(toMs).toISOString();
    const snap = feed.snapshot(now);
    manifest.replay.syntheticCandles = snap.syntheticCandles;
    manifest.replay.missingMinutes = feed.missingMinutes;
    manifest.replay.judgeErrors = ledger.db.prepare('SELECT COUNT(*) AS n FROM judgments WHERE error IS NOT NULL').get().n;
    manifest.replay.wallSeconds = Math.round((Date.now() - startedWall) / 1000);
    manifest.replay.chainCalls = chain.calls;
    ledger.kv.set('session:paper', manifest);
    ledger.observe('session', manifest);
    log('replay ended', { status: manifest.status, slots: manifest.completedSlots, wallSeconds: manifest.replay.wallSeconds, totals: ledger.totals() });
    keep = keepLedgerOpen;
    return { manifest, ledger: keepLedgerOpen ? ledger : null };
  } finally {
    if (!keep) ledger.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      from: { type: 'string' }, to: { type: 'string' }, minutes: { type: 'string' }, candles: { type: 'string' },
      'warmup-hours': { type: 'string', default: '26' }, 'no-judge': { type: 'boolean', default: false }, label: { type: 'string', default: '' },
    },
  });
  const log = (message, extra) => console.log(`[${new Date().toISOString()}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  const refuse = (why) => { console.error(`refusing to replay: ${why}`); process.exit(2); };
  const fromMs = Date.parse(args.from ?? ''); const toMs = Date.parse(args.to ?? '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) refuse('--from and --to must be ISO instants');
  if (!args.minutes || !args.candles) refuse('--minutes and --candles (canonical history files) are required');
  if (defaultCfg.mode !== 'paper') refuse('MODE must be paper');
  if (defaultCfg.paperCapitalUsd === null) refuse('PAPER_CAPITAL_USD is required');
  if (!args['no-judge'] && (!defaultCfg.judgeBaseUrl || !defaultCfg.judgeModel)) refuse('the judge endpoint and model pin are required (JUDGE_BASE_URL, JUDGE_MODEL) unless --no-judge');
  if ([defaultCfg.databasePath, `${defaultCfg.databasePath}-wal`, `${defaultCfg.databasePath}-shm`].some(existsSync)) refuse('choose a fresh AGENT_DB_PATH');
  if (defaultCfg.requireDeepseek && !defaultCfg.hasDeepseekKey) refuse('REQUIRE_DEEPSEEK=true without a slow-brain key; set REQUIRE_DEEPSEEK=false for a judge-only replay');
  const minutes = readHistory(resolve(args.minutes)); const fiveMinutes = readHistory(resolve(args.candles));
  const judge = createReplayJudge();
  if (!args['no-judge'] && judge.keyStatus() !== 'set') refuse('the judge key is not set');
  const meta = {
    label: args.label, history: {
      minutes: { file: resolve(args.minutes), sha256: sha256File(resolve(args.minutes)), rows: minutes.length, gaps: gapsOf(minutes, MINUTE_MS).length },
      candles: { file: resolve(args.candles), sha256: sha256File(resolve(args.candles)), rows: fiveMinutes.length, gaps: gapsOf(fiveMinutes, 300_000).length },
    },
    slowBrain: defaultCfg.hasDeepseekKey ? 'on' : 'off', config: describeConfig(defaultCfg),
  };
  log('replay starting', { from: args.from, to: args.to, tickMs: defaultCfg.tickMs, capital: defaultCfg.paperCapitalUsd, preset: defaultCfg.riskPreset, breakout: defaultCfg.breakoutMinPct, judge: judge.keyStatus(), slowBrain: meta.slowBrain, db: defaultCfg.databasePath });
  let lastLogAt = Date.now();
  try {
    await runReplay({
      minutes, fiveMinutes, fromMs, toMs, warmupMs: Number(args['warmup-hours']) * 3600_000, judge, judgeEnabled: !args['no-judge'], meta,
      log: (m, extra) => { if (!/^tick /u.test(m)) log(m, extra); },
      onTick: ({ index, t, out }) => { if (Date.now() - lastLogAt > 60_000 || index === 0) { lastLogAt = Date.now(); log(`progress ${new Date(t).toISOString()} slot ${index}`, out?.switched !== undefined ? { switched: out.switched } : undefined); } },
    });
  } catch (error) {
    log('replay failed', { error: describeError(error) });
    process.exitCode = 1;
  }
}
