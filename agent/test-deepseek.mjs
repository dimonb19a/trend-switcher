// Slow-brain contract tests (TR-09): AGENT_TEST=1 node --test agent/test-deepseek.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm, estimateCostUsd, parseAnswer } from './deepseek.mjs';
import { agreeingSummary, makeCfg } from './test-helpers.mjs';

const cfg = makeCfg({ DEEPSEEK_API_KEY: 'test-key-not-real' });
const env = { DEEPSEEK_API_KEY: 'test-key-not-real' };
const envelope = (content, finish = 'stop') => ({ ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 500, completion_tokens: 40 } }) });
const ask = (fetchImpl) => confirm({ stateText: 'synthetic public market', judgeSummary: agreeingSummary('USDC'), candidate: 'USDC', position: { side: 'ETH' } }, { cfg, fetchImpl, env });

test('the time-bounded veto request pins non-thinking JSON after live probes truncated', async () => {
  let body;
  const answer = await ask(async (_url, options) => {
    body = JSON.parse(options.body);
    return envelope('{"stance":"HOLD","confidence":0.8}');
  });
  assert.equal(answer.ok, true);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('boolean, array, string or null confidence never approve and never throw', async () => {
  for (const value of [true, [1], '0.9', null, NaN, 1.5, -0.1]) {
    const r = await ask(async () => envelope(JSON.stringify({ stance: 'USDC', confidence: value, reasons: [] })));
    assert.equal(r.ok, false, `confidence ${JSON.stringify(value)} must not be accepted`);
    assert.equal(r.agrees, undefined);
  }
  const r = await ask(async () => envelope('null'));
  assert.equal(r.ok, false);
});

test('a valid agreeing answer confirms; a disagreeing or low-confidence answer does not', async () => {
  const yes = await ask(async () => envelope(JSON.stringify({ stance: 'USDC', confidence: 0.8, reasons: ['trend down'] })));
  assert.equal(yes.ok, true); assert.equal(yes.agrees, true); assert.equal(yes.model, 'deepseek-flash');
  assert.ok(Number.isFinite(yes.costUsd) && yes.costUsd > 0, 'cost estimated from usage');
  const hold = await ask(async () => envelope(JSON.stringify({ stance: 'HOLD', confidence: 0.9 })));
  assert.equal(hold.ok, true); assert.equal(hold.agrees, false);
  const weak = await ask(async () => envelope(JSON.stringify({ stance: 'USDC', confidence: 0.5 })));
  assert.equal(weak.agrees, false);
});

test('truncated, malformed or non-JSON answers are "no answer"', async () => {
  assert.equal((await ask(async () => envelope('{"stance":"USDC","confidence":0.9}', 'length'))).ok, false, 'finish_reason length');
  assert.equal((await ask(async () => envelope('not json'))).ok, false);
  assert.equal((await ask(async () => envelope(JSON.stringify({ stance: 'usdc', confidence: 0.9 })))).ok, false, 'stance must be exact');
  assert.equal((await ask(async () => envelope(JSON.stringify({ stance: 'USDC', confidence: 0.9, reasons: [1] })))).ok, false, 'reasons must be strings');
  assert.equal((await ask(async () => ({ ok: false, status: 500 }))).ok, false);
  assert.equal((await ask(async () => { throw new Error('boom'); })).ok, false);
});

test('without a key or with a HOLD candidate nothing is sent', async () => {
  let called = 0;
  const noKey = await confirm({ stateText: 's', judgeSummary: agreeingSummary('USDC'), candidate: 'USDC', position: { side: 'ETH' } }, { cfg: makeCfg(), fetchImpl: async () => { called += 1; }, env: {} });
  assert.equal(noKey.ok, false); assert.equal(called, 0);
  const hold = await confirm({ stateText: 's', judgeSummary: agreeingSummary('USDC'), candidate: 'HOLD', position: { side: 'ETH' } }, { cfg, fetchImpl: async () => { called += 1; }, env });
  assert.equal(hold.ok, false); assert.equal(called, 0);
});

test('parseAnswer and the cost estimate are strict and finite', () => {
  assert.equal(parseAnswer('[]'), null);
  assert.deepEqual(parseAnswer('{"stance":"ETH","confidence":1}'), { stance: 'ETH', confidence: 1, reasons: [] });
  assert.equal(estimateCostUsd(null), null);
  const c = estimateCostUsd({ prompt_tokens: 1_000_000, completion_tokens: 0 }, new Date('2026-09-22T12:00:00Z'));
  assert.ok(c === 0.15 || c === 0.3, `off-peak or peak miss price, got ${c}`);
});
