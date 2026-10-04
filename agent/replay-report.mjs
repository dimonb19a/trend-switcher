#!/usr/bin/env node
// The hedge view of one or more replay ledgers, read-only: what the arm did against holding ETH
// over the same window, with the worst drop of each. Everything is a count or a sum over rows the
// engine wrote on its simulated clock; "hold" is the tape itself (the first and last prices the
// engine valued at, and the lowest point between them).
//
//   node agent/replay-report.mjs --db data/replay-a.db [--db data/replay-b.db ...] [--json]
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const finite = (v) => Number.isFinite(v);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const pct = (a, b) => (finite(a) && finite(b) && b !== 0 ? (a / b - 1) * 100 : null);

export function summarizeReplay(path, mode = 'paper') {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const kv = (key) => parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? 'null');
    const session = kv('session:paper'); const paper = kv('paper:balances'); const initial = kv(`initial:${mode}`); const halt = kv(`halt:${mode}`);
    const cfg = (() => { const row = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'config:%' LIMIT 1").get(); return row ? parse(row.value) : null; })();
    const equity = db.prepare('SELECT ts, price, wallet_usd, net_usd FROM equity WHERE mode = ? ORDER BY id').all(mode);
    const valuations = db.prepare("SELECT ts, payload FROM observations WHERE mode = ? AND kind = 'valuation' ORDER BY id").all(mode).map((o) => ({ ts: o.ts, ...parse(o.payload) }));
    const costs = db.prepare('SELECT kind, SUM(usd) AS usd, COUNT(*) AS n FROM costs WHERE mode = ? GROUP BY kind').all(mode);
    const judgments = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN error IS NULL THEN 0 ELSE 1 END) AS errors, COALESCE(SUM(cost_usd),0) AS usd, AVG(ms) AS ms FROM judgments WHERE mode = ?').get(mode);
    const decisions = db.prepare('SELECT stage, outcome, COUNT(*) AS n FROM decisions WHERE mode = ? GROUP BY stage, outcome ORDER BY n DESC').all(mode);
    const switches = db.prepare(`SELECT s.id, s.ts, s.from_side, s.to_side, s.status, s.notional_usd, l.amount_in, l.amount_out_actual, l.token_in, l.token_out, l.price_usd FROM switches s LEFT JOIN legs l ON l.switch_id = s.id WHERE s.mode = ? ORDER BY s.id`).all(mode)
      .map((s) => ({ id: s.id, ts: s.ts, from: s.from_side, to: s.to_side, status: s.status, notionalUsd: s.notional_usd, decisionPrice: s.price_usd,
        fillPrice: s.amount_out_actual && s.amount_in ? (s.token_out === 'USDC' ? s.amount_out_actual / s.amount_in : s.amount_in / s.amount_out_actual) : null }));
    const capital = initial?.walletUsd ?? null;
    const first = equity[0] ?? null; const last = valuations.at(-1) ?? null;
    const startPrice = first?.price ?? null; const endPrice = last?.price ?? equity.at(-1)?.price ?? null;
    const finalWallet = last?.walletUsd ?? equity.at(-1)?.wallet_usd ?? null;
    const external = costs.filter((c) => c.kind !== 'gas').reduce((s, c) => s + c.usd, 0) + (costs.find((c) => c.kind === 'gas')?.usd ?? 0);
    const inference = costs.filter((c) => c.kind === 'judge' || c.kind === 'deepseek').reduce((s, c) => s + c.usd, 0);
    const netUsd = finite(finalWallet) && finite(capital) ? finalWallet - capital - external : null;
    // worst drop: net equity of the arm, and the price path for hold, both from the arm's own valuation rows (same instants)
    const series = (valuations.length ? valuations.map((v) => ({ ts: v.ts, net: v.walletUsd - (v.externalUsd ?? 0), price: v.price })) : equity.map((e) => ({ ts: e.ts, net: e.net_usd, price: e.price })));
    let peakNet = -Infinity; let ddNet = 0; let peakPrice = -Infinity; let ddPrice = 0; let lowest = Infinity; let lowestAt = null;
    for (const s of series) {
      if (finite(s.net)) { peakNet = Math.max(peakNet, s.net); if (peakNet > 0) ddNet = Math.max(ddNet, (peakNet - s.net) / peakNet * 100); }
      if (finite(s.price)) { peakPrice = Math.max(peakPrice, s.price); ddPrice = Math.max(ddPrice, (peakPrice - s.price) / peakPrice * 100); if (s.price < lowest) { lowest = s.price; lowestAt = s.ts; } }
    }
    // the arm's net equity at the hold's lowest point (what the hedge was worth when holding hurt most)
    const atLow = lowestAt ? series.find((s) => s.ts === lowestAt) : null;
    return {
      path, label: session?.replay?.label ?? null, window: session ? { from: session.startedAt, to: session.endedAt ?? session.deadlineAt, tickMs: session.tickMs, slots: session.completedSlots, planned: session.plannedSlots, status: session.status, stopReason: session.stopReason } : null,
      replay: session?.replay ? { warmupHours: session.replay.warmupHours, dailyLatchLifts: session.replay.dailyLatchLifts, syntheticCandles: session.replay.syntheticCandles, missingMinutes: session.replay.missingMinutes, judgeErrors: session.replay.judgeErrors, wallSeconds: session.replay.wallSeconds, slowBrain: session.replay.slowBrain ?? null } : null,
      config: cfg ? { preset: cfg.riskPreset, voteBasis: cfg.voteBasis, voteWindow: cfg.voteWindow, voteMin: cfg.voteMin, breakoutMinPct: cfg.breakoutMinPct, breakoutLookbackMin: cfg.breakoutLookbackMin, maxDailyLossPct: cfg.maxDailyLossPct, killLossPct: cfg.killLossPct, minHoldMinutes: cfg.minHoldMinutes, maxSwitchesPerDay: cfg.maxSwitchesPerDay, capital: cfg.paperCapitalUsd, requireDeepseek: cfg.requireDeepseek, strategy: cfg.strategy ?? null, reentry: cfg.reentry ?? null, reentryMarginPct: cfg.reentryMarginPct ?? null, latchBlocksExits: cfg.riskLatchBlocksExits ?? null, market: cfg.market?.name ?? 'base-eth-usdc', asset: cfg.market?.asset ?? 'ETH' } : null,
      capitalUsd: capital, finalWalletUsd: finalWallet, externalUsd: external, inferenceUsd: inference,
      startPrice, endPrice, holdPct: pct(endPrice, startPrice), netPct: finite(netUsd) && finite(capital) ? netUsd / capital * 100 : null,
      vsHoldPts: finite(netUsd) && finite(capital) && finite(endPrice) && finite(startPrice) ? netUsd / capital * 100 - pct(endPrice, startPrice) : null,
      worstDropArmPct: Math.round(ddNet * 100) / 100, worstDropHoldPct: Math.round(ddPrice * 100) / 100,
      holdLow: { price: finite(lowest) ? lowest : null, at: lowestAt, holdPctAtLow: pct(lowest, startPrice), armNetPctAtLow: atLow && finite(capital) ? (atLow.net / capital - 1) * 100 : null },
      switches, switchesDone: switches.filter((s) => s.status === 'done').length,
      judgments: { calls: judgments.n, errors: judgments.errors, usd: judgments.usd, avgMs: judgments.ms === null ? null : Math.round(judgments.ms) },
      decisions, halt: halt ? { reason: halt.reason, at: halt.at } : null,
      finalSide: paper ? (paper.ethSide * (endPrice ?? 0) >= paper.usdc ? 'ETH' : 'USDC') : null,
    };
  } finally { db.close(); }
}

const money = (v, d = 2) => (finite(v) ? `$${v.toFixed(d)}` : 'n/a');
const p = (v, d = 2) => (finite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)} %` : 'n/a');

export function renderReplay(r) {
  const out = [];
  out.push(`REPLAY — ${r.label || r.path}`);
  if (r.window) out.push(`  window ${r.window.from} → ${r.window.to}, tick ${r.window.tickMs / 1000} s, slots ${r.window.slots}/${r.window.planned} (${r.window.status}, ${r.window.stopReason})`);
  if (r.config?.strategy) out.push(`  strategy ${r.config.strategy}: re-entry ${r.config.reentry}${String(r.config.reentry).startsWith('above-sale') ? ` (${r.config.reentryMarginPct} % above the last sale)` : ''}, a latched loss blocks ${r.config.latchBlocksExits === false ? 'only buying back' : 'every switch'}; market ${r.config.market}`);
  if (r.config) out.push(`  preset ${r.config.preset} (${r.config.voteBasis} ${r.config.voteMin}/${r.config.voteWindow}), breakout ${r.config.breakoutMinPct} % / ${r.config.breakoutLookbackMin} min, daily stop ${r.config.maxDailyLossPct} %, hold ≥ ${r.config.minHoldMinutes} min, ≤ ${r.config.maxSwitchesPerDay}/day, slow brain ${r.replay?.slowBrain ?? (r.config.requireDeepseek ? 'required' : 'off')}`);
  if (r.replay) out.push(`  replay: warm-up ${r.replay.warmupHours} h, daily latch lifted ${r.replay.dailyLatchLifts}×, synthetic candles ${r.replay.syntheticCandles}, missing minutes ${r.replay.missingMinutes}, judge errors ${r.replay.judgeErrors}, wall ${r.replay.wallSeconds} s`);
  out.push(`  ${r.config?.asset ?? 'ETH'} ${money(r.startPrice)} → ${money(r.endPrice)}: hold ${p(r.holdPct)}; low ${money(r.holdLow.price)} at ${r.holdLow.at ?? 'n/a'} (${p(r.holdLow.holdPctAtLow)} from the start; the arm stood at ${p(r.holdLow.armNetPctAtLow)} then)`);
  out.push(`  arm: capital ${money(r.capitalUsd)} → wallet ${money(r.finalWalletUsd)}, external costs ${money(r.externalUsd, 4)} (inference ${money(r.inferenceUsd, 4)}); net ${p(r.netPct)}, against hold ${p(r.vsHoldPts)} pts; ends in ${r.finalSide}`);
  out.push(`  worst drop: arm ${r.worstDropArmPct} % / hold ${r.worstDropHoldPct} %`);
  out.push(`  switches ${r.switchesDone} done of ${r.switches.length}${r.switches.length ? ': ' + r.switches.map((s) => `#${s.id} ${s.ts.slice(0, 16)} ${s.from}→${s.to} ${s.status}${finite(s.fillPrice) ? ` fill ${s.fillPrice.toFixed(2)}` : ''}`).join('; ') : ''}`);
  out.push(`  judge ${r.judgments.calls} calls, ${r.judgments.errors ?? 0} errors, ${money(r.judgments.usd, 4)}, avg ${r.judgments.avgMs ?? 'n/a'} ms; decisions ${r.decisions.map((d) => `${d.stage}:${d.outcome} ${d.n}`).join(', ') || 'none'}; halt ${r.halt ? `${r.halt.reason} at ${r.halt.at}` : 'none'}`);
  return out.join('\n');
}

export function renderComparison(rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const out = [line(['arm', 'window', 'switches', 'net', 'hold', 'vs hold', 'worst drop arm / hold', 'arm at hold low', 'judge calls', 'inference'])];
  out.push(line(Array(10).fill('---')));
  for (const r of rows) out.push(line([r.label || r.path, r.window ? `${r.window.from.slice(0, 10)}→${r.window.to.slice(0, 10)}` : 'n/a', String(r.switchesDone), p(r.netPct), p(r.holdPct), `${p(r.vsHoldPts)} pts`, `${r.worstDropArmPct} % / ${r.worstDropHoldPct} %`, p(r.holdLow.armNetPctAtLow), String(r.judgments.calls), money(r.inferenceUsd, 4)]));
  return out.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('replay-report.mjs')) {
  const { values } = parseArgs({ options: { db: { type: 'string', multiple: true }, json: { type: 'boolean', default: false } } });
  if (!values.db?.length) { console.error('--db <ledger> (repeatable) is required'); process.exit(2); }
  const rows = values.db.map((path) => summarizeReplay(path));
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else { for (const r of rows) { console.log(renderReplay(r)); console.log(''); } if (rows.length > 1) console.log(renderComparison(rows)); }
}
