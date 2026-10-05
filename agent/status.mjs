#!/usr/bin/env node
// One line about a run, for whoever looks in on it once a day: where the position is, what it is worth against
// the start and against holding, what was switched, whether anything is latched, whether the judge answers, and
// how old the last tick is. Reads a ledger read-only, so it is safe on the ledger of a run in progress; it needs
// no `.env`, sends nothing anywhere and prints no model answer.
//
//   node agent/status.mjs --db data/month-bot4.db            one line (ATTENTION first, when something needs a look)
//   node agent/status.mjs --db data/month-bot4.db --json     the same facts as data
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const finite = (v) => Number.isFinite(v);
const parse = (text) => { if (text === null || text === undefined) return null; try { return JSON.parse(text); } catch { return null; } };
const worstDrop = (xs) => { let peak = -Infinity; let d = 0; for (const x of xs) { if (!finite(x)) continue; peak = Math.max(peak, x); if (peak > 0) d = Math.max(d, (peak - x) / peak * 100); } return d; };

/** The facts of the line. `db` is an open node:sqlite handle (or give `path`); `now` in milliseconds. */
export function buildStatus({ db = null, path = null, mode = 'paper', now = Date.now() } = {}) {
  const own = !db;
  if (!db) db = new DatabaseSync(path, { readOnly: true });
  try {
    const kv = (key) => parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value);
    const lastHash = db.prepare('SELECT config_hash FROM judgments WHERE mode = ? AND config_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get(mode)?.config_hash ?? null;
    const run = kv(`run:${mode}`); const session = kv(`session:${mode}`);
    const cfg = lastHash ? kv(`config:${lastHash}`) : (run?.configHash ? kv(`config:${run.configHash}`) : session?.configHash ? kv(`config:${session.configHash}`) : null);
    const initial = kv(`initial:${mode}`); const paper = kv('paper:balances'); const halt = kv(`halt:${mode}`);
    const vals = db.prepare("SELECT ts, payload FROM observations WHERE mode = ? AND kind = 'valuation' ORDER BY id").all(mode)
      .map((r) => { const v = parse(r.payload) ?? {}; return { ts: r.ts, net: v.walletUsd - (v.externalUsd ?? 0), price: v.price, ethSide: v.ethSide, usdc: v.usdc }; })
      .filter((v) => finite(v.net) && finite(v.price));
    const start = initial?.walletUsd ?? initial?.equityUsd ?? cfg?.paperCapitalUsd ?? null;
    const p0 = paper?.openingPrice ?? vals[0]?.price ?? null;
    const last = vals.at(-1) ?? null;
    const switches = db.prepare("SELECT ts, to_side FROM switches WHERE mode = ? AND status = 'done' ORDER BY id").all(mode);
    const dayAgo = new Date(now - 86_400_000).toISOString();
    const judge24 = db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(error IS NOT NULL), 0) AS errors FROM judgments WHERE mode = ? AND ts >= ?').get(mode, dayAgo);
    const judgeAll = db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(error IS NOT NULL), 0) AS errors FROM judgments WHERE mode = ?').get(mode);
    const unknown = db.prepare("SELECT COUNT(*) AS n FROM inference_calls WHERE mode = ? AND billing = 'UNKNOWN'").get(mode).n;
    const lifts = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE mode = ? AND kind = 'latch'").get(mode).n;
    const lastTick = db.prepare("SELECT ts FROM observations WHERE mode = ? AND kind = 'tick' ORDER BY id DESC LIMIT 1").get(mode)?.ts ?? null;
    const blind24 = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE mode = ? AND kind = 'tick' AND ts >= ? AND (payload LIKE '%\"stale\":true%' OR payload LIKE '%\"waiting\":true%')").get(mode, dayAgo).n;
    const tickMs = cfg?.tickMs ?? run?.tickMs ?? session?.tickMs ?? null;
    const lastTickAgeMs = lastTick ? now - Date.parse(lastTick) : null;
    const side = last ? (last.ethSide * last.price >= last.usdc ? 'ETH' : 'USDC') : null;
    const until = run?.until ?? session?.deadlineAt ?? null;
    const over = until ? now >= Date.parse(until) : false;
    const status = {
      at: new Date(now).toISOString(), mode, strategy: cfg?.strategy ?? null, asset: cfg?.market?.asset ?? 'ETH', agentVersion: cfg?.version ?? null, tickMs,
      side, netUsd: last?.net ?? null, startUsd: start, netPct: last && finite(start) && start > 0 ? (last.net / start - 1) * 100 : null,
      price: last?.price ?? null, openingPrice: p0, holdPct: last && finite(p0) && p0 > 0 ? (last.price / p0 - 1) * 100 : null,
      worstDropPct: vals.length ? worstDrop(vals.map((v) => v.net)) : null, holdWorstDropPct: vals.length ? worstDrop(vals.map((v) => v.price)) : null,
      switches: switches.length, lastSwitch: switches.length ? { at: switches.at(-1).ts, to: switches.at(-1).to_side } : null,
      halt: halt ? { reason: halt.reason ?? String(halt), at: halt.at ?? null } : null, dailyLatchLifts: lifts,
      judge: { calls: judgeAll.calls, errors: judgeAll.errors, calls24h: judge24.calls, errors24h: judge24.errors }, unknownBills: unknown, blindTicks24h: blind24,
      lastTickAt: lastTick, lastTickAgeMs, valuedAt: last?.ts ?? null,
      run: run ? { kind: run.kind, status: run.status, until: run.until, firstStartAt: run.firstStartAt, starts: run.startCount } : session ? { kind: session.replay ? 'replay' : 'timed session', status: session.status, until: session.deadlineAt, firstStartAt: session.startedAt, starts: 1 } : null,
      over,
    };
    // what needs a look: the reader should not have to work it out from the numbers
    const attention = [];
    if (!last) attention.push('no valuation yet');
    if (!over && finite(lastTickAgeMs) && finite(tickMs) && lastTickAgeMs > Math.max(3 * tickMs, 10 * 60_000)) attention.push(`no tick for ${Math.round(lastTickAgeMs / 60_000)} min: the process is not running`);
    if (!over && lastTick === null) attention.push('no tick recorded');
    if (halt && !/daily net loss/u.test(halt.reason ?? '')) attention.push('halted; this latch is not lifted by the calendar');
    else if (halt && cfg?.paperDailyLatchLift !== 'midnight') attention.push('daily loss latched; waits for --reset-halt');
    if (judge24.calls >= 20 && judge24.errors / judge24.calls > 0.2) attention.push(`judge errors on ${Math.round(100 * judge24.errors / judge24.calls)} % of the last day's calls`);
    if (!over && finite(tickMs) && judge24.calls === 0 && finite(lastTickAgeMs) && lastTickAgeMs < 3 * tickMs && (now - Date.parse(status.run?.firstStartAt ?? status.at)) > 3 * tickMs) attention.push('ticks without judge calls: the daily inference budget, or the judge is off');
    if (blind24 >= 12 && finite(tickMs) && blind24 * tickMs > 60 * 60_000) attention.push(`no usable tape on ${blind24} ticks of the last day`);
    if (run && run.startCount > 3 * (1 + Math.floor((now - Date.parse(run.firstStartAt)) / 86_400_000))) attention.push(`${run.startCount} starts: the process keeps restarting`); // more than three a day on average
    status.attention = attention;
    return status;
  } finally { if (own) db.close(); }
}

const money = (v) => (finite(v) ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a');
const pct = (v, d = 2) => (finite(v) ? `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)} %` : 'n/a'); // plain ASCII: the line is read in any console and appended to logs
const minute = (isoText) => (isoText ? `${isoText.slice(0, 16)}Z` : 'n/a');
const age = (ms) => (!finite(ms) ? 'n/a' : ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 2 * 3600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 2 * 86_400_000 ? `${(ms / 3600_000).toFixed(1)} h ago` : `${(ms / 86_400_000).toFixed(1)} days ago`);

/** The line. */
export function renderStatus(s) {
  const parts = [
    `${minute(s.at)} ${s.strategy ?? 'agent'} ${s.asset}/USD${s.agentVersion ? ` v${s.agentVersion}` : ''}`,
    s.side ? `in ${s.side === 'ETH' ? s.asset : 'USDC'}` : 'no position yet',
    `${money(s.netUsd)} ${pct(s.netPct)}`,
    `hold ${pct(s.holdPct)}`,
    `worst drop ${finite(s.worstDropPct) ? s.worstDropPct.toFixed(1) : 'n/a'} % (hold ${finite(s.holdWorstDropPct) ? s.holdWorstDropPct.toFixed(1) : 'n/a'} %)`,
    s.switches ? `${s.switches} switch${s.switches === 1 ? '' : 'es'}, last ${minute(s.lastSwitch.at)} to ${s.lastSwitch.to === 'ETH' ? s.asset : 'USDC'}` : 'no switch',
    s.halt ? `HALT since ${minute(s.halt.at)}: ${s.halt.reason.slice(0, 90)}` : 'no halt',
    `daily latch lifted ${s.dailyLatchLifts} time${s.dailyLatchLifts === 1 ? '' : 's'}`,
    `judge last day ${s.judge.calls24h} calls, ${s.judge.errors24h} errors`,
    `unknown bills ${s.unknownBills}`,
    s.over ? `ended ${minute(s.run?.until)}` : `last tick ${age(s.lastTickAgeMs)}`,
    s.run ? `${s.run.kind} ${s.run.status}${s.run.until ? ` until ${minute(s.run.until)}` : ''}, start ${s.run.starts}` : 'no run record',
  ];
  return `${s.attention.length ? `ATTENTION: ${s.attention.join('; ')} | ` : ''}${parts.join(' | ')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({ options: { db: { type: 'string' }, json: { type: 'boolean', default: false }, mode: { type: 'string', default: 'paper' } } });
  if (!args.db || !existsSync(args.db)) { console.error('usage: node agent/status.mjs --db <ledger file> [--json]'); process.exit(2); }
  const status = buildStatus({ path: resolve(args.db), mode: args.mode });
  console.log(args.json ? JSON.stringify(status, null, 2) : renderStatus(status));
}
