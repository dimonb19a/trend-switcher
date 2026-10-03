// Configuration schema tests (TR-09): AGENT_TEST=1 node --test agent/test-config.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, OWNER_CAP_USD, describeConfig, loadConfig } from './config.mjs';

const FAKE_ACCOUNT = '0x1111111111111111111111111111111111111111';
const env = (over = {}) => ({ AGENT_TEST: '1', ACCOUNT_ADDRESS: FAKE_ACCOUNT, ...over });

test('defaults load in paper mode with the documented limits', () => {
  const c = loadConfig(env());
  assert.equal(c.mode, 'paper');
  assert.equal(c.maxCapitalUsd, OWNER_CAP_USD);
  assert.equal(c.requireDeepseek, true);
  assert.equal(c.voteMin <= c.voteWindow, true);
  assert.equal(c.hasPrivateKey, false);
});

test('zero minimum votes and 100% slippage are refused at startup', () => {
  assert.throws(() => loadConfig(env({ VOTE_MIN: '0' })), ConfigError);
  assert.throws(() => loadConfig(env({ SLIPPAGE_BPS: '10000' })), ConfigError);
});

test('relations between limits are enforced', () => {
  assert.throws(() => loadConfig(env({ VOTE_MIN: '7', VOTE_WINDOW: '6' })), /VOTE_MIN/u);
  assert.throws(() => loadConfig(env({ KILL_LOSS_PCT: '2', MAX_DAILY_LOSS_PCT: '3' })), /KILL_LOSS_PCT/u);
  assert.throws(() => loadConfig(env({ EXPECTED_SLIPPAGE_BPS: '60', SLIPPAGE_BPS: '50' })), /EXPECTED_SLIPPAGE_BPS/u);
});

test('the owner cap of 100 dollars cannot be raised through the environment', () => {
  assert.throws(() => loadConfig(env({ MAX_CAPITAL_USD: '200' })), /MAX_CAPITAL_USD/u);
  assert.equal(loadConfig(env({ MAX_CAPITAL_USD: '50' })).maxCapitalUsd, 50);
});

test('non-numeric, non-finite and out-of-range values are refused', () => {
  assert.throws(() => loadConfig(env({ TICK_MS: 'fast' })), /TICK_MS/u);
  assert.throws(() => loadConfig(env({ TICK_MS: '100' })), /TICK_MS/u);
  assert.throws(() => loadConfig(env({ MIN_DIRECTION_P: 'NaN' })), /MIN_DIRECTION_P/u);
  assert.throws(() => loadConfig(env({ GAS_RESERVE_ETH: '1' })), /GAS_RESERVE_ETH/u);
});

test('mode must be paper or live; live always requires the slow brain', () => {
  assert.throws(() => loadConfig(env({ MODE: 'test' })), /MODE/u);
  assert.equal(loadConfig(env({ MODE: 'paper', REQUIRE_DEEPSEEK: 'false' })).requireDeepseek, false);
  assert.equal(loadConfig(env({ MODE: 'live', REQUIRE_DEEPSEEK: 'false' })).requireDeepseek, true);
});

test('UNKNOWN-billing continuation is explicit, virtual-paper-only, with a bounded planning reserve', () => {
  const c = loadConfig(env({ MODE: 'paper', PAPER_CAPITAL_USD: '1000', PAPER_CONTINUE_UNKNOWN_BILLING: 'true' }));
  assert.equal(c.paperContinueUnknownBilling, true);
  assert.equal(c.paperUnknownBillReserveUsd, 0.001);
  assert.throws(() => loadConfig(env({ MODE: 'live', PAPER_CONTINUE_UNKNOWN_BILLING: 'true' })), /paper-only/u);
  assert.throws(() => loadConfig(env({ PAPER_CONTINUE_UNKNOWN_BILLING: 'true' })), /needs a virtual capital/u);
  assert.equal(loadConfig(env({ PAPER_CAPITAL_USD: '250', PAPER_CONTINUE_UNKNOWN_BILLING: 'true' })).paperContinueUnknownBilling, true, 'any virtual capital, not one fixed figure');
  assert.throws(() => loadConfig(env({ PAPER_UNKNOWN_BILL_RESERVE_USD: '0.001' })), /requires PAPER_CONTINUE_UNKNOWN_BILLING/u);
});

test('the account address is never built in: hex when given, required in live, optional in paper only with a virtual capital', () => {
  assert.throws(() => loadConfig(env({ ACCOUNT_ADDRESS: 'not-an-address' })), /ACCOUNT_ADDRESS/u);
  assert.throws(() => loadConfig(env({ RPC_URL: 'http://insecure.example' })), /RPC_URL/u);
  assert.equal(loadConfig({ AGENT_TEST: '1' }).accountAddress, null, 'a bare paper configuration loads; the runner refuses to start without a wallet or a virtual capital');
  const virtual = loadConfig({ AGENT_TEST: '1', PAPER_CAPITAL_USD: '1000' });
  assert.equal(virtual.accountAddress, null); assert.match(virtual.lockFile, /agent-8453-paper\.lock$/u);
  assert.throws(() => loadConfig({ AGENT_TEST: '1', MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real' }), /ACCOUNT_ADDRESS is required in live/u);
});

test('the judge is configured from the environment only: model pin, endpoint, key and prices as booleans', () => {
  const c = loadConfig(env());
  assert.equal(c.judgeModel, null); assert.equal(c.judgeBaseUrl, null); assert.equal(c.hasJudgeKey, false); assert.equal(c.judgePriceConfigured, false); // no provider is built in
  const set = loadConfig(env({ JUDGE_API_KEY: 'test-key-not-real', JUDGE_MODEL: 'judge-model-9', JUDGE_PRICE_USD_PER_MTOK_INPUT: '0.5', JUDGE_PRICE_USD_PER_MTOK_OUTPUT: '0' }));
  assert.equal(set.hasJudgeKey, true); assert.equal(set.judgeModel, 'judge-model-9'); assert.equal(set.judgePriceConfigured, true);
  assert.throws(() => loadConfig(env({ JUDGE_BASE_URL: 'not a url' })), /JUDGE_BASE_URL/u);
  const described = JSON.stringify(describeConfig(set));
  assert.ok(!/test-key-not-real|JUDGE_API_KEY/u.test(described), 'the key never appears in the described configuration');
  assert.equal(describeConfig(set).judgeKey, 'set');
});

test('VOTE_ACCEPT_QUALITY is a risk-profile knob: good only by default, a subset of good,marginal,bad otherwise', () => {
  assert.deepEqual(loadConfig(env()).voteAcceptQuality, ['good']);
  assert.deepEqual(loadConfig(env({ VOTE_ACCEPT_QUALITY: 'marginal, good' })).voteAcceptQuality, ['good', 'marginal']);
  assert.throws(() => loadConfig(env({ VOTE_ACCEPT_QUALITY: 'great' })), /VOTE_ACCEPT_QUALITY/u);
});

test('the virtual capital accepts a size ladder up to one million and refuses more', () => {
  assert.equal(makeCfg({ PAPER_CAPITAL_USD: '1000000' }).paperCapitalUsd, 1_000_000);
  assert.equal(makeCfg({ PAPER_CAPITAL_USD: '1000000' }).maxCapitalUsd, 2_000_000);
  assert.throws(() => makeCfg({ PAPER_CAPITAL_USD: '1000001' }), /PAPER_CAPITAL_USD/u);
});
