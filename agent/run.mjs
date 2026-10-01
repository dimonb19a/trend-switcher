#!/usr/bin/env node
// Thin runner: arming matrix (TR-01), one atomic execution owner per account
// and chain (R1-C), pending recovery before any decision, then the stream.
// Paper by default; live only when MODE=live in .env AND --live on the command
// line. `--once` runs one tick and exits; `--reset-halt` clears a latched halt
// on the owner's word; a file named KILL next to package.json stops the agent
// on its next check. One clock is shared by the engine and the ledger (R1-A).
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { cfg, describeConfig } from './config.mjs';
import { Feed } from './feed.mjs';
import * as judge from './judge.mjs';
import * as deepseek from './deepseek.mjs';
import * as chain from './chain.mjs';
import { openLedger } from './ledger.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { createArms } from './arms.mjs';
import { createEngine, resolveArming } from './engine.mjs';
import { runTimedSession } from './session.mjs';
import { RecordableError, describeError  } from './errors.mjs';

const { values: args } = parseArgs({
  options: {
    once: { type: 'boolean', default: false }, live: { type: 'boolean', default: false },
    'no-judge': { type: 'boolean', default: false }, 'reset-halt': { type: 'boolean', default: false },
    'duration-minutes': { type: 'string' },
  },
});
const clock = () => Date.now();
const log = (message, meta) => console.log(`[${new Date(clock()).toISOString()}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`);

const arming = resolveArming({ mode: cfg.mode, liveFlag: args.live });
if (arming.refuse) { console.error(`refusing to start: ${arming.refuse}`); process.exit(2); }
if (cfg.mode === 'paper' && cfg.accountAddress === null && cfg.paperCapitalUsd === null) {
  console.error('refusing to start: paper mode without ACCOUNT_ADDRESS needs PAPER_CAPITAL_USD (there is no wallet to mirror)');
  process.exit(2);
}
const timed = args['duration-minutes'] !== undefined;
const durationMinutes = timed ? Number(args['duration-minutes']) : null;
if (cfg.paperContinueUnknownBilling && !timed) {
  console.error('refusing paper UNKNOWN-billing continuation outside a bounded timed session');
  process.exit(2);
}
// A timed session is the measurement unit of this agent: paper only, a virtual capital, a fresh ledger,
// whole minutes up to one day, both model keys present when they will be used. The cadence and the
// capital are yours (TICK_MS, PAPER_CAPITAL_USD); they are recorded in the ledger under the config hash.
if (timed && (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440 ||
  cfg.mode !== 'paper' || cfg.paperCapitalUsd === null || args.once || args['reset-halt'] || args['no-judge'] ||
  (cfg.requireDeepseek && !cfg.hasDeepseekKey) || judge.keyStatus() !== 'set' || !cfg.judgeBaseUrl || !cfg.judgeModel)) {
  console.error('refusing a timed paper session: it needs MODE=paper with PAPER_CAPITAL_USD, 1..1440 whole minutes, the judge endpoint, model pin and key (JUDGE_BASE_URL, JUDGE_MODEL and the judge key named in .env.example; and the slow-brain key while REQUIRE_DEEPSEEK=true), and no --once/--reset-halt/--no-judge');
  process.exit(2);
}
if (!args['no-judge'] && (!cfg.judgeBaseUrl || !cfg.judgeModel)) {
  console.error('refusing to start: judging needs JUDGE_BASE_URL and JUDGE_MODEL in .env (bring your own judge provider), or run with --no-judge');
  process.exit(2);
}
if (timed && [cfg.databasePath, `${cfg.databasePath}-wal`, `${cfg.databasePath}-shm`].some(existsSync)) {
  console.error('refusing a timed paper session: choose a fresh, unused AGENT_DB_PATH');
  process.exit(2);
}
chain.arm({ armed: arming.armed });
if (arming.armed) {
  try { chain.getSigner(); } catch (error) { console.error(`refusing to start: ${error.message}`); process.exit(2); }
  if (!cfg.hasDeepseekKey) { console.error('refusing to start: live mode requires the slow brain key in .env'); process.exit(2); }
}

const owner = { pid: process.pid, mode: arming.armed ? 'live' : 'paper', account: cfg.accountAddress, chainId: cfg.chainId };
const lock = acquireLock({ path: cfg.lockFile, owner, clock });
if (!lock.ok) {
  console.error(`refusing to start: ${lock.holder ? `another agent (pid ${lock.holder.pid}, ${lock.holder.mode}, since ${lock.holder.since}) holds ${cfg.lockFile}` : lock.reason}`);
  process.exit(2);
}
const unlock = () => releaseLock({ path: cfg.lockFile, pid: process.pid });

let ledger;
try { ledger = openLedger(cfg, { clock }); } catch (error) { console.error(`refusing to start: ${error.message}`); unlock(); process.exit(2); }
let feed; let arms; let engine;
let stopping = false; let stopWhy = null; let deadline = Infinity;
const requestStop = (why) => { stopping = true; stopWhy ??= why; };
chain.setStopCheck(() => stopping); // a retry wait inside a quote ends on an operator stop instead of outliving it
try {
  if (args['reset-halt']) { ledger.resetHalt(); log('halt reset on the owner\'s word'); }
  log('agent starting', { ...describeConfig(cfg), armed: arming.armed,
    judge: { key: judge.keyStatus(), pinned: judge.pinnedModel(), priced: judge.priceConfigured() }, provenance: ledger.provenance, lock: cfg.lockFile });
  if (!judge.priceConfigured()) log('judge prices are not configured: every judge call will be recorded with an UNKNOWN bill (set JUDGE_PRICE_USD_PER_MTOK_INPUT and _OUTPUT from your vendor price list)');
  if (cfg.paperContinueUnknownBilling) log('paper UNKNOWN-billing continuation enabled', {
    reserveUsdPerUnknown: cfg.paperUnknownBillReserveUsd,
    note: 'reserve is a budget planning amount, not the vendor bill; net remains provisional',
  });
  feed = new Feed({ log, clock });
  arms = createArms({ cfg, ledger, clock });
  engine = createEngine({ cfg, armed: arming.armed, chain, ledger, feed, judge, slowBrain: deepseek, arms, clock, log,
    judgeEnabled: !args['no-judge'], captureInputs: timed, canAct: () => !stopping && clock() < deadline });
} catch (error) {
  console.error(`refusing to start: ${error.message}`);
  ledger.close(); unlock(); process.exit(2);
}

let killWatcher;
function shutdown() {
  clearInterval(killWatcher);
  try { feed.stop(); engine.finalizeValuation('shutdown'); log('stopped', ledger.totals()); }
  finally { try { ledger.close(); } finally { unlock(); } }
}
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));
killWatcher = setInterval(() => { if (existsSync(cfg.killFile)) requestStop('KILL file'); }, 1000);

try {
  feed.start();
  await new Promise((r) => setTimeout(r, 4000)); // warm the tape before recovery and before starting the bounded clock
  const recovered = await engine.recoverPending();
  if (recovered.halt) log('HALTED: no new actions until --reset-halt', recovered.halt);
  if (recovered.unbookedLegs) log('settled legs await accounting', { legs: recovered.unbookedLegs });
  if (timed && (recovered.halt || recovered.unresolvedLegs || recovered.unbookedLegs || ledger.unknownInference().length)) throw new RecordableError('timed session requires clean recovery state');
  if (timed) {
    deadline = clock() + durationMinutes * 60_000;
    const manifest = await runTimedSession({ ledger, engine, durationMs: durationMinutes * 60_000, tickMs: cfg.tickMs,
      clock, sleep: async (ms) => { for (let left = ms; left > 0 && !stopping; left -= 1000) await new Promise((r) => setTimeout(r, Math.min(left, 1000))); },
      shouldStop: () => stopping, stopReason: () => stopWhy ?? 'operator stop' });
    log('timed session ended', manifest);
    if (manifest.status !== 'completed') process.exitCode = 1;
  } else if (args.once) {
    const out = await engine.tick();
    if (out?.error) process.exitCode = 1;
  } else {
    while (!stopping) {
      const began = clock();
      const out = await engine.tick();
      if (out?.stop || out?.error) requestStop(out.reason ?? out.error ?? 'engine stop');
      const wait = Math.max(0, cfg.tickMs - (clock() - began));
      for (let left = wait; left > 0 && !stopping; left -= 1000) await new Promise((r) => setTimeout(r, Math.min(left, 1000)));
    }
  }
} catch (error) {
  log('runner failed', { error: describeError(error) });
  process.exitCode = 1;
} finally { shutdown(); }
