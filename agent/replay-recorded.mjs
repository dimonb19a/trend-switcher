#!/usr/bin/env node
// A replay with a RECORDED judge: the answers a finished replay paid for, played back at the same simulated instants,
// so a change of rule (STRATEGY, REENTRY, BREAKOUT_*, limits) can be screened over the same window without a single new
// judge call. Everything else is the real thing — feed, features, votes, filters, limits, latches, fills, ledger.
//
// How an answer is found: by the market part of the state text (every line but "Position:" and "Execution cost:", the
// two that depend on the bot's own path). At the same instant the market part is the same text, so with the source's
// own settings the replay reproduces the source exactly — run that first and compare the switches.
//
// What it cannot say: the judge gave those answers while it saw the SOURCE bot's position line. Where the new rule holds
// the other side, the answer is the one given to the other position (the report counts those ticks as `otherSide`). The
// regime vote does not read the position, but the model sees it; treat a result as a screening, and confirm a rule you
// want to keep with a replay that pays the judge.
//
//   node agent/replay-recorded.mjs --source data/replay-....db --from ... --to ... --minutes ... --candles ...
//   (the environment of the rule to screen, MODE=paper, PAPER_CAPITAL_USD and TICK_MS as the source, a fresh AGENT_DB_PATH;
//    no judge key is read)
//
// Two controls for the question "is it the judge or the rules?", both free as well:
//   --shuffle-seed N   a RANDOM judge that switches as often as the real one: the recorded answers are cut into runs of
//                      "votes for a sale" and "does not", the runs of each kind are put in a random order and interleaved
//                      again. Every seed keeps the real number of sale votes, the real number of changes of mind and the
//                      real run lengths; only where they fall against the market is random. Run many seeds and see where
//                      the real result stands among them.
//   --constant-down    NO judge: one fixed answer at every tick, "the trend is down", so a sale is decided by the
//                      deterministic conditions alone (no --source needed).
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cfg as defaultCfg, describeConfig } from './config.mjs';
import { agreesWith } from './policy.mjs';
import { runReplay } from './replay.mjs';
import { summarize as defaultSummarize } from './judge.mjs';
import { readHistory, sha256File } from './history-fetch.mjs';
import { RecordableError, describeError } from './errors.mjs';

const pathDependent = (line) => line.startsWith('Position:') || line.startsWith('Execution cost:');
/** The market part of a state text: what is the same at the same instant whatever the bot holds. */
export const marketKey = (state) => state.split('\n').filter((l) => !pathDependent(l)).join('\n');
const sideSeen = (state) => (state.split('\n').find((l) => l.startsWith('Position:')) ?? '').split('(')[0].trim();

/** The judgments of a finished replay ledger (an open node:sqlite handle or a path), in time order. */
export function loadRecordedJudgments(source) {
  const db = typeof source === 'string' ? new DatabaseSync(source, { readOnly: true }) : source;
  try {
    return db.prepare(`SELECT j.ts, j.state, j.answers, j.summary, j.error, j.cost_usd, j.ms, j.model, j.request_at, j.response_at, i.usage
      FROM judgments j LEFT JOIN inference_calls i ON i.ts = j.ts AND i.provider = 'judge' ORDER BY j.id`).all();
  } finally { if (typeof source === 'string') db.close(); }
}

/**
 * A judge that answers from the record: { judge, summarize, stats }. A state with no recorded answer throws a judge error
 * (the engine clears the votes, as for any failed call) and is counted as a miss; a recorded failure is replayed as one.
 */
export function createRecordedJudge(rows, { summarize = defaultSummarize } = {}) {
  const book = new Map();
  for (const r of rows) { const k = marketKey(r.state); if (!book.has(k)) book.set(k, []); book.get(k).push(r); }
  const stats = { recorded: rows.length, calls: 0, misses: 0, errorsReplayed: 0, otherSide: 0, summaryMismatches: 0 };
  let lastSummary = null; // the engine summarizes right after each call: hand it the summary it computed then
  return {
    stats,
    unused: () => [...book.values()].reduce((n, list) => n + list.length, 0),
    async judge(stateText) {
      stats.calls += 1;
      const list = book.get(marketKey(stateText));
      if (!list || !list.length) { stats.misses += 1; throw Object.assign(new Error('recorded judge: no answer was recorded for this state'), { costUsd: 0 }); }
      const r = list.shift();
      if (sideSeen(r.state) !== sideSeen(stateText)) stats.otherSide += 1;
      const usage = r.usage ? JSON.parse(r.usage) : null;
      if (r.error) { stats.errorsReplayed += 1; throw Object.assign(new Error(r.error), { costUsd: r.cost_usd, usage, model: r.model, ms: r.ms }); }
      const answers = JSON.parse(r.answers);
      lastSummary = r.summary ? JSON.parse(r.summary) : null;
      try { if (r.summary && JSON.stringify(summarize(answers)) !== r.summary) stats.summaryMismatches += 1; } catch { stats.summaryMismatches += 1; } // a diagnostic only
      return { model: r.model, answers, usage, costUsd: r.cost_usd, ms: r.ms, requestAt: r.request_at, responseAt: r.response_at };
    },
    summarize(answers) { const recorded = lastSummary; lastSummary = null; return recorded ?? summarize(answers); },
  };
}

/** A small seeded generator (mulberry32): the same seed gives the same order on every machine. */
function seeded(seed) {
  let a = Math.imul(seed, 2654435761) | 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffled = (list, rand) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const summaryOf = (row) => (row.error || !row.summary ? null : JSON.parse(row.summary));

/**
 * The recorded answers in a random order that keeps how often the judge votes for a sale and how often it changes its
 * mind: the rows are cut into runs (consecutive rows that vote for a sale, consecutive rows that do not; a failed reply
 * belongs to the second kind and stays a failure), the runs of each kind are permuted, and the kinds alternate as they
 * did. Returns { rows, down, runs }. `votesDown(summary)` decides what a vote for a sale is (the configured vote rule).
 */
export function shuffleRuns(rows, { seed, votesDown = (summary) => agreesWith(summary, 'USDC', defaultCfg) } = {}) {
  if (!Number.isInteger(seed) || seed < 1) throw new RecordableError('a shuffle needs a whole seed, 1 or more');
  const marked = rows.map((row) => { const summary = summaryOf(row); return { row, down: summary !== null && votesDown(summary) === true }; });
  const runs = [];
  for (const m of marked) { const last = runs[runs.length - 1]; if (last && last.down === m.down) last.items.push(m.row); else runs.push({ down: m.down, items: [m.row] }); }
  const rand = seeded(seed);
  const downs = shuffled(runs.filter((r) => r.down), rand); const others = shuffled(runs.filter((r) => !r.down), rand);
  let d = 0; let o = 0;
  const order = runs.map((r) => (r.down ? downs[d++] : others[o++]));
  return { rows: order.flatMap((r) => r.items), down: marked.filter((m) => m.down).length, runs: runs.length };
}

/** A judge that plays the shuffled record back in order, one row per call: { judge, summarize, stats }. */
export function createShuffledJudge(rows, { seed, votesDown, summarize = defaultSummarize } = {}) {
  const mixed = shuffleRuns(rows, { seed, votesDown });
  const stats = { recorded: rows.length, down: mixed.down, runs: mixed.runs, seed, calls: 0, misses: 0, errorsReplayed: 0 };
  let lastSummary = null;
  return {
    stats,
    async judge() {
      const r = mixed.rows[stats.calls]; stats.calls += 1;
      if (!r) { stats.misses += 1; throw Object.assign(new Error('shuffled judge: the record is shorter than this window'), { costUsd: 0 }); }
      const usage = r.usage ? JSON.parse(r.usage) : null;
      if (r.error || !r.summary) { stats.errorsReplayed += 1; throw Object.assign(new Error(r.error ?? 'shuffled judge: a record without a summary'), { costUsd: r.cost_usd, usage, model: r.model, ms: r.ms }); }
      lastSummary = JSON.parse(r.summary);
      return { model: r.model, answers: JSON.parse(r.answers), usage, costUsd: r.cost_usd, ms: r.ms, requestAt: r.request_at, responseAt: r.response_at };
    },
    summarize(answers) { const recorded = lastSummary; lastSummary = null; return recorded ?? summarize(answers); },
  };
}

/** No judge at all: the same confident "the trend is down" at every tick, free. The vote for a sale is always there. */
export function createConstantJudge() {
  const summary = Object.freeze({ regime: 'trend_down', regimeP: 1, direction: 'down', directionP: 1, upP: 0, downP: 1, quality: 'good', qualityP: 1, riskOffP: 0 });
  const stats = { calls: 0 };
  return {
    stats, summary,
    async judge() { stats.calls += 1; return { model: 'constant:trend_down', answers: { constant: 'trend_down' }, usage: null, costUsd: 0, ms: 0, requestAt: null, responseAt: null }; },
    summarize() { return { ...summary }; },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({ options: {
    source: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, minutes: { type: 'string' }, candles: { type: 'string' },
    'warmup-hours': { type: 'string', default: '26' }, label: { type: 'string', default: '' },
    'shuffle-seed': { type: 'string' }, 'constant-down': { type: 'boolean', default: false },
  } });
  const log = (message, extra) => console.log(`[${new Date().toISOString()}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  const refuse = (why) => { console.error(`refusing to replay with a recorded judge: ${why}`); process.exit(2); };
  const constant = args['constant-down'] === true;
  const seed = args['shuffle-seed'] === undefined ? null : Number(args['shuffle-seed']);
  if (constant && seed !== null) refuse('--constant-down and --shuffle-seed are two different controls: choose one');
  if (seed !== null && (!Number.isInteger(seed) || seed < 1)) refuse('--shuffle-seed must be a whole number, 1 or more');
  if (!constant && (!args.source || !existsSync(args.source))) refuse('--source must be a finished replay ledger');
  const fromMs = Date.parse(args.from ?? ''); const toMs = Date.parse(args.to ?? '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) refuse('--from and --to must be ISO instants (the source window, or a part of it)');
  if (!args.minutes || !args.candles) refuse('--minutes and --candles: the history files the source used');
  if ([defaultCfg.databasePath, `${defaultCfg.databasePath}-wal`].some(existsSync)) refuse('choose a fresh AGENT_DB_PATH');
  const rows = constant ? [] : loadRecordedJudgments(resolve(args.source));
  const recorded = constant ? createConstantJudge() : seed !== null ? createShuffledJudge(rows, { seed }) : createRecordedJudge(rows);
  const control = constant ? 'a constant judge: the trend is down at every tick' : seed !== null ? `a random judge: the recorded answers shuffled by runs, seed ${seed}` : null;
  let impactTable = null;
  if (process.env.REPLAY_IMPACT_TABLE_BPS) { try { impactTable = JSON.parse(process.env.REPLAY_IMPACT_TABLE_BPS); } catch { refuse('REPLAY_IMPACT_TABLE_BPS is not JSON'); } }
  const minutes = readHistory(resolve(args.minutes)); const fiveMinutes = readHistory(resolve(args.candles));
  log(control ? 'control replay starting' : 'recorded-judge replay starting', { control, source: constant ? null : resolve(args.source), recorded: rows.length, strategy: defaultCfg.strategy, reentry: defaultCfg.reentry, db: defaultCfg.databasePath });
  try {
    await runReplay({
      minutes, fiveMinutes, fromMs, toMs, warmupMs: Number(args['warmup-hours']) * 3600_000, judge: recorded, judgeEnabled: true, impactTable,
      meta: { label: args.label, ...(control ? { control } : {}),
        ...(constant ? {} : { recordedJudge: { source: resolve(args.source), sha256: sha256File(resolve(args.source)), caveat: 'answers recorded while the judge saw the source bot\'s position; a screening, not a paid replay' } }), config: describeConfig(defaultCfg) },
      log: (m, extra) => { if (/^replay (ended|failed)/u.test(m)) log(m, extra); },
    });
  } catch (error) { log('replay failed', { error: describeError(error) }); process.exitCode = 1; }
  log(control ? 'control judge' : 'recorded judge', { ...recorded.stats, ...(recorded.unused ? { unused: recorded.unused() } : {}) });
  if (recorded.stats.misses > 0) { log('some states had no recorded answer: the window, the history or the settings that shape the state differ from the source'); process.exitCode = 1; }
}
