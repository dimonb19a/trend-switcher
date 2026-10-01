// Abrupt process death at a named boundary, for test-r3.mjs (not a test file itself). Only fakes and a caller-owned
// temporary SQLite file: no runner, signer, chain adapter, network, keys or .env.
// usage: node agent/probe-r3-crash.mjs <db-path> <scenario>
if (process.env.AGENT_TEST !== '1') throw new Error('AGENT_TEST=1 required');
import { realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createEngine } from './engine.mjs';
import { openLedger } from './ledger.mjs';
import { USDC, agreeingSummary, fakeChain, fakeJudge, makeCfg, makeFeed } from './test-helpers.mjs';

const [dbPath, scenario] = process.argv.slice(2);
const dir = realpathSync(resolve(dbPath, '..'));
if (!dir.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('the probe only runs on a database under the temp directory');
let now = 1_800_000_000_000; const clock = () => now;
const cfg = makeCfg({ MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real', AGENT_DB_PATH: dbPath });
const ledger = openLedger(cfg, { clock });
const chain = fakeChain({ clock, receipt: scenario.includes('failed') ? 'revert' : 'ok' });
chain.fills.set('0xprior', { tokenOut: USDC, amountOutRaw: 12_000_000n });
const engine = createEngine({ cfg, armed: true, chain, ledger, clock, feed: makeFeed({ eventAt: now, trendUp: false }), judge: fakeJudge(() => agreeingSummary('USDC')), slowBrain: { confirm: async (a) => ({ ok: true, agrees: true, stance: a.candidate, confidence: 0.8, costUsd: 0.0002 }) }, fsx: { existsSync: () => false } });

// SIGKILL right after the raw status row is written and before anything that follows it could run:
// not a throw that transaction() would roll back, not a graceful close
const die = () => { writeSync(1, `CRASH_BOUNDARY:${scenario}\n`); process.kill(process.pid, 'SIGKILL'); };
const wanted = scenario.includes('partial') ? 'partial' : scenario.includes('failed') ? 'failed' : 'done';
const update = ledger.updateSwitch;
ledger.updateSwitch = (id, fields) => { const out = update(id, fields); if (fields.status === wanted) die(); return out; };
if (scenario.startsWith('normal')) { for (let i = 0; i < 6; i += 1) { await engine.tick(); now += cfg.tickMs; } } else { await engine.recoverPending(); }
ledger.close();
throw new Error('the probe did not reach the intended boundary');
