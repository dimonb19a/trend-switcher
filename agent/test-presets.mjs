// Risk presets and the two vote bases: AGENT_TEST=1 node --test agent/test-presets.mjs
// The forecast preset is the rule of the first paper sessions (a judgment votes only on a judged
// 15-minute move); the trend presets vote on the judge's regime call. Fakes only: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_PRESETS, describeConfig, loadConfig } from './config.mjs';
import { agreesWith } from './policy.mjs';
import { confirm } from './deepseek.mjs';
import { buildReport } from './report.mjs';
import { agreeingSummary, makeCfg, makeHarness } from './test-helpers.mjs';

const regimeOnly = (regime, over = {}) => ({ regime, regimeP: 0.7, direction: 'flat', directionP: 0.9, upP: 0.05, downP: 0.05, quality: 'bad', qualityP: 0.9, riskOffP: 0.1, ...over });

test('presets: trend is the default; forecast is the control rule of the first sessions; explicit keys override', () => {
  assert.deepEqual(Object.keys(RISK_PRESETS), ['trend', 'trend-fast', 'forecast']);
  const trend = makeCfg();
  assert.equal(trend.riskPreset, 'trend'); assert.equal(trend.voteBasis, 'regime'); assert.equal(trend.voteWindow, 6); assert.equal(trend.voteMin, 5); assert.equal(trend.minRegimeP, 0.5);
  const forecast = makeCfg({ RISK_PRESET: 'forecast' });
  assert.equal(forecast.voteBasis, 'forecast'); assert.equal(forecast.voteWindow, 6); assert.equal(forecast.voteMin, 5);
  const fast = makeCfg({ RISK_PRESET: 'Trend-Fast' });
  assert.equal(fast.voteBasis, 'regime'); assert.equal(fast.voteWindow, 4); assert.equal(fast.voteMin, 3);
  const over = makeCfg({ RISK_PRESET: 'trend', VOTE_MIN: '4', VOTE_BASIS: 'forecast', MIN_REGIME_P: '0.65' });
  assert.equal(over.voteMin, 4); assert.equal(over.voteBasis, 'forecast'); assert.equal(over.minRegimeP, 0.65);
  assert.throws(() => makeCfg({ RISK_PRESET: 'strict' }), /RISK_PRESET/u, 'the old name is gone, not silently mapped');
  assert.throws(() => makeCfg({ VOTE_BASIS: 'vibes' }), /VOTE_BASIS/u);
  assert.throws(() => makeCfg({ MIN_REGIME_P: '0.3' }), /MIN_REGIME_P/u);
  const described = describeConfig(trend);
  assert.equal(described.riskPreset, 'trend'); assert.equal(described.voteBasis, 'regime');
  assert.notEqual(describeConfig(forecast).voteBasis, described.voteBasis, 'two bases hash differently');
});

test('forecast basis: a regime call without a 15-minute forecast never votes', () => {
  const cfg = makeCfg({ RISK_PRESET: 'forecast' });
  assert.equal(agreesWith(regimeOnly('trend_up'), 'ETH', cfg), false);
  assert.equal(agreesWith(regimeOnly('trend_down'), 'USDC', cfg), false);
  assert.equal(agreesWith(agreeingSummary('ETH'), 'ETH', cfg), true, 'the full forecast still votes');
});

test('regime basis (trend): the regime call is the vote; quality is not consulted; a confident contrary forecast vetoes', () => {
  const cfg = makeCfg({ RISK_PRESET: 'trend' });
  assert.equal(agreesWith(regimeOnly('trend_up'), 'ETH', cfg), true);
  assert.equal(agreesWith(regimeOnly('trend_down'), 'USDC', cfg), true);
  assert.equal(agreesWith(regimeOnly('trend_up'), 'USDC', cfg), false, 'the regime names the side');
  assert.equal(agreesWith(regimeOnly('range'), 'ETH', cfg), false, 'no trend regime, no vote');
  assert.equal(agreesWith(regimeOnly('chaotic'), 'USDC', cfg), false);
  assert.equal(agreesWith(regimeOnly('trend_up', { quality: 'good' }), 'ETH', cfg), true, 'quality changes nothing on this basis');
  assert.equal(agreesWith(regimeOnly('trend_up', { regimeP: 0.49 }), 'ETH', cfg), false, 'below the regime floor');
  assert.equal(agreesWith(regimeOnly('trend_up', { regimeP: NaN }), 'ETH', cfg), false, 'non-finite regime probability never votes');
  assert.equal(agreesWith(regimeOnly('trend_up', { direction: 'down', directionP: 0.8 }), 'ETH', cfg), false, 'a confident contrary forecast vetoes');
  assert.equal(agreesWith(regimeOnly('trend_up', { direction: 'down', directionP: 0.55 }), 'ETH', cfg), true, 'an unconfident contrary forecast does not');
  assert.equal(agreesWith(regimeOnly('trend_up', { direction: 'up', directionP: 0.8 }), 'ETH', cfg), true, 'an agreeing forecast is fine');
  assert.equal(agreesWith(regimeOnly('trend_up', { riskOffP: 0.7 }), 'ETH', cfg), false, 'risk-off above the ceiling never votes on any basis');
  assert.equal(agreesWith(regimeOnly('trend_up', { directionP: NaN }), 'ETH', cfg), false);
  assert.equal(agreesWith(null, 'ETH', cfg), false);
  assert.equal(agreesWith(regimeOnly('trend_up'), 'HOLD', cfg), false);
});

test('end to end: the same regime-only judgments switch under the trend preset and do nothing under forecast', async () => {
  const judgments = () => regimeOnly('trend_down');
  const trend = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' }, summary: judgments, trendUp: false });
  const strict = makeHarness({ env: { RISK_PRESET: 'forecast', PAPER_CAPITAL_USD: '1000' }, summary: judgments, trendUp: false });
  try {
    const t = await trend.advance(6); const s = await strict.advance(6);
    assert.equal(t.at(-1).switched, true, 'trend: five agreeing regime calls, the trend filter and the slow brain agree');
    assert.equal(trend.ledger.db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 1);
    assert.equal(strict.ledger.db.prepare('SELECT COUNT(*) AS n FROM switches').get().n, 0, 'forecast: no 15-minute forecast, no vote');
    assert.ok(s.every((out) => !out.switched));
    const rt = buildReport({ db: trend.ledger.db }); const rs = buildReport({ db: strict.ledger.db });
    assert.equal(rt.funnel.leaningVotes.USDC, 6, 'the report reads the basis from the stored configuration');
    assert.equal(rs.funnel.leaningVotes.USDC, undefined);
    assert.equal(rt.funnel.executed, 1); assert.equal(rs.funnel.executed, 0);
    assert.equal(trend.ledger.kv.get(`config:${trend.ledger.provenance.configHash}`).riskPreset, 'trend');
  } finally { trend.ledger.close(); strict.ledger.close(); }
});

test('SLOW_BRAIN_FRAME: the regime frame asks about regime persistence and withholds the 15-minute answers; forecast is the default; no cost figure in either prompt (P1)', async () => {
  assert.equal(makeCfg().slowBrainFrame, 'forecast');
  assert.equal(makeCfg({ SLOW_BRAIN_FRAME: 'Regime' }).slowBrainFrame, 'regime');
  assert.throws(() => makeCfg({ SLOW_BRAIN_FRAME: 'vibes' }), /SLOW_BRAIN_FRAME/u);
  assert.notEqual(describeConfig(makeCfg()).slowBrainFrame, describeConfig(makeCfg({ SLOW_BRAIN_FRAME: 'regime' })).slowBrainFrame, 'the frame is part of the hashed configuration');
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{"stance":"USDC","confidence":0.8,"reasons":["ok"]}' } }], usage: { prompt_tokens: 500, completion_tokens: 40 } }) }; };
  const env = { DEEPSEEK_API_KEY: 'test-key-not-real' };
  const args = { stateText: 'Execution cost: 0.07% round trip.', judgeSummary: regimeOnly('trend_down'), candidate: 'USDC', position: { side: 'ETH' } };
  assert.equal((await confirm(args, { cfg: makeCfg({ SLOW_BRAIN_FRAME: 'regime', ...env }), fetchImpl, env })).ok, true);
  assert.equal((await confirm(args, { cfg: makeCfg(env), fetchImpl, env })).ok, true);
  const [regime, forecast] = bodies;
  const sys = (b) => b.messages[0].content; const user = (b) => b.messages.find((m) => m.role === 'user').content;
  assert.match(sys(regime), /regime is likely to persist/u); assert.doesNotMatch(sys(forecast), /regime is likely to persist/u);
  assert.doesNotMatch(user(regime), /direction over 15 minutes|switch quality/u, 'the regime frame withholds the 15-minute answers');
  assert.match(user(forecast), /direction over 15 minutes .* switch quality/u);
  assert.match(user(regime), /regime trend_down \(p=0\.70\), risk-off probability 0\.10/u);
  for (const b of bodies) assert.doesNotMatch(sys(b), /\d+(\.\d+)? ?%/u, 'no cost or threshold percentage in any system prompt');
});

test('the slow brain is told which basis the candidate stands on, without any number of ours (P1)', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{"stance":"USDC","confidence":0.8,"reasons":["ok"]}' } }], usage: { prompt_tokens: 500, completion_tokens: 40 } }) }; };
  const env = { DEEPSEEK_API_KEY: 'test-key-not-real' };
  const args = { stateText: 'Execution cost: 0.07% round trip.', judgeSummary: regimeOnly('trend_down'), candidate: 'USDC', position: { side: 'ETH' } };
  const trend = await confirm(args, { cfg: makeCfg(env), fetchImpl, env });
  const strict = await confirm(args, { cfg: makeCfg({ RISK_PRESET: 'forecast', ...env }), fetchImpl, env });
  assert.equal(trend.ok, true); assert.equal(strict.ok, true);
  const user = (b) => b.messages.find((m) => m.role === 'user').content;
  assert.match(user(bodies[0]), /Basis of the candidate: regime-following/u);
  assert.match(user(bodies[1]), /Basis of the candidate: 15-minute forecast/u);
  for (const b of bodies) {
    const basisLine = user(b).split('\n').find((line) => line.startsWith('Basis of the candidate'));
    assert.ok(!/\d(?!5 minutes|5-minute)/u.test(basisLine.replace(/15[- ]minute/gu, '')), 'no cost or threshold number in the basis line');
    assert.equal(b.messages[0].content.includes('0.1'), false, 'the system prompt carries no cost figure');
  }
});
