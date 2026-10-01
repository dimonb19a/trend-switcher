// Regressions from the independent review of 2026-10-01 (quote provenance, pre-effect quote
// failures, sanitized RPC errors): AGENT_TEST=1 node --test agent/test-trd12.mjs
// The chain tests stub the provider's two methods in memory; nothing reaches any network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { makeHarness, agreeingSummary, USDC, WETH } from './test-helpers.mjs';
import * as chain from './chain.mjs';
import { describeError } from './errors.mjs';

test.after(() => chain.provider.destroy());

const transientQuoteError = () => new chain.QuoteUnavailableError('quote unavailable after 4 attempts (attempts): [SERVER_ERROR] server response 429 (http 429)',
  { stage: 'quote', attempts: 4, elapsedMs: 9000, transient: true, stopped: false });
const PAPER = { env: { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000' } };
const attemptOf = (outs) => outs.find((o) => o && o.result);

test('paper: a transient quote failure before any effect cancels the switch without a halt, starts a cooldown, and a later candidate switches', async () => {
  const h = makeHarness(PAPER);
  try {
    const original = h.chain.quote; let fail = true;
    h.chain.quote = async (...args) => { if (fail) throw transientQuoteError(); return original(...args); };
    const attempt = attemptOf(await h.advance(6));
    assert.ok(attempt, 'a switch was attempted');
    assert.equal(attempt.switched, false); assert.equal(attempt.result.cancelled, true);
    const sw = h.ledger.getSwitch(1);
    assert.equal(sw.status, 'failed_before_send'); assert.equal(sw.halt_reason, null); assert.match(sw.reason, /cancelled before any effect \(paper\)/u);
    assert.equal(h.ledger.stats(1000).halt, null); assert.equal(h.ledger.requiredHalts().length, 0); assert.equal(h.chain.calls.sends.length, 0);
    assert.equal(h.ledger.legsOf(1).length, 0);
    const recovered = await h.engine.recoverPending();
    assert.equal(recovered.halt, null); // a restart sees the same thing: no halt was ever required
    // inside the cooldown a new candidate is deferred: no quote is attempted, no model is spent on the slow brain
    fail = false; const confirmCalls = h.state.confirmCalls;
    for (let i = 0; i < h.cfg.voteWindow; i += 1) h.engine.votes.push(agreeingSummary('USDC'), h.clock());
    const deferred = await h.last(1);
    assert.equal(deferred.cooldown, 'quote failure');
    const row = h.ledger.db.prepare('SELECT outcome, stage, reason FROM decisions ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.outcome, 'deferred'); assert.equal(row.stage, 'cooldown'); assert.match(row.reason, /quote-failure cooldown/u);
    assert.equal(h.state.confirmCalls, confirmCalls);
    // after the cooldown a candidate proceeds and the fill succeeds
    h.wait(h.cfg.quoteFailureCooldownMs);
    const later = attemptOf(await h.advance(6));
    assert.ok(later && later.switched === true, 'the next candidate switched');
    assert.equal(h.ledger.getSwitch(2).status, 'done'); assert.equal(h.ledger.stats(1000).halt, null);
  } finally { h.ledger.close(); }
});

test('paper: an operator stop that ends the quote retry is a pre-effect cancellation too', async () => {
  const h = makeHarness(PAPER);
  try {
    h.chain.quote = async () => { throw new chain.QuoteUnavailableError('block number unavailable after 0 attempts (stop): [ABORTED] stop requested before attempt 1', { stage: 'block number', attempts: 0, elapsedMs: 1, transient: false, stopped: true }); };
    const attempt = attemptOf(await h.advance(6));
    assert.ok(attempt); assert.equal(attempt.result.cancelled, true);
    assert.equal(h.ledger.getSwitch(1).halt_reason, null); assert.equal(h.ledger.stats(1000).halt, null);
  } finally { h.ledger.close(); }
});

test('paper: a deterministic quote failure or any other exception inside a switch still latches a halt', async () => {
  const makers = [
    () => new chain.QuoteUnavailableError('quote unavailable after 1 attempt (not-retryable): [CALL_EXCEPTION] execution reverted: "STF"', { stage: 'quote', attempts: 1, elapsedMs: 5, transient: false, stopped: false }),
    () => new Error('synthetic failure inside the fill'),
  ];
  for (const make of makers) {
    const h = makeHarness(PAPER);
    try {
      h.chain.quote = async () => { throw make(); };
      const attempt = attemptOf(await h.advance(6));
      assert.ok(attempt); assert.equal(attempt.result.cancelled, false);
      const sw = h.ledger.getSwitch(1);
      assert.equal(sw.status, 'failed_before_send'); assert.ok(sw.halt_reason); assert.ok(h.ledger.stats(1000).halt);
      assert.equal(h.ledger.requiredHalts().length, 1);
    } finally { h.ledger.close(); }
  }
});

test('live: the same transient quote failure still latches a halt (live semantics unchanged)', async () => {
  const h = makeHarness({ live: true });
  try {
    h.chain.quote = async () => { throw transientQuoteError(); };
    const attempt = attemptOf(await h.advance(6));
    assert.ok(attempt); assert.equal(attempt.result.cancelled, false);
    assert.ok(h.ledger.stats(1000).halt); assert.equal(h.ledger.requiredHalts().length, 1);
    assert.equal(h.chain.calls.sends.length, 0);
    assert.match(h.ledger.getSwitch(1).halt_reason, /\[QUOTE_UNAVAILABLE\]/u);
  } finally { h.ledger.close(); }
});

// ---- chain.quote against a stubbed provider ----
const iface = new Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const encoded = iface.encodeFunctionResult('quoteExactInputSingle', [10_000_000n, 1n, 0, 70_000n]);
async function withProvider(stubs, fn) {
  const saved = { call: chain.provider.call, getBlockNumber: chain.provider.getBlockNumber };
  Object.assign(chain.provider, stubs);
  try { return await fn(); } finally { Object.assign(chain.provider, saved); }
}
const quiet = { log: () => {} };

test('chain.quote: the block is read before the quote, a slow block read cannot make the quote look fresh, and a slow quote keeps its issue time', async () => {
  let now = 1_800_000_000_000; const clock = () => now;
  await withProvider({ getBlockNumber: async () => { now += 15_000; return 900; }, call: async () => encoded }, async () => {
    const q = await chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 1, now: clock });
    assert.equal(q.block, 900); assert.equal(q.at, now); assert.equal(q.amountOut, 10_000_000n); // issued after the block read: age 0 at return
    assert.match(q.blockMeaning, /observed just before the quote request/u);
  });
  await withProvider({ getBlockNumber: async () => 901, call: async () => { now += 15_000; return encoded; } }, async () => {
    const issued = now;
    const q = await chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 1, now: clock });
    assert.equal(q.at, issued); assert.equal(now - q.at, 15_000); // a quote is as old as its request
  });
});

// R13-01: the text of a provider error never reaches the retry log, the thrown error or the ledger, in any of
// the forms a credential can take (a plain, IPv6 or escaped URL, a header, a bearer token, a short key, a body);
// the envelope carries the code, the kind and the status only.
const LEAK_FORMS = (marker) => ({
  https: `server response 429 at https://rpc.example/v2/${marker}`,
  ipv6: `server at https://[2001:db8::1]:8545/v2/${marker}`,
  header: `HTTP 403 X-API-Key: ${marker}`,
  bearer: `Authorization: Bearer ${marker}`,
  escaped: `server at https:\\/\\/rpc.example\\/v2\\/${marker}`,
  short: `key ${marker} rejected`,
  body: `{"error":"invalid key ${marker}"}`,
});
test('chain.quote: a provider error in any credential-bearing form reaches the retry log and the thrown error as code and kind only', async () => {
  const marker = 'synthetic-short-key';
  for (const [form, message] of Object.entries(LEAK_FORMS(marker))) {
    const logs = []; let calls = 0;
    const leaky = () => Object.assign(new Error(message), { code: 'SERVER_ERROR', shortMessage: message, info: { responseBody: message }, name: `Err ${marker}` });
    await withProvider({ getBlockNumber: async () => 1, call: async () => { calls += 1; if (calls === 1) throw leaky(); return encoded; } }, async () => {
      const q = await chain.quote(WETH, USDC, 1n, { attempts: 2, log: (line) => logs.push(line) });
      assert.equal(q.amountOut, 10_000_000n);
      assert.equal(logs.length, 1); assert.ok(!logs[0].includes(marker), `${form}: ${logs[0]}`); assert.ok(logs[0].includes('[SERVER_ERROR] server error'), `${form}: ${logs[0]}`);
    });
    await withProvider({ getBlockNumber: async () => 1, call: async () => { throw leaky(); } }, async () => {
      await assert.rejects(chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 1 }),
        (e) => e instanceof chain.QuoteUnavailableError && e.transient === true && e.preEffect === true && e.stage === 'quote'
          && !e.message.includes(marker) && e.message.includes('[SERVER_ERROR] server error') && !describeError(e).includes(marker));
    });
  }
});

test('paper: the sanitized reason of a quote failure is what the ledger stores, in every credential-bearing form', async () => {
  const marker = 'synthetic-short-key';
  for (const [form, message] of Object.entries(LEAK_FORMS(marker))) {
    let typed;
    await withProvider({ getBlockNumber: async () => 900, call: async () => { throw Object.assign(new Error(message), { code: 'SERVER_ERROR', shortMessage: message }); } }, async () => {
      try { await chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 1 }); } catch (e) { typed = e; }
    });
    assert.equal(typed.code, 'QUOTE_UNAVAILABLE');
    const h = makeHarness(PAPER);
    try {
      h.chain.quote = async () => { throw typed; };
      const out = attemptOf(await h.advance(6)); assert.ok(out, form);
      const row = h.ledger.getSwitch(1);
      assert.equal(row.status, 'failed_before_send', form);
      assert.ok(!row.reason.includes(marker), `${form}: ${row.reason}`);
      assert.ok(row.reason.includes('[SERVER_ERROR] server error'), `${form}: ${row.reason}`);
      for (const d of h.ledger.db.prepare('SELECT reason FROM decisions').all()) assert.ok(!(d.reason ?? '').includes(marker), form);
    } finally { h.ledger.close(); }
  }
});

test('chain.quote: a revert with data is deterministic (one attempt, not transient); a revert without data is ambiguous and retried within the deadline', async () => {
  let calls = 0;
  await withProvider({ getBlockNumber: async () => 1, call: async () => { calls += 1; throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x08c379a0', shortMessage: 'execution reverted: "STF"' }); } }, async () => {
    await assert.rejects(chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 4 }), (e) => e.transient === false && e.stopped === false && e.attempts === 1);
    assert.equal(calls, 1);
  });
  calls = 0;
  await withProvider({ getBlockNumber: async () => 1, call: async () => { calls += 1; throw Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, shortMessage: 'missing revert data' }); } }, async () => {
    await assert.rejects(chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 3, deadlineMs: 50 }), (e) => e.transient === true && e.attempts === 1);
    assert.equal(calls, 1); // the first wait would end past a 50 ms deadline: no second attempt
  });
  assert.equal(chain.isTransientRpcError({ code: 'ABORTED' }), false);
  assert.equal(chain.isTransientRpcError({ code: 'TIMEOUT' }), true);
  assert.equal(chain.isTransientRpcError({ code: 'CALL_EXCEPTION', data: '0x' }), false);
  assert.equal(chain.isTransientRpcError(null), false);
});

test('chain.quote: a stop request ends the retry and is reported as stopped, not transient', async () => {
  chain.setStopCheck(() => true);
  try {
    await withProvider({ getBlockNumber: async () => 1, call: async () => encoded }, async () => {
      await assert.rejects(chain.quote(WETH, USDC, 1n, { ...quiet, attempts: 3 }), (e) => e instanceof chain.QuoteUnavailableError && e.stopped === true && e.transient === false && e.preEffect === true);
    });
  } finally { chain.setStopCheck(null); }
});
