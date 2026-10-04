// Regressions for the virtual-capital paper mode (agent v2.6):
// a paper run may open a VIRTUAL capital instead of mirroring the real wallet, and in that run the
// notional cap sits above the capital; the live cap stays the owner's $100 and no combination of
// settings raises it (paper-only keys are refused in live, the real-money key is refused next to a
// virtual capital). The slow-brain cooldown leaves a `deferred` decision row per candidate-tick, so a
// day's funnel has its denominators (R5-P2). The effective configuration is stored in the ledger under
// its hash, without secrets, so a report can name the tick and the capital behind every row. The
// DeepSeek prompt carries no fixed cost figure (P1): the cost is the state's execution-cost line.
// AGENT_TEST=1 node --test agent/test-paper-capital.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, OWNER_CAP_USD, describeConfig, loadConfig } from './config.mjs';
import { SYSTEM } from './deepseek.mjs';
import { computeFeatures, renderState } from './features.mjs';
import { T0, agreeingSummary, makeCfg, makeFeed, makeHarness, makeSnapshot } from './test-helpers.mjs';

const env = (over = {}) => ({ AGENT_TEST: '1', ...over });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const rows = (h, sql, ...args) => h.ledger.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const VIRTUAL = { PAPER_CAPITAL_USD: '1000' };

test('config: a virtual paper capital opens with a cap of twice the capital by default; the cap is settable within [1×, 10×]', () => {
  const c = loadConfig(env(VIRTUAL));
  assert.equal(c.mode, 'paper'); assert.equal(c.paperCapitalUsd, 1000); assert.equal(c.maxCapitalUsd, 2000);
  assert.equal(loadConfig(env({ ...VIRTUAL, PAPER_NOTIONAL_CAP_USD: '1500' })).maxCapitalUsd, 1500);
  assert.equal(loadConfig(env({ ...VIRTUAL, PAPER_NOTIONAL_CAP_USD: '1000' })).maxCapitalUsd, 1000, 'exactly the capital is allowed (and blocks after the first gain — see the engine witness)');
  assert.throws(() => loadConfig(env({ ...VIRTUAL, PAPER_NOTIONAL_CAP_USD: '999' })), /PAPER_NOTIONAL_CAP_USD/u, 'a cap below the capital is refused');
  assert.throws(() => loadConfig(env({ ...VIRTUAL, PAPER_NOTIONAL_CAP_USD: '10001' })), /PAPER_NOTIONAL_CAP_USD/u, 'a cap above ten times the capital is refused');
  assert.throws(() => loadConfig(env({ PAPER_CAPITAL_USD: '5' })), /PAPER_CAPITAL_USD/u, 'a capital below $10 is refused');
  assert.throws(() => loadConfig(env({ PAPER_CAPITAL_USD: 'lots' })), /PAPER_CAPITAL_USD/u);
  assert.throws(() => loadConfig(env({ PAPER_NOTIONAL_CAP_USD: '500' })), /PAPER_NOTIONAL_CAP_USD needs PAPER_CAPITAL_USD/u, 'a paper cap without a virtual capital is meaningless and refused');
});

test('config: the owner cap for real money is untouched — paper-only keys are refused in live, the real-money key is refused next to a virtual capital', () => {
  const live = { MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real', ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111' };
  assert.equal(loadConfig(env(live)).maxCapitalUsd, OWNER_CAP_USD);
  assert.equal(loadConfig(env(live)).paperCapitalUsd, null);
  assert.throws(() => loadConfig(env({ ...live, PAPER_CAPITAL_USD: '1000' })), /paper-only/u, 'a virtual capital never applies to live');
  assert.throws(() => loadConfig(env({ ...live, PAPER_NOTIONAL_CAP_USD: '2000' })), /paper-only/u, 'a paper cap never applies to live');
  assert.throws(() => loadConfig(env({ ...live, MAX_CAPITAL_USD: '200' })), /MAX_CAPITAL_USD/u, 'the live cap cannot be raised, as before');
  assert.throws(() => loadConfig(env({ MAX_CAPITAL_USD: '200' })), /MAX_CAPITAL_USD/u, 'nor the cap of a paper run that mirrors the real wallet');
  assert.throws(() => loadConfig(env({ ...VIRTUAL, MAX_CAPITAL_USD: '50' })), /MAX_CAPITAL_USD is the real-money cap/u, 'the two caps are never mixed in one configuration');
  assert.equal(loadConfig(env()).paperCapitalUsd, null, 'without the key the paper wallet mirrors the real one, as before');
  for (const bad of [ConfigError]) assert.ok(bad, 'ConfigError is the refusal type');
});

test('config: the virtual capital and its cap are part of the described configuration, so two runs with different capital have different hashes', () => {
  const a = describeConfig(loadConfig(env(VIRTUAL))); const b = describeConfig(loadConfig(env({ PAPER_CAPITAL_USD: '500' }))); const c = describeConfig(loadConfig(env()));
  assert.equal(a.paperCapitalUsd, 1000); assert.equal(a.maxCapitalUsd, 2000);
  assert.equal(b.paperCapitalUsd, 500); assert.equal(b.maxCapitalUsd, 1000);
  assert.equal(c.paperCapitalUsd, null); assert.equal(c.maxCapitalUsd, OWNER_CAP_USD);
  assert.notDeepEqual(a, b); assert.notDeepEqual(a, c);
  assert.equal(a.privateKey, 'unset'); assert.equal(a.deepseekKey, 'unset');
});

test('engine: a virtual capital opens in ETH at the tape price on the first tick, the initial equity is the capital, and a $1000 switch is NOT refused by the cap', async () => {
  const h = makeHarness({ env: VIRTUAL, chainOptions: { executionPrice: 2700 } }); // the fake real wallet holds 0.005 ETH; the tape says 3000, the quoter at execution 2700
  const outs = await h.advance(6);
  const paper = h.ledger.kv.get('paper:balances');
  assert.equal(paper.source, 'PAPER_CAPITAL_USD'); assert.equal(paper.capitalUsd, 1000); assert.equal(paper.openingPrice, 3000);
  const initial = h.ledger.kv.get('initial:paper');
  assert.ok(near(initial.walletUsd, 1000), `initial wallet ${initial.walletUsd}`);
  assert.equal(outs[5].switched, true, JSON.stringify(outs[5]));
  const sw = h.ledger.getSwitch(1);
  assert.equal(sw.status, 'done'); assert.ok(near(sw.notional_usd, 1000), `notional ${sw.notional_usd}`);
  const after = h.ledger.kv.get('paper:balances');
  assert.equal(after.ethSide, 0);
  assert.ok(near(after.usdc, (1000 / 3000) * 2700 * (1 - 0.0002), 1e-6), `usdc ${after.usdc}: the whole virtual position filled at the execution quote`);
  assert.equal(h.chain.calls.sends.length, 0, 'nothing is ever broadcast in paper');
  assert.deepEqual(rows(h, 'SELECT outcome, stage FROM decisions ORDER BY id'), [{ outcome: 'execute', stage: 'execute' }]);
});

test('engine: the same six judgments at the same virtual capital under the OLD rule (a $100 cap) are refused — the witness of why the change exists', async () => {
  const h = makeHarness({ env: VIRTUAL });
  h.cfg = { ...h.cfg, maxCapitalUsd: 100 }; // not reachable through the configuration any more; the engine holds its own reference, so patch the policy input instead
  const { limits } = await import('./policy.mjs');
  const lim = limits({ now: T0, features: { tapeEventAgeSec: 1, candlesEventAgeSec: 60, dataQuality: { degraded: false, reasons: [] } }, position: { lastSwitchAt: null }, stats: { halt: null, pendingSwitches: 0, totalNetPnlPct: 0, dailyNetPnlPct: 0, inferenceTodayUsd: 0, switchesToday: 0 }, notionalUsd: 1000 }, h.cfg);
  assert.equal(lim.ok, false); assert.ok(lim.problems.some((p) => /above the pilot cap \$100/u.test(p)), JSON.stringify(lim.problems));
  const out = await h.last(6);
  assert.equal(out.switched, true, 'with the paper cap of the virtual run the same tick switches');
});

test('engine: a paper cap of exactly the capital blocks the position after its first gain (S1-05 / V12-A) — the reason the default sits at twice the capital', async () => {
  const h = makeHarness({ env: { ...VIRTUAL, PAPER_NOTIONAL_CAP_USD: '1000' } });
  await h.advance(1); // opens the virtual wallet at 3000
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), price: 3030, trendUp: false }).snapshot; // +1 %: the ETH side is now worth $1010
  const outs = await h.advance(6);
  const blocked = outs.find((o) => o.blocked);
  assert.ok(blocked && blocked.blocked.some((p) => /above the pilot cap \$1000/u.test(p)), JSON.stringify(outs));
  assert.equal(h.ledger.totals().switches, 0);
  const wide = makeHarness({ env: VIRTUAL });
  await wide.advance(1);
  wide.feed.snapshot = makeFeed({ eventAt: wide.clock(), price: 3030, trendUp: false }).snapshot;
  const grown = await wide.advance(6); // the first tick's vote already counts: the window fills on the fifth of these
  assert.ok(grown.some((o) => o.switched === true), `the default cap (2 ×) lets the grown position switch: ${JSON.stringify(grown)}`);
});

test('engine: without a virtual capital the paper wallet still mirrors the real one — the pre-2.6 path is unchanged', async () => {
  const h = makeHarness({ chainOptions: { balances: { eth: 0.005, weth: 0.001, usdc: 3 } } });
  await h.advance(1);
  const paper = h.ledger.kv.get('paper:balances');
  assert.equal(paper.source, 'real wallet');
  assert.ok(near(paper.ethSide, 0.005 - h.cfg.gasReserveEth + 0.001)); assert.equal(paper.usdc, 3);
  assert.equal(paper.capitalUsd, undefined);
});

test('engine: a virtual capital is never opened without a tape price — the read is an error, never a zero wallet', async () => {
  const h = makeHarness({ env: VIRTUAL });
  h.feed.snapshot = () => ({ ...makeSnapshot({ now: h.clock() }), last: null, ticks: [], eventAgeMs: Infinity });
  await assert.rejects(h.engine.readBalances(), /without a tape price/u);
  assert.equal(h.ledger.kv.get('paper:balances'), null, 'nothing was written');
  h.feed.snapshot = makeFeed({ eventAt: h.clock(), trendUp: false }).snapshot;
  const balances = await h.engine.readBalances(); // no hint: the feed's current price opens it
  assert.ok(near(balances.paper.ethSide, 1000 / 3000)); assert.equal(balances.paper.openingPrice, 3000);
});

test('ledger: the effective configuration is stored under its hash, without secrets, so a report can name the tick and the capital of every row', () => {
  const h = makeHarness({ env: { ...VIRTUAL, TICK_MS: '60000', INFERENCE_BUDGET_USD_PER_DAY: '3' } });
  const stored = h.ledger.kv.get(`config:${h.ledger.provenance.configHash}`);
  assert.equal(stored.tickMs, 60_000); assert.equal(stored.paperCapitalUsd, 1000); assert.equal(stored.maxCapitalUsd, 2000); assert.equal(stored.inferenceBudgetUsdPerDay, 3);
  assert.equal(stored.version, '2.12.0'); assert.ok(stored.recordedAt);
  const text = JSON.stringify(stored);
  assert.ok(!/PRIVATE_KEY|DEEPSEEK_API_KEY|JUDGE_API_KEY|0x[0-9a-f]{64}/iu.test(text), 'no key, no key name, no 32-byte hex');
  assert.equal(stored.privateKey, 'unset'); assert.equal(stored.deepseekKey, 'unset'); assert.equal(stored.judgeKey, 'unset');
  assert.equal(stored.judgeHost, 'judge.example'); assert.equal(stored.judgeBaseUrl, undefined, 'the judge endpoint is stored as its host only, like the RPC');
  assert.equal(stored.rpcHost, 'mainnet.base.org'); assert.equal(stored.rpcUrl, undefined, 'the RPC URL (may carry a key) is never stored, only its host');
});

test('engine: a candidate that waits for the slow-brain cooldown leaves one deferred decision per tick, the votes stay, and the wait ends with the cooldown', async () => {
  const h = makeHarness({ confirmFn: () => ({ ok: true, agrees: false, stance: 'HOLD', confidence: 0.9, costUsd: 0.0002 }) });
  const outs = await h.advance(13);
  assert.equal(outs[5].vetoed, 'slow brain', JSON.stringify(outs[5]));
  assert.equal(outs[11].cooldown, true, JSON.stringify(outs[11])); assert.equal(outs[12].cooldown, true, JSON.stringify(outs[12]));
  const deferred = rows(h, "SELECT outcome, stage, candidate, reason FROM decisions WHERE outcome = 'deferred' ORDER BY id");
  assert.equal(deferred.length, 2);
  assert.equal(deferred[0].stage, 'cooldown'); assert.equal(deferred[0].candidate, 'USDC'); assert.match(deferred[0].reason, /^slow-brain cooldown: \d+ s left$/u);
  assert.equal(h.state.confirmCalls, 1, 'the slow brain was not asked again during the cooldown');
  assert.equal(h.engine.votes.items.length, h.cfg.voteWindow, 'a deferred candidate keeps its votes');
  h.state.confirmFn = null;
  h.wait(h.cfg.deepseekCooldownMs);
  const after = await h.last(6); // the old votes are too old after the wait: a fresh run, then the slow brain is asked again
  assert.equal(after.switched, true, JSON.stringify(after));
  assert.equal(h.state.confirmCalls, 2);
});

test('P1: the slow-brain prompt carries no fixed cost figure; the cost it reasons about is the state\'s execution-cost line, which the code fills from the quoter', () => {
  assert.ok(!/\d+(\.\d+)?\s?%/u.test(SYSTEM), `no percentage in the prompt: ${SYSTEM}`);
  assert.match(SYSTEM, /"Execution cost" line of the market state/u);
  const snap = makeSnapshot({ now: T0 });
  const quotes = { at: T0, impactBps: 0.8, expectedSlippagePct: 0.02, tolerancePct: 0.5, costPct: 0.078, sellQuotePrice: 2999, buyQuotePrice: 3001, block: 1 };
  const state = renderState(computeFeatures(snap, quotes, T0), { side: 'ETH', ethPct: 100, lastSwitchMinutes: null, switchesToday: 0, maxSwitchesPerDay: 6 });
  assert.match(state, /^Execution cost: switching the whole position costs about 0\.08%/mu);
});

test('feasibility at $1000 (R5-P1 arithmetic): a full day of judgments at the recorded price stays far inside the daily loss limit; the same charge at the real $12 wallet crosses it', () => {
  for (const [capital, breaches] of [[1000, false], [12, true]]) {
    const h = makeHarness({ env: capital === 12 ? {} : { PAPER_CAPITAL_USD: String(capital) } });
    h.ledger.ensureInitial(capital);
    h.ledger.insertEquity({ eth: 0, weth: capital / 3000, usdc: 0, price: 3000, equityUsd: capital, walletUsd: capital });
    h.ledger.insertJudgment({ price: 3000, features: {}, state: 'synthetic', costUsd: 17_280 * 0.000053 }); // one UTC day at 5 s, aggregated
    const st = h.ledger.stats(capital);
    assert.equal(st.dailyNetPnlPct <= -h.cfg.maxDailyLossPct, breaches, `capital $${capital}: daily net ${st.dailyNetPnlPct.toFixed(3)}%`);
  }
});

test('helpers: makeCfg still refuses nonsense and the agreeing summary is what the witnesses use', () => {
  assert.throws(() => makeCfg({ PAPER_CAPITAL_USD: '-1' }), ConfigError);
  assert.equal(agreeingSummary('USDC').direction, 'down');
});
