#!/usr/bin/env node
// The day report of a paper run, from the ledger alone (agent v2.6). Read-only: it opens the SQLite file read-only, imports no
// configuration (so it needs no .env and can run on any copied ledger), sends nothing anywhere and
// prints no secret (the ledger holds none: the stored configuration carries keys as set/unset only).
//
//   node agent/report.mjs                          # data/agent.db (or AGENT_DB_PATH), every row
//   node agent/report.mjs --db path/to/T1.db       # one ledger
//   node agent/report.mjs --day 2026-10-02         # one UTC day of it
//   node agent/report.mjs --projection 100 --json  # the same $ of costs as a share of $100; machine-readable
//
// What it can and cannot say: every number is a count or a sum over rows the agent wrote on its own
// clock. "Eligible" time is a definition stated in the output, not a measurement of the market; a
// switch that "paid" at a horizon is a diagnostic against the tape's later price, not evidence of an
// edge; the node's CPU/RAM and the vendor's invoice are not in the ledger and are reported by the runner.
import { RecordableError } from './errors.mjs';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HORIZONS_MIN = [15, 60, 240];
const finite = (v) => Number.isFinite(v);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const parse = (text, fallback = null) => { if (text === null || text === undefined) return fallback; try { return JSON.parse(text); } catch { return fallback; } };
const count = (xs, key) => { const out = {}; for (const x of xs) { const k = key(x); if (k === null || k === undefined) continue; out[k] = (out[k] ?? 0) + 1; } return out; };
const pct = (part, base) => (finite(part) && finite(base) && base > 0 ? (part / base) * 100 : null);
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** The UTC day window [from, to) for `--day`, or null for every row. */
export function dayWindow(day) {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new RecordableError(`--day must be YYYY-MM-DD (UTC), got ${day}`);
  const from = new Date(`${day}T00:00:00.000Z`); const to = new Date(from.getTime() + 86_400_000);
  if (!finite(from.getTime())) throw new RecordableError(`--day is not a date: ${day}`);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Which way a vote leans, with the thresholds of the stored configuration (the policy's `agreesWith`, restated so the report imports no configuration). */
function leaning(summary, cfg) {
  if (!summary || !finite(summary.riskOffP) || !finite(summary.directionP)) return null;
  if (summary.riskOffP > (cfg?.maxRiskOffP ?? 0.6)) return null;
  const target = summary.regime === 'trend_up' ? 'ETH' : summary.regime === 'trend_down' ? 'USDC' : null;
  if (!target) return null;
  const minDirectionP = cfg?.minDirectionP ?? 0.7;
  if ((cfg?.voteBasis ?? 'forecast') === 'regime') {
    if (!finite(summary.regimeP) || summary.regimeP < (cfg?.minRegimeP ?? 0.5)) return null;
    const contrary = target === 'ETH' ? 'down' : 'up';
    return summary.direction === contrary && summary.directionP >= minDirectionP ? null : target;
  }
  const accept = Array.isArray(cfg?.voteAcceptQuality) && cfg.voteAcceptQuality.length ? cfg.voteAcceptQuality : ['good'];
  if (!accept.includes(summary.quality) || summary.directionP < minDirectionP) return null;
  return summary.direction === (target === 'ETH' ? 'up' : 'down') ? target : null;
}

/** The cause a limits block names, one label per problem string of the decision's reason. */
function blockCause(problem) {
  const p = problem.toLowerCase();
  if (p.startsWith('halted')) return 'halt';
  if (p.includes('pending or unresolved')) return 'pending';
  if (p.includes('minimum hold')) return 'hold';
  if (p.includes('switches today')) return 'count';
  if (p.includes('above the pilot cap') || p.includes('below the $')) return 'notional';
  if (p.includes('inference spend')) return 'budget';
  if (p.includes('net loss')) return 'loss';
  if (p.includes('stale') || p.includes('degraded') || p.includes('unknown') || p.includes('features unavailable')) return 'data';
  return 'other';
}

/**
 * Build the report as one plain object. `db` is an open node:sqlite handle (a test passes the harness
 * ledger's); `path` opens the file read-only. `day` narrows to one UTC day; `projectionUsd` is the
 * capital the same dollars of cost are projected onto (the real $100 the owner named).
 */
export function buildReport({ db = null, path = null, mode = 'paper', day = null, projectionUsd = null } = {}) {
  const own = !db;
  if (!db) db = new DatabaseSync(path, { readOnly: true });
  try {
    const win = dayWindow(day);
    const where = win ? 'mode = ? AND ts >= ? AND ts < ?' : 'mode = ?';
    const args = win ? [mode, win.from, win.to] : [mode];
    const all = (table, extra = '') => db.prepare(`SELECT * FROM ${table} WHERE ${where} ${extra} ORDER BY id`).all(...args);
    const kv = (key) => parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value);
    const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const observations = has('observations') ? all('observations').map((o) => ({ ...o, value: parse(o.payload) })) : [];
    const valuations = observations.filter((o) => o.kind === 'valuation' && Number.isFinite(o.value?.price));
    const slots = observations.filter((o) => o.kind === 'slot');
    const inputRows = has('market_inputs') ? db.prepare(`SELECT COUNT(*) AS n FROM market_inputs WHERE ${where}`).get(...args).n : 0;
    const inferenceCalls = has('inference_calls') ? all('inference_calls') : [];
    const session = kv('session:paper');
    const sessionInWindow = session && (!win || (session.startedAt >= win.from && session.startedAt < win.to)) ? session : null;

    const judgments = all('judgments'); const decisions = all('decisions'); const switches = all('switches');
    const costs = all('costs'); const equity = all('equity'); const arms = all('arms');
    const legsOf = (id) => db.prepare('SELECT * FROM legs WHERE switch_id = ? ORDER BY seq').all(id);

    // ---- 1. header: what ran, under which configuration, from which opening
    const hashes = [...new Set([...judgments.map((j) => j.config_hash), sessionInWindow?.configHash].filter(Boolean))];
    const sourceHashes = [...new Set([...judgments.map((j) => j.source_hash), sessionInWindow?.sourceHash].filter(Boolean))];
    const cfg = hashes.length ? kv(`config:${hashes[0]}`) : null;
    const paper = kv('paper:balances'); const initial = kv(`initial:${mode}`); const halt = kv(`halt:${mode}`);
    const tickMs = cfg?.tickMs ?? null;
    const first = equity[0] ?? null; const last = equity[equity.length - 1] ?? null;
    const finalValuation = valuations.at(-1) ?? null;
    const finalPrice = finalValuation?.value.price ?? last?.price ?? null;
    const header = {
      asset: cfg?.market?.asset ?? 'ETH', market: cfg?.market?.name ?? 'base-eth-usdc', strategy: cfg?.strategy ?? null,
      mode, day: day ?? null, window: win, rows: { judgments: judgments.length, decisions: decisions.length, switches: switches.length, costs: costs.length, equity: equity.length, arms: arms.length },
      agentVersion: cfg?.version ?? null, configHash: hashes[0] ?? null, sourceHash: sourceHashes[0] ?? null,
      configChangedMidRun: hashes.length > 1 || sourceHashes.length > 1, configHashes: hashes, sourceHashes,
      tickMs, paperCapitalUsd: cfg?.paperCapitalUsd ?? null, notionalCapUsd: cfg?.maxCapitalUsd ?? null, inferenceBudgetUsdPerDay: cfg?.inferenceBudgetUsdPerDay ?? null,
      paperContinueUnknownBilling: cfg?.paperContinueUnknownBilling ?? false, paperUnknownBillReserveUsd: cfg?.paperUnknownBillReserveUsd ?? 0,
      voteRule: cfg ? `${cfg.voteMin} of ${cfg.voteWindow} within ${Math.round((cfg.voteMaxSpanMs ?? 0) / 1000)} s, gap ≤ ${Math.round((cfg.voteMaxGapMs ?? 0) / 1000)} s` : null,
      requireDeepseek: cfg?.requireDeepseek ?? null, deepseekCooldownMs: cfg?.deepseekCooldownMs ?? null, judgeModel: judgments.find((j) => j.model)?.model ?? null,
      opening: paper ? { source: paper.source ?? 'real wallet', since: paper.since, capitalUsd: paper.capitalUsd ?? null, openingPrice: paper.openingPrice ?? null, ethSide: paper.opening?.ethSide ?? null, usdc: paper.opening?.usdc ?? null, nowEthSide: paper.ethSide, nowUsdc: paper.usdc } : null,
      initial: initial ? { ts: initial.ts, walletUsd: initial.walletUsd ?? initial.equityUsd } : null,
      firstRowAt: first?.ts ?? null, lastRowAt: finalValuation?.ts ?? last?.ts ?? null, startPrice: first?.price ?? null, endPrice: finalPrice,
      session: sessionInWindow, finalPriceAt: finalValuation?.value.priceAt ?? null,
      finalPriceStale: finalValuation?.value.stale ?? null, valuationSource: finalValuation ? 'post-tick paper balances' : 'legacy pre-trade equity',
    };

    // ---- 2. time: ticks planned and seen, usable judgments, gaps, halted and eligible time (definitions in the output)
    const spanMs = first && last ? Date.parse(last.ts) - Date.parse(first.ts) : 0;
    const features = judgments.map((j) => parse(j.features, {}));
    const degraded = features.map((f) => Boolean(f?.dataQuality?.degraded));
    const reasons = count(features.flatMap((f) => f?.dataQuality?.reasons ?? []), (r) => r.replace(/\d+/gu, 'N'));
    const judgeOk = judgments.filter((j) => j.error === null || j.error === undefined);
    const haltAt = halt?.at ? Date.parse(halt.at) : null;
    const usable = judgments.filter((j, i) => !degraded[i] && (j.error === null || j.error === undefined));
    const eligible = usable.filter((j) => haltAt === null || Date.parse(j.ts) < haltAt);
    const gapAfter = (rows, limitMs) => { const out = []; for (let i = 1; i < rows.length; i += 1) { const d = Date.parse(rows[i].ts) - Date.parse(rows[i - 1].ts); if (d > limitMs) out.push({ from: rows[i - 1].ts, to: rows[i].ts, minutes: Math.round(d / 6000) / 10 }); } return out; };
    const sleepGaps = gapAfter(equity, Math.max(300_000, 3 * (tickMs ?? 60_000)));
    const windowBreaks = tickMs ? gapAfter(judgments, 2 * tickMs).length : null;
    const time = {
      wallSpanMinutes: sessionInWindow ? Math.round((Date.parse(sessionInWindow.endedAt ?? new Date().toISOString()) - Date.parse(sessionInWindow.startedAt)) / 6000) / 10 : Math.round(spanMs / 6000) / 10,
      plannedTicks: sessionInWindow?.plannedSlots ?? (tickMs && spanMs > 0 ? Math.floor(spanMs / tickMs) + 1 : null),
      attemptedSlots: sessionInWindow?.attemptedSlots ?? null, missedSlots: sessionInWindow?.missedSlots ?? null,
      unattemptedSlots: sessionInWindow?.unattemptedSlots ?? null,
      sessionStatus: sessionInWindow?.status ?? null, sessionStopReason: sessionInWindow?.stopReason ?? null,
      archivedMarketInputs: inputRows,
      ticksSeen: equity.length, judgments: judgments.length, judgeErrors: judgments.length - judgeOk.length,
      ticksWithoutJudgment: Math.max(0, equity.length - judgments.length), // stale tape, the judge off, or the budget reached: the rows do not say which; the budget line below does
      degradedJudgments: degraded.filter(Boolean).length, degradedReasons: reasons, usableJudgments: usable.length,
      halt: halt ? { reason: halt.reason, at: halt.at, haltedMinutes: last ? Math.round((Date.parse(last.ts) - haltAt) / 6000) / 10 : null } : null,
      eligibleTicks: eligible.length, eligibleMinutes: tickMs ? Math.round((eligible.length * tickMs) / 6000) / 10 : null,
      eligibleDefinition: 'judgments with an answer, features not degraded, before the halt latch (if any) × the tick',
      gapsOver5min: sleepGaps, windowBreaks, windowBreaksDefinition: 'consecutive judgments further apart than two ticks: the vote window restarts there',
      feed: { disconnectedJudgments: features.filter((f) => (f?.dataQuality?.reasons ?? []).some((r) => r.includes('feed disconnected'))).length, candleFallbackJudgments: features.filter((f) => (f?.dataQuality?.reasons ?? []).some((r) => r.includes('fallback'))).length },
    };

    // ---- 3. calls and costs, and the same dollars as a share of the capital and of the projection
    const ms = judgeOk.map((j) => j.ms).filter(finite);
    // a ledger written under an older name for the judge's cost kind can be read by naming that kind: REPORT_LEGACY_JUDGE_KIND=<old kind>
    const legacyJudgeKind = typeof process.env.REPORT_LEGACY_JUDGE_KIND === 'string' && process.env.REPORT_LEGACY_JUDGE_KIND.trim() !== '' ? process.env.REPORT_LEGACY_JUDGE_KIND.trim() : null;
    const sameKind = (a, b) => a === b || (a === 'judge' && legacyJudgeKind !== null && b === legacyJudgeKind);
    const byKind = (kind) => costs.filter((c) => sameKind(kind, c.kind));
    const judgeUsd = sum(byKind('judge').map((c) => c.usd)); const dsUsd = sum(byKind('deepseek').map((c) => c.usd)); const gasUsd = sum(byKind('gas').map((c) => c.usd));
    const external = sum(costs.filter((c) => c.external === 1).map((c) => c.usd));
    const inference = judgeUsd + dsUsd;
    const dsDecisions = decisions.map((d) => ({ d, ds: parse(d.deepseek) })).filter((x) => x.ds);
    const capital = header.initial?.walletUsd ?? null;
    const unknown = inferenceCalls.filter((c) => c.billing === 'UNKNOWN');
    const attempted = (provider) => inferenceCalls.filter((c) => sameKind(provider, c.provider) && c.status !== 'not-sent').length;
    const calls = {
      judge: { calls: inferenceCalls.length ? attempted('judge') : judgeOk.length, errors: time.judgeErrors, usd: judgeUsd,
        unknown: unknown.filter((c) => sameKind('judge', c.provider)).length, usdPerCall: judgeOk.length ? judgeUsd / judgeOk.length : null, latencyMs: { avg: ms.length ? Math.round(sum(ms) / ms.length) : null, p95: quantile(ms, 0.95), max: ms.length ? Math.max(...ms) : null } },
      deepseek: { calls: inferenceCalls.length ? attempted('deepseek') : byKind('deepseek').length, usd: dsUsd,
        unknown: unknown.filter((c) => c.provider === 'deepseek').length,
        usableAnswers: dsDecisions.filter((x) => x.ds.ok).length, agreed: dsDecisions.filter((x) => x.ds.ok && x.ds.agrees).length, vetoes: decisions.filter((d) => d.stage === 'slow-brain' && d.outcome === 'vetoed').length, noAnswer: decisions.filter((d) => d.stage === 'slow-brain' && (d.outcome === 'held' || d.outcome === 'proceed-without-slow-brain')).length, invoiceNote: 'the ledger prices DeepSeek from its usage at the list price; the prepaid page is the invoice — compare' },
      paperGas: { legs: byKind('gas').length, usd: gasUsd },
      inferenceUsd: inference, externalUsd: external,
      budget: { perDayUsd: header.inferenceBudgetUsdPerDay, spentUsd: inference,
        unknownReservedUsd: unknown.length * header.paperUnknownBillReserveUsd,
        committedUsd: inference + unknown.length * header.paperUnknownBillReserveUsd,
        reached: header.inferenceBudgetUsdPerDay !== null ? inference + unknown.length * header.paperUnknownBillReserveUsd >= header.inferenceBudgetUsdPerDay : null },
      shareOfCapitalPct: pct(external, capital), shareOfProjectionPct: pct(external, projectionUsd), projectionUsd,
      billingUnknown: unknown.map((c) => ({ id: c.id, provider: c.provider, ts: c.ts, status: c.status })),
      provenance: has('inference_calls') ? 'durable attempt journal' : 'legacy inferred from judgments/costs; attempt count incomplete',
    };

    // ---- 4. the funnel with raw denominators (R5-P2)
    const summaries = judgments.map((j) => parse(j.summary));
    const limitBlocks = decisions.filter((d) => d.stage === 'limits');
    const funnel = {
      judgments: judgments.length,
      answers: { regime: count(summaries, (s) => s?.regime), direction: count(summaries, (s) => s?.direction), quality: count(summaries, (s) => s?.quality), riskOffAboveCeiling: summaries.filter((s) => finite(s?.riskOffP) && s.riskOffP > (cfg?.maxRiskOffP ?? 0.6)).length },
      leaningVotes: count(summaries, (s) => leaning(s, cfg)),
      candidateTicks: decisions.length, // every decision row is one tick on which a candidate left the vote window (a deferred candidate counts once per tick it waited)
      candidateTicksByStage: count(decisions, (d) => `${d.stage}:${d.outcome}`),
      trendVetoes: decisions.filter((d) => d.stage === 'trend').length,
      limitBlocks: limitBlocks.length, limitBlockCauses: count(limitBlocks.flatMap((d) => (d.reason ?? '').split('; ').map(blockCause)), (c) => c),
      deferredByCooldown: decisions.filter((d) => d.outcome === 'deferred').length,
      slowBrainCalls: calls.deepseek.calls, slowBrainAgreed: calls.deepseek.agreed, slowBrainVetoes: calls.deepseek.vetoes, slowBrainNoAnswer: calls.deepseek.noAnswer,
      preflightAborts: decisions.filter((d) => d.stage === 'preflight').length,
      executed: decisions.filter((d) => d.outcome === 'execute').length,
      switchesByStatus: count(switches, (s) => s.status),
      noCandidateReasons: count(observations.filter((o) => o.kind === 'vote' && !o.value?.target), (o) => o.value?.reason ?? 'unspecified'),
      noActionTicks: count(observations.filter((o) => o.kind === 'tick'), (o) => {
        const x = o.value;
        return x?.candidate === null ? 'no candidate' : x?.stale ? 'stale data' : x?.waiting ? 'waiting for tape'
          : x?.stop ? 'stopped' : x?.cooldown ? 'slow-brain cooldown' : x?.vetoed ? 'vetoed'
            : x?.blocked ? 'limits' : x?.held ? 'slow brain unavailable' : x?.aborted ? 'preflight aborted' : null;
      }),
    };

    // ---- 5. every switch, with the tape's later price at three horizons (diagnostic)
    const tape = valuations.length
      ? valuations.filter((o) => !o.value.stale && Number.isFinite(Date.parse(o.value.priceAt)))
        .map((o) => ({ price: o.value.price, ts: o.value.priceAt, recordedAt: o.ts }))
      : equity.map((e) => ({ price: e.price, ts: e.ts, recordedAt: e.ts }));
    tape.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const priceAt = (ts) => {
      const target = Date.parse(ts);
      const row = tape.find((e) => Date.parse(e.ts) >= target && Date.parse(e.ts) <= target + 60_000);
      return row ? { ...row, lateMs: Date.parse(row.ts) - target } : null;
    };
    const switchRows = switches.map((s) => {
      const legs = legsOf(s.id);
      const at = Date.parse(s.ts);
      const before = judgments.filter((j) => Date.parse(j.ts) <= at).pop();
      const costPct = parse(before?.features, {})?.quotes?.costPct ?? null;
      const spot = decisions.find((d) => d.outcome === 'execute' && (d.reason ?? '').endsWith(`switch ${s.id}`))?.price
        ?? legs.find((l) => finite(l.price_usd))?.price_usd ?? null;
      const fill = legs.find((l) => ['swap', 'paper'].includes(l.kind) && l.status === 'confirmed' && finite(l.amount_out_actual) && l.amount_out_actual > 0);
      const soldEth = fill && ['ETH', 'WETH'].includes(fill.token_in) && fill.token_out === 'USDC';
      const boughtEth = fill && fill.token_in === 'USDC' && ['ETH', 'WETH'].includes(fill.token_out);
      const entry = soldEth ? fill.amount_out_actual / fill.amount_in : boughtEth ? fill.amount_in / fill.amount_out_actual : null;
      const horizons = {};
      for (const m of HORIZONS_MIN) {
        const later = priceAt(new Date(at + m * 60_000).toISOString());
        if (!later || !finite(spot)) { horizons[`${m}m`] = null; continue; }
        const movePct = ((later.price / spot) - 1) * 100;
        const benefitUsd = s.status === 'done' && finite(s.spent_usd) && fill
          ? soldEth ? fill.amount_out_actual - fill.amount_in * later.price - s.spent_usd
            : boughtEth ? fill.amount_out_actual * later.price - fill.amount_in - s.spent_usd : null
          : null;
        horizons[`${m}m`] = { price: later.price, observedAt: later.ts, lateMs: later.lateMs,
          movePct: Math.round(movePct * 1000) / 1000, benefitUsd,
          paid: finite(benefitUsd) ? benefitUsd >= 0 : null };
      }
      return { id: s.id, ts: s.ts, from: s.from_side, to: s.to_side, status: s.status, reason: s.reason, notionalUsd: s.notional_usd, spentUsd: s.spent_usd, halt: s.halt_reason, entryPrice: entry, decisionPrice: spot, costPctAtDecision: costPct,
        legs: legs.map((l) => ({ seq: l.seq, kind: l.kind, status: l.status, tokenIn: l.token_in, tokenOut: l.token_out, amountIn: l.amount_in, quoteOut: l.quote_out, actualOut: l.amount_out_actual, priceUsd: l.price_usd, accounting: l.accounting })), horizons };
    });

    // ---- 6. the result: three lines (gross before inference / net at the capital / projection), drawdown, arms
    const finalWallet = finalValuation?.value.walletUsd ?? last?.wallet_usd ?? null;
    const grossUsd = finite(capital) && finite(finalWallet) ? finalWallet - capital - gasUsd : null; // the market result of the positions after the paper gas, before any inference
    const netUsd = finite(grossUsd) && unknown.length === 0 ? grossUsd - inference : null;
    const projectedUsd = finite(grossUsd) && finite(projectionUsd) && finite(capital) && capital > 0 && unknown.length === 0 ? grossUsd * (projectionUsd / capital) - inference : null; // inference is fixed dollars, not a share of capital
    let peak = -Infinity; let maxDrawdownPct = 0;
    const netSeries = [...equity.map((e) => ({ ts: e.ts, net: e.net_usd })),
      ...valuations.map((e) => ({ ts: e.ts, net: e.value.walletUsd - e.value.externalUsd }))]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (const e of netSeries) {
      const net = e.net;
      if (!finite(net)) continue;
      peak = Math.max(peak, net);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - net) / peak) * 100);
    }
    const lastArm = {};
    for (const a of arms) {
      const marked = finite(finalPrice) && finite(a.eth_side) && finite(a.usdc);
      const equityUsd = marked ? a.eth_side * finalPrice + a.usdc : a.equity_usd;
      lastArm[a.arm] = { lastTickAt: a.ts, valuedAt: marked ? (finalValuation?.ts ?? last?.ts ?? a.ts) : a.ts,
        side: a.side, ethSide: a.eth_side, usdc: a.usdc, equityUsd, costsUsd: a.costs_usd,
        netUsd: marked ? equityUsd - a.costs_usd : a.net_usd, switches: a.switches };
    }
    const result = {
      capitalUsd: capital, finalWalletUsd: finalWallet, startPrice: header.startPrice, endPrice: header.endPrice,
      finalValuationAt: finalValuation?.ts ?? last?.ts ?? null, finalPriceAt: header.finalPriceAt,
      finalPriceStale: header.finalPriceStale, provisional: sessionInWindow?.status === 'running' || unknown.length > 0 || header.finalPriceStale === true,
      priceMovePct: finite(header.startPrice) && finite(header.endPrice) ? ((header.endPrice / header.startPrice) - 1) * 100 : null,
      lines: {
        grossBeforeInference: { usd: grossUsd, pct: pct(grossUsd, capital) },
        netAtCapital: { usd: netUsd, pct: pct(netUsd, capital) },
        projection: { capitalUsd: projectionUsd, usd: projectedUsd, pct: pct(projectedUsd, projectionUsd), note: projectionUsd === null ? 'not requested' : 'the same market result scaled to the projection capital, minus the SAME dollars of inference' },
      },
      maxDrawdownPct: Math.round(maxDrawdownPct * 1000) / 1000,
      arms: lastArm, armsNote: 'latest holdings marked at the report end price; diagnostic benchmarks (R1-G), not evidence for or against the strategy',
    };

    // ---- 7. halts
    const halts = { current: halt, switchHalts: switches.filter((s) => s.halt_reason).map((s) => ({ id: s.id, ts: s.ts, reason: s.halt_reason, acked: s.halt_acked_at })) };

    const forecasts = judgments.filter((j) => parse(j.summary)?.direction && finite(j.price)).map((j) => {
      const summary = parse(j.summary); const target = new Date(Date.parse(j.ts) + 15 * 60_000).toISOString();
      const later = priceAt(target); const costPct = parse(j.features)?.quotes?.costPct ?? null;
      const dataQuality = parse(j.features)?.dataQuality;
      const movePct = later ? (later.price / j.price - 1) * 100 : null;
      const outcome = !finite(movePct) || !finite(costPct) ? null : movePct > costPct ? 'up' : movePct < -costPct ? 'down' : 'flat';
      return { judgmentId: j.id, ts: j.ts, predicted: summary.direction, confidence: summary.directionP,
        qualityAtPrediction: dataQuality ? (dataQuality.degraded ? 'degraded' : 'good') : 'unknown',
        price: j.price, costBandPct: costPct, observedAt: later?.ts ?? null, lateMs: later?.lateMs ?? null,
        movePct, outcome, correct: outcome === null ? null : summary.direction === outcome };
    });
    return { generatedAt: new Date().toISOString(), header, time, calls, funnel, switches: switchRows, forecasts,
      forecastNote: '15-minute labels use the first fresh tape event within 60 seconds of the target; overlapping forecasts are not independent',
      result, halts, node: 'CPU/RAM, sleep, reboots and other load on the host are not in the ledger: the operator reports them' };
  } finally { if (own) db.close(); }
}

const money = (v, d = 4) => (finite(v) ? `$${v.toFixed(d)}` : 'n/a');
const p = (v, d = 3) => (finite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)} %` : 'n/a');
const n = (v) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : String(v));
const obj = (o) => (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') : 'none');

/** The report as text, one section per §5 item. */
export function renderReport(r) {
  const h = r.header; const t = r.time; const c = r.calls; const f = r.funnel; const x = r.result;
  const out = [];
  out.push(`TEST-DAY REPORT — ${h.mode}${h.day ? ` — UTC day ${h.day}` : ' — every row'} — generated ${r.generatedAt}`);
  out.push('');
  out.push('1. Header');
  out.push(`   agent ${n(h.agentVersion)}, config ${n(h.configHash)}, source ${n(h.sourceHash)}${h.configChangedMidRun ? '  !! CONFIGURATION OR SOURCE CHANGED MID-RUN: ' + [...h.configHashes, ...h.sourceHashes].join(' ') : ''}`);
  out.push(`   tick ${h.tickMs === null ? 'n/a' : `${h.tickMs} ms`}, votes ${n(h.voteRule)}, slow brain required ${n(h.requireDeepseek)} (cooldown ${h.deepseekCooldownMs === null ? 'n/a' : `${h.deepseekCooldownMs / 1000} s`}), judge ${n(h.judgeModel)}`);
  out.push(`   virtual capital ${money(h.paperCapitalUsd, 2)}, notional cap ${money(h.notionalCapUsd, 2)}, inference budget ${money(h.inferenceBudgetUsdPerDay, 2)}/day`);
  out.push(`   opening: ${h.opening ? `${h.opening.source} at ${h.opening.since}, price ${money(h.opening.openingPrice, 2)}, ${finite(h.opening.ethSide) ? h.opening.ethSide.toFixed(6) : 'n/a'} ETH + ${money(h.opening.usdc, 2)} USDC; now ${finite(h.opening.nowEthSide) ? h.opening.nowEthSide.toFixed(6) : 'n/a'} ETH + ${money(h.opening.nowUsdc, 2)} USDC` : 'n/a'}; initial wallet ${money(h.initial?.walletUsd, 2)} at ${n(h.initial?.ts)}`);
  out.push(`   rows ${h.firstRowAt ?? 'n/a'} → ${h.lastRowAt ?? 'n/a'}; ${h.asset} ${money(h.startPrice, 2)} → ${money(h.endPrice, 2)} (final tape ${n(h.finalPriceAt)}, stale ${n(h.finalPriceStale)}, ${h.valuationSource})`);
  out.push('');
  out.push('2. Time');
  out.push(`   wall ${t.wallSpanMinutes} min; planned ticks ${n(t.plannedTicks)}; ticks seen ${t.ticksSeen}; judgments ${t.judgments} (errors ${t.judgeErrors}); ticks without a judgment ${t.ticksWithoutJudgment}`);
  if (t.sessionStatus) out.push(`   session ${t.sessionStatus} (${n(t.sessionStopReason)}); attempted slots ${n(t.attemptedSlots)}, missed ${n(t.missedSlots)}, not run ${n(t.unattemptedSlots)}, archived inputs ${t.archivedMarketInputs}`);
  out.push(`   degraded judgments ${t.degradedJudgments} (${obj(t.degradedReasons)}); usable ${t.usableJudgments}`);
  out.push(`   halt: ${t.halt ? `${t.halt.reason} at ${t.halt.at} (halted ${t.halt.haltedMinutes} min to the last row)` : 'none'}`);
  out.push(`   eligible trading time ${n(t.eligibleMinutes)} min = ${t.eligibleTicks} ticks (${t.eligibleDefinition})`);
  out.push(`   gaps over 5 min ${t.gapsOver5min.length}${t.gapsOver5min.length ? ': ' + t.gapsOver5min.map((g) => `${g.from} → ${g.to} (${g.minutes} min)`).join('; ') : ''}; vote-window breaks ${n(t.windowBreaks)} (${t.windowBreaksDefinition})`);
  out.push(`   feed: judgments with the feed disconnected ${t.feed.disconnectedJudgments}, with fallback candles ${t.feed.candleFallbackJudgments}`);
  out.push('');
  out.push('3. Calls and costs');
  out.push(`   Judge: ${c.judge.calls} calls, ${c.judge.errors} errors, ${money(c.judge.usd)} (${money(c.judge.usdPerCall, 6)}/call), latency avg ${n(c.judge.latencyMs.avg)} ms, p95 ${n(c.judge.latencyMs.p95)} ms, max ${n(c.judge.latencyMs.max)} ms`);
  out.push(`   DeepSeek: ${c.deepseek.calls} dispatched calls, ${money(c.deepseek.usd)} known estimate; usable answers ${c.deepseek.usableAnswers}, agreed ${c.deepseek.agreed}, vetoes ${c.deepseek.vetoes}, no answer ${c.deepseek.noAnswer} (${c.deepseek.invoiceNote})`);
  out.push(`   billing UNKNOWN ${c.billingUnknown.length} (${c.billingUnknown.map((x) => `${x.provider}#${x.id}`).join(', ') || 'none'}); counts ${c.provenance}`);
  if (h.paperContinueUnknownBilling) out.push(`   paper UNKNOWN continuation: ${money(h.paperUnknownBillReserveUsd, 6)} planning reserve per unknown call; ${money(c.budget.unknownReservedUsd, 6)} reserved, ${money(c.budget.committedUsd, 6)} budget commitment. Reserve is NOT the vendor bill; net remains unresolved.`);
  out.push(`   paper gas: ${c.paperGas.legs} legs, ${money(c.paperGas.usd)}`);
  out.push(`   known inference ${money(c.inferenceUsd)} of the ${money(c.budget.perDayUsd, 2)}/day budget${c.budget.reached ? ' — REACHED (judging paused after that)' : ''}; known external costs ${money(c.externalUsd)} = ${p(c.shareOfCapitalPct, 4)} of the capital${c.projectionUsd === null ? '' : ` = ${p(c.shareOfProjectionPct, 4)} of ${money(c.projectionUsd, 0)}`}`);
  out.push('');
  out.push('4. Funnel (raw denominators)');
  out.push(`   judgments ${f.judgments} → regime ${obj(f.answers.regime)}; direction ${obj(f.answers.direction)}; quality ${obj(f.answers.quality)}; risk_off above the ceiling ${f.answers.riskOffAboveCeiling}`);
  out.push(`   votes leaning to a switch: ${obj(f.leaningVotes)}`);
  out.push(`   candidate-ticks by stage: ${obj(f.candidateTicksByStage)}`);
  out.push(`   no-action ticks: ${obj(f.noActionTicks)}; no-candidate votes: ${obj(f.noCandidateReasons)}`);
  out.push(`   trend vetoes ${f.trendVetoes}; limit blocks ${f.limitBlocks} (${obj(f.limitBlockCauses)}); deferred by the cooldown ${f.deferredByCooldown}`);
  out.push(`   slow brain: calls ${f.slowBrainCalls}, agreed ${f.slowBrainAgreed}, vetoes ${f.slowBrainVetoes}, no answer ${f.slowBrainNoAnswer}; preflight aborts ${f.preflightAborts}; executed ${f.executed}; switches ${obj(f.switchesByStatus)}`);
  out.push('');
  out.push('5. Switches');
  if (!r.switches.length) out.push('   none');
  for (const s of r.switches) {
    out.push(`   #${s.id} ${s.ts} ${s.from} → ${s.to} ${s.status}${s.reason ? ` (${s.reason})` : ''}; notional ${money(s.notionalUsd, 2)}; spent ${s.spentUsd === null ? 'UNRESOLVED' : money(s.spentUsd)}; fill ${money(s.entryPrice, 2)}, decision tape ${money(s.decisionPrice, 2)}; cost at decision ${finite(s.costPctAtDecision) ? s.costPctAtDecision.toFixed(3) + ' %' : 'n/a'}${s.halt ? `; HALT ${s.halt}` : ''}`);
    for (const l of s.legs) out.push(`      leg ${l.seq} ${l.kind} ${l.status} ${l.amountIn} ${l.tokenIn} → ${n(l.actualOut)} ${l.tokenOut ?? ''} (quote ${n(l.quoteOut)}), valued at ${money(l.priceUsd, 2)}, accounting ${l.accounting}`);
    out.push(`      later: ${HORIZONS_MIN.map((m) => { const hz = s.horizons[`${m}m`]; return `${m} min ${hz ? `${p(hz.movePct)} at ${hz.observedAt} (${Math.round(hz.lateMs / 1000)} s late), benefit ${money(hz.benefitUsd)} ${hz.paid === null ? '' : hz.paid ? 'paid' : 'not paid'}` : 'n/a/censored'}`; }).join('; ')} (fill-based benefit after gas, shared inference excluded; diagnostic)`);
  }
  out.push('');
  out.push('6. Result');
  out.push(`   capital ${money(x.capitalUsd, 2)} → wallet ${money(x.finalWalletUsd, 2)} at ${n(x.finalValuationAt)}${x.provisional ? ' (PROVISIONAL/UNRESOLVED)' : ''}; ETH ${p(x.priceMovePct)}; max drawdown of net ${x.maxDrawdownPct} %`);
  out.push(`   gross before inference   ${money(x.lines.grossBeforeInference.usd)}  ${p(x.lines.grossBeforeInference.pct)}`);
  out.push(`   net at the capital       ${money(x.lines.netAtCapital.usd)}  ${p(x.lines.netAtCapital.pct)}`);
  if (x.lines.projection.capitalUsd !== null) out.push(`   projection at ${money(x.lines.projection.capitalUsd, 0).padEnd(10)} ${money(x.lines.projection.usd)}  ${p(x.lines.projection.pct)}  (${x.lines.projection.note})`);
  const covered = r.forecasts.filter((f) => f.outcome !== null);
  const good = covered.filter((f) => f.qualityAtPrediction === 'good');
  out.push(`   15-minute forecast labels: ${covered.length}/${r.forecasts.length} covered (good ${good.length}, degraded ${covered.filter((f) => f.qualityAtPrediction === 'degraded').length}, unknown ${covered.filter((f) => f.qualityAtPrediction === 'unknown').length}); ${covered.filter((f) => f.correct).length} matched overall, ${good.filter((f) => f.correct).length} on good data; overlapping windows, descriptive only`);
  out.push(`   arms (${x.armsNote}): ${Object.keys(x.arms).length ? Object.entries(x.arms).map(([k, a]) => `${k} ${a.side} net ${money(a.netUsd, 2)} (${a.switches} switches)`).join('; ') : 'none'}`);
  out.push('');
  out.push('7. Halts');
  out.push(`   current: ${r.halts.current ? `${r.halts.current.reason} at ${r.halts.current.at}` : 'none'}; switch-level: ${r.halts.switchHalts.length ? r.halts.switchHalts.map((s) => `#${s.id} ${s.reason}${s.acked ? ' (acked)' : ''}`).join('; ') : 'none'}`);
  out.push('');
  out.push(`8. Node: ${r.node}`);
  out.push('9. Conclusions: the runner\'s (what worked, what broke, what to change in the configuration — not in the strategy silently)');
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { db: { type: 'string' }, day: { type: 'string' }, projection: { type: 'string' }, mode: { type: 'string', default: 'paper' }, json: { type: 'boolean', default: false } } });
  const path = values.db || process.env.AGENT_DB_PATH || resolve(ROOT, 'data', 'agent.db');
  const projectionUsd = values.projection === undefined ? null : Number(values.projection);
  if (projectionUsd !== null && (!finite(projectionUsd) || projectionUsd <= 0)) { console.error('--projection must be a positive number of dollars'); process.exit(2); }
  let report;
  try { report = buildReport({ path, mode: values.mode, day: values.day ?? null, projectionUsd }); } catch (error) { console.error(`report failed: ${error.message}`); process.exit(2); }
  console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
}
