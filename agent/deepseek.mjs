// The slow brain: DeepSeek (V4.1-Flash by default) is consulted only when the
// fast judge has produced a candidate switch. It sees the same state text,
// the judge's summary and the candidate, and answers with JSON only. Its
// answer can veto a switch; it can never create one on its own and it never
// sees keys, addresses or absolute balances. Parsing is strict (TR-09): no
// coercion, exact types, finish_reason must be "stop"; anything else is
// "no answer", never an approval and never an exception for the caller.
import { cfg as defaultCfg } from './config.mjs';
import { describeError } from './errors.mjs';

export const URL = 'https://api.deepseek.com/chat/completions';

const ANSWER_SHAPE = 'Answer with JSON only, exactly this shape: {"stance":"ETH"|"USDC"|"HOLD","confidence":0.0-1.0,"reasons":["short reason", "..."]} with at most three reasons of at most 120 characters each.';

/** The forecast frame (SLOW_BRAIN_FRAME=forecast, the default): the candidate against the next 15 minutes and the execution cost. */
export const SYSTEM = [
  'You are the slow-thinking analyst of a tiny automated ETH/USDC position-switching agent on the Base network.',
  'Fast typed judgments come from a separate judge; deterministic code enforces all limits and executes.',
  'Your only job: given the market state and the candidate switch, say whether you agree.',
  // P1: the cost is what the state's "Execution cost" line says, never a number written here
  'Rules: use only the numbers given; never invent data; a switch costs what the "Execution cost" line of the market state says and only pays off if the price then moves more than that cost in the intended direction; prefer HOLD when evidence is mixed, the data is marked degraded or unavailable, or the move is small relative to volatility.',
  ANSWER_SHAPE,
].join(' ');

/** The regime frame (SLOW_BRAIN_FRAME=regime): is the judge's multi-hour regime likely to persist long enough to pay for the switch? */
export const SYSTEM_REGIME = [
  'You are the slow-thinking analyst of a tiny automated ETH/USDC position-switching agent on the Base network.',
  'Fast typed judgments come from a separate judge; deterministic code enforces all limits and executes.',
  'The candidate switch follows the judge\'s multi-hour regime call (trend following): the position takes the side of the regime and holds it until the regime changes.',
  'Your only job: say whether that regime is likely to persist long enough for the price to move, in the regime\'s direction, by more than the execution cost stated in the market state. Judge persistence from the trend measures (EMA20 against EMA50 and its slope, returns over hours, the volatility regime, data quality), not from what the price may do in the next few minutes.',
  // P1: the cost is what the state's "Execution cost" line says, never a number written here
  'Rules: use only the numbers given; never invent data; a switch costs what the "Execution cost" line of the market state says; prefer HOLD when the data is marked degraded or unavailable, when the trend measures disagree with each other, or when the regime looks exhausted or range-bound.',
  ANSWER_SHAPE,
].join(' ');

export const systemPrompt = (frame) => (frame === 'regime' ? SYSTEM_REGIME : SYSTEM);

const STANCES = new Set(['ETH', 'USDC', 'HOLD']);

// Official price list read 2026-09-22 (per 1M tokens, USD): flash cache-miss 0.30 peak / 0.15 off-peak, cache-hit 0.006 / 0.003, output 1.20 / 0.60.
// Peak = 01:00–04:00 and 06:00–10:00 UTC on weekdays. This is an estimate for the ledger, not the vendor's invoice.
export function estimateCostUsd(usage, at = new Date()) {
  if (!usage || typeof usage !== 'object') return null;
  const h = at.getUTCHours(); const wd = at.getUTCDay();
  const peak = wd >= 1 && wd <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
  const valid = (x) => Number.isSafeInteger(x) && x >= 0;
  if (!valid(usage.completion_tokens)) return null;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  if (!valid(hit)) return null;
  const miss = usage.prompt_cache_miss_tokens ?? (valid(usage.prompt_tokens) ? usage.prompt_tokens - hit : null);
  if (!valid(miss) || (usage.prompt_tokens !== undefined && (!valid(usage.prompt_tokens) || miss + hit !== usage.prompt_tokens))) return null;
  const out = usage.completion_tokens;
  const price = peak ? { miss: 0.30, hit: 0.006, out: 1.20 } : { miss: 0.15, hit: 0.003, out: 0.60 };
  return (miss * price.miss + hit * price.hit + out * price.out) / 1e6;
}

/** Strict validation of the model's JSON answer. Returns the parsed answer or null. */
export function parseAnswer(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { stance, confidence, reasons } = parsed;
  if (typeof stance !== 'string' || !STANCES.has(stance)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (reasons !== undefined && (!Array.isArray(reasons) || reasons.some((r) => typeof r !== 'string'))) return null;
  return { stance, confidence, reasons: (reasons ?? []).slice(0, 3).map((r) => r.slice(0, 120)) };
}

export async function confirm({ stateText, judgeSummary, candidate, position }, { cfg = defaultCfg, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const startedAt = Date.now();
  try {
    if (!cfg.hasDeepseekKey || typeof env.DEEPSEEK_API_KEY !== 'string' || env.DEEPSEEK_API_KEY.trim() === '') return { ok: false, reason: 'slow brain key unavailable', notSent: true };
    if (!STANCES.has(candidate) || candidate === 'HOLD') return { ok: false, reason: 'candidate must be ETH or USDC', notSent: true };
    const s = judgeSummary ?? {};
    const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
    const frame = cfg.slowBrainFrame ?? 'forecast';
    // The basis tells the slow brain which horizon the candidate is about (no number is written here, P1).
    // In the regime frame the 15-minute direction and switch-quality answers are not passed at all: they
    // rate a horizon that frame does not trade, and the first side-by-side session showed the slow brain
    // vetoing on them regardless of the basis line.
    const basis = (cfg.voteBasis ?? 'forecast') === 'regime'
      ? 'Basis of the candidate: regime-following. The candidate takes the side of the judge\'s multi-hour regime and holds it until the regime changes; the 15-minute forecast is not the reason for it. Judge whether the regime is likely to persist long enough for the move to exceed the execution cost, not the next 15 minutes alone.'
      : 'Basis of the candidate: 15-minute forecast. The judge expects the price to move beyond the execution cost within 15 minutes.';
    const summaryLine = frame === 'regime'
      ? `Fast judge summary: regime ${s.regime} (p=${num(s.regimeP)}), risk-off probability ${num(s.riskOffP)}.`
      : `Fast judge summary: regime ${s.regime} (p=${num(s.regimeP)}), direction over 15 minutes ${s.direction} (up ${num(s.upP)} / down ${num(s.downP)}), switch quality ${s.quality} (p=${num(s.qualityP)}), risk-off probability ${num(s.riskOffP)}.`;
    const user = [
      'Market state:', stateText, '',
      summaryLine,
      `Current position: ${position?.side}. Candidate switch: move the whole position to ${candidate}.`,
      basis,
      'Reply in JSON as instructed. If you agree with the candidate, set stance to the candidate asset; otherwise set stance to HOLD or to the other asset.',
    ].join('\n');
    // Flash defaults to thinking mode. Real probes exhausted both 300 and 2048 tokens
    // without final JSON; pin non-thinking for this short, time-bounded veto contract.
    const body = { model: cfg.deepseekModel, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 512, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt(frame) }, { role: 'user', content: user }] };
    let response;
    try {
      response = await fetchImpl(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEEPSEEK_API_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
    } catch (error) { return { ok: false, reason: `transport: ${error?.name ?? 'error'}` }; }
    if (!response || !response.ok) return { ok: false, reason: `HTTP ${response?.status ?? 'none'}` };
    let json;
    try { json = await response.json(); } catch { return { ok: false, reason: 'invalid JSON envelope' }; }
    // a billed reply costs money whatever it says: usage and cost travel with every outcome from here on (R1-10)
    const billed = { model: typeof json?.model === 'string' ? json.model : null, usage: json?.usage ?? null, costUsd: estimateCostUsd(json?.usage) };
    const choice = json?.choices?.[0];
    if (!choice || choice.finish_reason !== 'stop') return { ok: false, reason: `finish_reason ${choice?.finish_reason ?? 'missing'}`, ...billed };
    const answer = parseAnswer(typeof choice.message?.content === 'string' ? choice.message.content : '');
    if (!answer) return { ok: false, reason: 'answer outside the contract', ...billed };
    return {
      ok: true, ...answer,
      agrees: answer.stance === candidate && answer.confidence >= cfg.deepseekMinConfidence,
      ...billed, ms: Date.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, reason: `unexpected: ${describeError(error)}` };
  }
}
