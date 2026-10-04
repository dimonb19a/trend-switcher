#!/usr/bin/env node
// Self-check before a run: node agent/selfcheck.mjs
// Prints one line per check with PASS/FAIL and never prints a secret. It
// reads public chain state and its own sources; it uses a TEMPORARY ledger
// (never the working one); it sends nothing to the judge, DeepSeek or the
// chain. Reads .env only to report booleans.
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Contract, Interface, JsonRpcProvider, formatUnits, parseEther, parseUnits } from 'ethers';
import * as judgeClient from './judge-client.mjs';
import { RecordableError, describeError  } from './errors.mjs';

const tempRoot = realpathSync(tmpdir());
const selfcheckDir = mkdtempSync(join(tempRoot, 'agent-selfcheck-'));
process.env.AGENT_DB_PATH = join(selfcheckDir, 'ledger.db');
const { cfg, describeConfig } = await import('./config.mjs');

const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL  ${name} — ${describeError(error)}`); } // an RPC error may quote its URL: sanitized
};

console.log('config:', JSON.stringify(describeConfig(cfg)));

await check('configuration passed the startup schema', () => `${cfg.mode}, ${cfg.paperCapitalUsd === null ? 'paper wallet mirrors the real one' : `virtual capital $${cfg.paperCapitalUsd} (paper only)`}, notional cap $${cfg.maxCapitalUsd}, tick ${cfg.tickMs} ms, votes ${cfg.voteMin}/${cfg.voteWindow}, inference budget $${cfg.inferenceBudgetUsdPerDay}/day`);

await check('secrets are present only as booleans', () => `wallet key ${cfg.hasPrivateKey ? 'set' : 'unset'}, slow-brain key ${cfg.hasDeepseekKey ? 'set' : 'unset'}, judge key ${cfg.hasJudgeKey ? 'set' : 'unset'}, account ${cfg.accountAddress ?? 'none (paper on a virtual capital)'}`);

await check('a paper run has something to trade: a wallet to mirror or a virtual capital', () => {
  if (cfg.mode !== 'paper') return 'live';
  if (cfg.paperCapitalUsd !== null) return `virtual capital $${cfg.paperCapitalUsd}, notional cap $${cfg.maxCapitalUsd}`;
  if (cfg.accountAddress) return `mirrors ${cfg.accountAddress} under the cap $${cfg.maxCapitalUsd}`;
  throw new RecordableError('set PAPER_CAPITAL_USD (or ACCOUNT_ADDRESS to mirror a real wallet); the runner refuses to start without one');
});

await check('agent source never logs or names a key variable in a log line', () => {
  const dir = resolve(import.meta.dirname);
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    for (const [i, line] of readFileSync(resolve(dir, file), 'utf8').split('\n').entries()) {
      if (/console\.(log|error|warn)|\blog\(/u.test(line) && /\b(PRIVATE_KEY|DEEPSEEK_API_KEY|JUDGE_API_KEY)\b/u.test(line)) offenders.push(`${file}:${i + 1}`);
    }
  }
  if (offenders.length) throw new RecordableError(`log lines touch a key: ${offenders.join(', ')}`);
  return 'clean';
});

await check('judge key, endpoint policy and prices (status only, nothing sent)', () => {
  if (!cfg.judgeBaseUrl || !cfg.judgeModel) throw new RecordableError('set JUDGE_BASE_URL and JUDGE_MODEL (bring your own judge provider) before a run that judges');
  const policy = judgeClient.credentialPolicy(cfg.judgeBaseUrl); // throws for an origin the key may not travel to
  if (policy.sendKey && judgeClient.keyStatus() !== 'set') throw new RecordableError('unset: set JUDGE_API_KEY before a paper run');
  const problems = judgeClient.priceProblems();
  if (problems.length) throw new RecordableError(problems.join('; '));
  return `${policy.sendKey ? 'key set, sent to the allowed origin only' : 'loopback stand-in, no key sent'}; pinned model ${cfg.judgeModel}; prices ${cfg.judgePriceConfigured ? 'configured' : 'NOT configured — judge calls will be recorded as UNKNOWN bills'}`;
});

const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });

const m = cfg.market;
const liveWired = m.tested === true && m.name === 'base-eth-usdc'; // the live path (native-value swaps, the L1 fee oracle, balances) is wired for this market only

await check(`market ${m.name}: ${m.asset} against ${m.quoteToken} on ${m.chain}, Uniswap v3 ${m.baseToken}/${m.quoteToken} ${cfg.poolFee / 10_000}% (${m.tested ? 'traded in this repository' : 'supported, not tested: paper only'})`, async () => {
  const id = BigInt(await provider.send('eth_chainId', []));
  if (id !== BigInt(cfg.chainId)) throw new RecordableError(`the RPC serves chain ${id}, the market needs ${cfg.chainId}`);
  return `chain id ${id}`;
});

await check('router and quoter belong to the market\'s factory; the router wraps the chain\'s native token', async () => {
  const abi = ['function factory() view returns (address)', 'function WETH9() view returns (address)'];
  // one call at a time: public endpoints rate-limit bursts
  const rf = await new Contract(cfg.router, abi, provider).factory(); const rw = await new Contract(cfg.router, abi, provider).WETH9(); const qf = await new Contract(cfg.quoter, abi, provider).factory();
  if (rf.toLowerCase() !== m.factory.toLowerCase() || qf.toLowerCase() !== m.factory.toLowerCase()) throw new RecordableError(`factories: router ${rf}, quoter ${qf}, expected ${m.factory}`);
  if (rw.toLowerCase() !== m.wrappedNative.toLowerCase()) throw new RecordableError(`router WETH9 is ${rw}`);
  return `factory ${rf}; WETH9 ${rw}`;
});

await check('tokens are what the market says (symbol and decimals, on-chain)', async () => {
  const abi = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
  const base = new Contract(cfg.weth, abi, provider); const quote = new Contract(cfg.usdc, abi, provider);
  const bs = await base.symbol(); const bd = await base.decimals(); const qs = await quote.symbol(); const qd = await quote.decimals();
  if (Number(bd) !== cfg.baseDecimals || Number(qd) !== cfg.quoteDecimals) throw new RecordableError(`decimals ${bs} ${bd} / ${qs} ${qd}, configured ${cfg.baseDecimals} / ${cfg.quoteDecimals}`);
  if (bs !== m.baseToken || qs !== m.quoteToken) throw new RecordableError(`symbols ${bs}/${qs}, configured ${m.baseToken}/${m.quoteToken}`);
  return `${bs} (${bd}) / ${qs} (${qd})`;
});

await check('pool is the factory\'s pool of the pair at the configured fee tier', async () => {
  const pool = new Contract(cfg.pool, ['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)'], provider);
  const t0 = await pool.token0(); const t1 = await pool.token1(); const fee = await pool.fee();
  const set = new Set([t0.toLowerCase(), t1.toLowerCase()]);
  if (!set.has(cfg.weth.toLowerCase()) || !set.has(cfg.usdc.toLowerCase())) throw new RecordableError(`pool tokens ${t0}/${t1}`);
  if (Number(fee) !== cfg.poolFee) throw new RecordableError(`pool fee ${fee}`);
  const fromFactory = await new Contract(m.factory, ['function getPool(address,address,uint24) view returns (address)'], provider).getPool(cfg.weth, cfg.usdc, cfg.poolFee);
  if (fromFactory.toLowerCase() !== cfg.pool.toLowerCase()) throw new RecordableError(`the factory's pool is ${fromFactory}`);
  return `fee ${fee}`;
});

await check('quoter answers for a 10-dollar buy', async () => {
  const quoter = new Contract(cfg.quoter, ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'], provider);
  const q = await quoter.quoteExactInputSingle.staticCall({ tokenIn: cfg.usdc, tokenOut: cfg.weth, amountIn: parseUnits('10', cfg.quoteDecimals), fee: cfg.poolFee, sqrtPriceLimitX96: 0n });
  const out = Number(formatUnits(q.amountOut, cfg.baseDecimals));
  if (!(out > 0)) throw new RecordableError(`amountOut ${out}`);
  return `${out.toPrecision(6)} ${m.baseToken} for 10 ${m.quoteToken} (${(10 / out).toFixed(4)} per ${m.asset}, fee included)`;
});

const inner = new Interface(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)']);
const outer = new Interface(['function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)']);
const probeAmount = parseEther('0.0005');
const probeFrom = cfg.accountAddress ?? '0x0000000000000000000000000000000000000000';
const probeCall = inner.encodeFunctionData('exactInputSingle', [{ tokenIn: cfg.weth, tokenOut: cfg.usdc, fee: cfg.poolFee, recipient: probeFrom, amountIn: probeAmount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }]);

await check('deadline-bearing multicall swap is accepted with a fresh deadline (estimateGas only, nothing sent)', async () => {
  if (!liveWired) return `skipped: the live path is wired for base-eth-usdc only (market ${m.name} runs in paper)`;
  if (!cfg.accountAddress) return 'skipped: no ACCOUNT_ADDRESS (paper on a virtual capital)';
  const balance = await provider.getBalance(cfg.accountAddress);
  if (balance < probeAmount * 2n) return 'skipped: wallet balance too small for the probe';
  const data = outer.encodeFunctionData('multicall', [Math.floor(Date.now() / 1000) + cfg.swapDeadlineSec, [probeCall]]);
  const gas = await provider.estimateGas({ from: cfg.accountAddress, to: cfg.router, data, value: probeAmount });
  return `estimateGas ${gas.toString()}`;
});

await check('the router refuses an EXPIRED deadline (Transaction too old)', async () => {
  if (!liveWired) return `skipped: the live path is wired for base-eth-usdc only (market ${m.name} runs in paper)`;
  if (!cfg.accountAddress) return 'skipped: no ACCOUNT_ADDRESS (paper on a virtual capital)';
  const balance = await provider.getBalance(cfg.accountAddress);
  if (balance < probeAmount * 2n) return 'skipped: wallet balance too small for the probe';
  const data = outer.encodeFunctionData('multicall', [Math.floor(Date.now() / 1000) - 60, [probeCall]]);
  try { await provider.estimateGas({ from: cfg.accountAddress, to: cfg.router, data, value: probeAmount }); }
  catch (error) { if (/too old|reverted/iu.test(error.shortMessage ?? error.message)) return 'reverted as expected'; throw error; }
  throw new RecordableError('an expired deadline was accepted');
});

await check('Base L1 data fee oracle answers and the transaction bound is priced (gas limit × fee cap + L1 upper bound)', async () => {
  if (!liveWired) return `skipped: the live path is wired for base-eth-usdc only (market ${m.name} runs in paper)`;
  if (!cfg.accountAddress) return 'skipped: no ACCOUNT_ADDRESS (paper on a virtual capital; live pricing needs a funded wallet)';
  const chain = await import('./chain.mjs');
  const tx = chain.buildSwapTx({ tokenIn: cfg.weth, tokenOut: cfg.usdc, amountInRaw: probeAmount, minOutRaw: 0n, recipient: cfg.accountAddress, deadline: Math.floor(Date.now() / 1000) + 60, useValue: true });
  const est = await chain.estimateTx(tx, cfg.accountAddress, 3000);
  return `gas ${est.gasEstimate} → limit ${est.gasLimit}, maxFeePerGas ${est.maxFeePerGas} wei, L2 bound ${est.l2BoundWei} wei, L1 ${est.l1Wei} wei (${est.l1UpperBound ? 'oracle upper bound' : 'plain fee'}) → bound ≈ $${est.boundUsd.toFixed(4)} at $3000/ETH`;
});

await check('wallet balances on Base (public address, no key)', async () => {
  if (!liveWired) return `skipped: the live path is wired for base-eth-usdc only (market ${m.name} runs in paper)`;
  if (!cfg.accountAddress) return 'skipped: no ACCOUNT_ADDRESS (paper on a virtual capital)';
  const chain = await import('./chain.mjs');
  const b = await chain.balances(cfg.accountAddress);
  return `ETH ${b.eth.toFixed(6)}, WETH ${b.weth.toFixed(6)}, USDC ${b.usdc.toFixed(2)}; gas reserve ${cfg.gasReserveEth}`;
});

await check('Coinbase candles endpoint answers (keyless)', async () => {
  const response = await fetch(`https://api.exchange.coinbase.com/products/${cfg.product}/candles?granularity=300`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new RecordableError(`HTTP ${response.status}`);
  return `${(await response.json()).length} candles`;
});

await check('a temporary ledger opens with the eleven tables at the current schema version (the working ledger is untouched)', async () => {
  const { openLedger, SCHEMA_VERSION } = await import('./ledger.mjs');
  const l = openLedger(cfg);
  const names = l.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  const version = l.db.prepare('PRAGMA user_version').get().user_version;
  l.close();
  for (const t of ['arms', 'costs', 'decisions', 'equity', 'judgments', 'kv', 'legs', 'switches', 'inference_calls', 'observations', 'market_inputs']) if (!names.includes(t)) throw new RecordableError(`missing table ${t}`);
  if (version !== SCHEMA_VERSION) throw new RecordableError(`schema version ${version}, expected ${SCHEMA_VERSION}`);
  return `temporary ledger at ${cfg.databasePath}, schema v${version}`;
});

await check('the working ledger, if present, has the current schema version', async () => {
  const { SCHEMA_VERSION } = await import('./ledger.mjs');
  const working = resolve(import.meta.dirname, '..', 'data', 'agent.db');
  if (!existsSync(working)) return 'no working ledger yet';
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(working, { readOnly: true });
  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.close();
  if (version !== SCHEMA_VERSION) throw new RecordableError(`data/agent.db is schema v${version}; the agent needs v${SCHEMA_VERSION} and will refuse to start until the file is moved aside`);
  return `data/agent.db schema v${version}`;
});

await check('KILL file absent, no live lock held, no abandoned recovery claim', async () => {
  const { claimPath, processAlive, readLock } = await import('./lock.mjs');
  if (existsSync(cfg.killFile)) throw new RecordableError('KILL present: the agent would stop on its first tick');
  const holder = readLock({ path: cfg.lockFile });
  if (holder && processAlive(holder.pid)) throw new RecordableError(`lock ${cfg.lockFile} held by pid ${holder.pid} (${holder.mode})`);
  if (existsSync(claimPath(cfg.lockFile))) throw new RecordableError(`abandoned recovery claim ${claimPath(cfg.lockFile)}: remove it by hand`);
  return holder ? `stale record from dead pid ${holder.pid} at ${cfg.lockFile} (recovered automatically on the next start)` : `absent (${cfg.lockFile})`;
});

const cleanup = realpathSync(selfcheckDir);
if (dirname(cleanup) !== tempRoot || !basename(cleanup).startsWith('agent-selfcheck-')) throw new RecordableError('refusing selfcheck cleanup outside its own temporary directory');
rmSync(cleanup, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
