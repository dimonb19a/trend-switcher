// The judge client's credential policy and price contract: AGENT_TEST=1 node --test agent/test-judge-client.mjs
// Synthetic keys and fake fetch only; nothing is sent anywhere. No provider is built in: every test names its endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from './judge-client.mjs';
import { loadConfig } from './config.mjs';

const q = { x: { type: 'noul', instructions: 'synthetic' } };
const MODEL = 'judge-model-1';
const ORIGIN = 'https://judge.example';
const answer = { model: MODEL, usage: { input_tokens: 10, output_tokens: 1 }, answers: { x: { type: 'noul', noul: 0.5 } } };
const ok = (value) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) });
const KEY = 'synthetic-judge-key-not-real';
const ask = (opts) => client.askJudge({ state: 's', questions: q, model: MODEL }, opts);

test('no provider is built in: without an endpoint or a model pin the client refuses before any request', async () => {
  let fetched = 0; const fetchImpl = async () => { fetched += 1; return ok(answer); };
  await assert.rejects(ask({ env: {}, apiKey: KEY, fetchImpl }), /set JUDGE_BASE_URL/u);
  await assert.rejects(client.askJudge({ state: 's', questions: q }, { baseUrl: ORIGIN, env: {}, apiKey: KEY, fetchImpl }), /set JUDGE_MODEL/u);
  assert.throws(() => client.endpointBaseUrl({}), /set JUDGE_BASE_URL/u);
  assert.deepEqual(client.keyOrigins({}), []);
  assert.equal(fetched, 0);
});

test('a third-party HTTPS origin is refused before the key is resolved and before any request', async () => {
  let fetched = 0;
  await assert.rejects(ask({ baseUrl: 'https://unrelated.example', env: { JUDGE_BASE_URL: ORIGIN }, fetchImpl: async () => { fetched += 1; return ok(answer); } }),
    /not allowed to receive the judge key/u);
  assert.equal(fetched, 0);
});

test('localhost is a name, not a loopback literal: plain http is refused, https://localhost is an ordinary provider that gets the key', async () => {
  await assert.rejects(ask({ baseUrl: 'http://localhost:9876', apiKey: KEY, env: { JUDGE_BASE_URL: 'http://localhost:9876' }, fetchImpl: async () => ok(answer) }), client.JudgeError);
  let headers = null;
  await ask({ baseUrl: 'https://localhost', apiKey: KEY, env: { JUDGE_BASE_URL: 'https://localhost' }, fetchImpl: async (_url, init) => { headers = init.headers; return ok(answer); } });
  assert.equal(headers.Authorization, `Bearer ${KEY}`); // the no-key rule applies to loopback LITERALS only, never to a name DNS may resolve anywhere
});

test('a loopback-literal stand-in never sees the provider key and needs none', async () => {
  let headers = null;
  const out = await ask({ baseUrl: 'http://127.0.0.1:9876', env: {}, fetchImpl: async (_url, init) => { headers = init.headers; return ok(answer); } });
  assert.equal(headers.Authorization, undefined);
  assert.equal(out.model, MODEL);
});

test('the configured provider origin gets the key; JUDGE_KEY_ORIGINS extends the allowed list explicitly', async () => {
  let headers = null; let url = null;
  await ask({ apiKey: KEY, env: { JUDGE_BASE_URL: ORIGIN }, fetchImpl: async (u, init) => { url = u; headers = init.headers; return ok(answer); } });
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(url, `${ORIGIN}/v1/systemone`);
  headers = null;
  await ask({ baseUrl: 'https://judge.custom.example', apiKey: KEY, env: { JUDGE_BASE_URL: ORIGIN, JUDGE_KEY_ORIGINS: 'https://judge.custom.example' }, fetchImpl: async (_url, init) => { headers = init.headers; return ok(answer); } });
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.throws(() => client.keyOrigins({ JUDGE_KEY_ORIGINS: 'https://a.example/path' }), /JUDGE_KEY_ORIGINS/u);
  assert.deepEqual(client.keyOrigins({ JUDGE_BASE_URL: ORIGIN }), [ORIGIN]);
  assert.deepEqual(client.keyOrigins({ JUDGE_BASE_URL: ORIGIN, JUDGE_KEY_ORIGINS: `${ORIGIN}, https://b.example` }), [ORIGIN, 'https://b.example']);
});

test('a redirect is refused and a 401 is not retried', async () => {
  let calls = 0; const env = { JUDGE_BASE_URL: ORIGIN };
  await assert.rejects(ask({ apiKey: KEY, env, fetchImpl: async () => { calls += 1; return { ok: false, status: 302, headers: { get: () => null }, body: null }; } }), /redirect refused/u);
  await assert.rejects(ask({ apiKey: KEY, env, maxAttempts: 3, fetchImpl: async () => { calls += 1; return { ok: false, status: 401, headers: { get: () => null }, body: null }; } }), /HTTP 401/u);
  assert.equal(calls, 2);
});

test('prices: absent → unknown, blank or malformed → a configuration problem (never a zero), explicit 0 → zero', () => {
  assert.equal(client.priceConfigured({}), false); assert.deepEqual(client.priceProblems({}), []); assert.equal(client.priceUsd(answer.usage, {}), null);
  const blank = { JUDGE_PRICE_USD_PER_MTOK_INPUT: '', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: ' ' };
  assert.equal(client.priceConfigured(blank), false); assert.equal(client.priceUsd(answer.usage, blank), null); assert.equal(client.priceProblems(blank).length, 2);
  const bad = { JUDGE_PRICE_USD_PER_MTOK_INPUT: 'free', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: '-1' };
  assert.equal(client.priceConfigured(bad), false); assert.equal(client.priceProblems(bad).length, 2);
  const zero = { JUDGE_PRICE_USD_PER_MTOK_INPUT: '0', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: '0' };
  assert.equal(client.priceConfigured(zero), true); assert.deepEqual(client.priceProblems(zero), []); assert.equal(client.priceUsd(answer.usage, zero), 0);
  const priced = { JUDGE_PRICE_USD_PER_MTOK_INPUT: '1', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: '2' };
  assert.equal(client.priceUsd({ input_tokens: 1_000_000, output_tokens: 500_000 }, priced), 2);
  for (const usage of [{ input_tokens: 1.5, output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1 }, null, 'usage']) assert.equal(client.priceUsd(usage, priced), null);
});

test('a reply whose answers fail validation keeps its usage and model on the error', async () => {
  await assert.rejects(ask({ apiKey: KEY, env: { JUDGE_BASE_URL: ORIGIN }, fetchImpl: async () => ok({ ...answer, answers: {} }) }),
    (e) => e instanceof client.JudgeError && e.usage.input_tokens === 10 && e.model === MODEL);
});

test('the configuration refuses a blank price, a judge origin outside the policy and a timeout above the quote deadline, and loads with a loopback stand-in or no judge at all', () => {
  const base = { PAPER_CAPITAL_USD: '1000' };
  assert.throws(() => loadConfig({ ...base, JUDGE_PRICE_USD_PER_MTOK_INPUT: '', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: '0.5' }), /JUDGE_PRICE_USD_PER_MTOK_INPUT is set but blank/u);
  assert.throws(() => loadConfig({ ...base, JUDGE_PRICE_USD_PER_MTOK_INPUT: '0.5', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: 'n/a' }), /JUDGE_PRICE_USD_PER_MTOK_OUTPUT is not a non-negative number/u);
  assert.throws(() => loadConfig({ ...base, JUDGE_BASE_URL: 'http://localhost:9876' }), /JUDGE_BASE_URL/u);
  assert.throws(() => loadConfig({ ...base, JUDGE_BASE_URL: 'https://judge.example/v1' }), /JUDGE_BASE_URL/u);
  assert.throws(() => loadConfig({ ...base, RPC_TIMEOUT_MS: '30000', QUOTE_DEADLINE_MS: '20000' }), /RPC_TIMEOUT_MS must not exceed QUOTE_DEADLINE_MS/u);
  const local = loadConfig({ ...base, JUDGE_BASE_URL: 'http://127.0.0.1:9876' });
  assert.equal(local.judgeBaseUrl, 'http://127.0.0.1:9876'); assert.equal(local.judgePriceConfigured, false);
  const c = loadConfig(base);
  assert.equal(c.judgeBaseUrl, null); assert.equal(c.judgeModel, null);
  assert.equal(c.quoteDeadlineMs, 20_000); assert.equal(c.rpcTimeoutMs, 8_000); assert.equal(c.quoteFailureCooldownMs, 120_000);
  const custom = loadConfig({ ...base, JUDGE_BASE_URL: ORIGIN, JUDGE_MODEL: MODEL, JUDGE_PRICE_USD_PER_MTOK_INPUT: '0', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: '0' });
  assert.equal(custom.judgeBaseUrl, ORIGIN); assert.equal(custom.judgeModel, MODEL); assert.equal(custom.judgePriceConfigured, true);
});
