#!/usr/bin/env node
// One real call to the slow brain (DeepSeek) with a SYNTHETIC but complete state, rendered by the
// same code the stream uses: proves the key, the endpoint, the strict JSON contract, the model pin
// and the cost estimate end to end. Sends nothing to the chain or to the judge; opens no ledger; takes no
// lock. Billed usage varies with the model's thinking length. Prints the answer and the usage,
// never a secret. The state is a made-up
// downtrend, so the answer is a contract check, not evidence about the market or the strategy.
//   node agent/probe-slow-brain.mjs
import { cfg, describeConfig } from './config.mjs';
import { computeFeatures, renderState } from './features.mjs';
import * as deepseek from './deepseek.mjs';
import { agreeingSummary, makeSnapshot } from './test-helpers.mjs';

const described = describeConfig(cfg);
console.log(`slow brain: model ${described.deepseekModel}, key ${described.deepseekKey}, min confidence ${cfg.deepseekMinConfidence}`);
if (!cfg.hasDeepseekKey) {
  console.log('FAIL  the slow-brain key is not set in the bot .env (the owner adds it there himself; the assistant never reads the file)');
  process.exit(1);
}

const now = Date.now();
const snapshot = makeSnapshot({ now, price: 3000, trendUp: false });
const quotes = { at: now, impactBps: 1.2, expectedSlippagePct: 0.02, tolerancePct: 0.5, costPct: 0.08, sellQuotePrice: 2999.7, buyQuotePrice: 3000.3, block: 0 };
const features = computeFeatures(snapshot, quotes, now);
const stateText = renderState(features, { side: 'ETH', ethPct: 100, lastSwitchMinutes: null, switchesToday: 0, maxSwitchesPerDay: cfg.maxSwitchesPerDay });

console.log('--- synthetic state sent (same renderer as the stream) ---');
console.log(stateText);
console.log('--- candidate: move the whole position to USDC; fast judge agreeing (synthetic) ---');

const answer = await deepseek.confirm({ stateText, judgeSummary: agreeingSummary('USDC'), candidate: 'USDC', position: { side: 'ETH' } });
const usage = answer.usage ? {
  prompt_tokens: answer.usage.prompt_tokens, completion_tokens: answer.usage.completion_tokens,
  cache_hit: answer.usage.prompt_cache_hit_tokens ?? null, cache_miss: answer.usage.prompt_cache_miss_tokens ?? null,
} : null;
console.log(JSON.stringify({ ok: answer.ok, reason: answer.reason ?? null, stance: answer.stance ?? null, confidence: answer.confidence ?? null, agrees: answer.agrees ?? null, reasons: answer.reasons ?? null, model: answer.model ?? null, ms: answer.ms ?? null, costUsd: answer.costUsd ?? null, usage }, null, 2));
if (!answer.ok) { console.log('FAIL  no usable answer (billed if usage is present)'); process.exit(1); }
if (answer.model !== cfg.deepseekModel) { console.log(`FAIL  served model ${answer.model} differs from the configured ${cfg.deepseekModel}`); process.exit(1); }
console.log(`PASS  slow brain answered within the contract in ${answer.ms} ms for ≈ $${answer.costUsd?.toFixed(6) ?? 'n/a'}`);
