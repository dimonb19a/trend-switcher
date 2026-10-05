// A long paper run (`--until`): when it may start, what it refuses, the record it keeps across restarts, and the
// rule that ends a blind process. The runner's loop itself is thin; its rules are the pure functions tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLedger } from './ledger.mjs';
import { LONG_RUN_MAX_DAYS, noteLongRunStart, noteLongRunStop, resolveLongRun, staleTooLong } from './session.mjs';
import { makeCfg, T0 } from './test-helpers.mjs';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const ready = { judgeKeySet: true, judgePriced: true };
const longCfg = (over = {}) => makeCfg({ PAPER_CAPITAL_USD: '10000', PAPER_CONTINUE_UNKNOWN_BILLING: 'true', REQUIRE_DEEPSEEK: 'false', ...over });

test('a long paper run starts with an end in the future, up to 45 days ahead, and reports that end', () => {
  const cfg = longCfg();
  assert.deepEqual(resolveLongRun({ until: undefined, now: T0, cfg }), { absent: true });
  const month = resolveLongRun({ until: iso(T0 + 31 * DAY), now: T0, cfg, ...ready });
  assert.equal(month.ok, true); assert.equal(month.deadline, T0 + 31 * DAY);
  assert.equal(resolveLongRun({ until: '2027-02-15T08:00Z', now: T0, cfg, ...ready }).ok, true, 'minutes are enough');
  assert.equal(resolveLongRun({ until: iso(T0 + LONG_RUN_MAX_DAYS * DAY), now: T0, cfg, ...ready }).ok, true);
  assert.match(resolveLongRun({ until: iso(T0 + (LONG_RUN_MAX_DAYS + 1) * DAY), now: T0, cfg, ...ready }).refuse, /more than 45 days/u);
});

test('the same command after the end is a quiet refusal, so a keeper that starts it again does no harm', () => {
  const out = resolveLongRun({ until: iso(T0 - 1000), now: T0, cfg: longCfg(), ...ready });
  assert.match(out.refuse, /is over/u); assert.equal(out.over, true);
});

test('a long run refuses anything that is not an unambiguous UTC instant, live mode, a missing capital and mixed flags', () => {
  const cfg = longCfg();
  for (const until of ['tomorrow', '2027-02-15', '2027-02-15T08:00:00', '2027-02-15T08:00:00+02:00', '2027-13-40T00:00:00Z', ''])
    assert.match(resolveLongRun({ until, now: T0, cfg, ...ready }).refuse, /UTC instant/u, until);
  const until = iso(T0 + DAY);
  assert.match(resolveLongRun({ until, now: T0, cfg, timed: true, ...ready }).refuse, /does not combine/u);
  assert.match(resolveLongRun({ until, now: T0, cfg, once: true, ...ready }).refuse, /does not combine/u);
  assert.match(resolveLongRun({ until, now: T0, cfg, live: true, ...ready }).refuse, /paper runs only/u);
  assert.match(resolveLongRun({ until, now: T0, cfg: makeCfg({ PAPER_CONTINUE_UNKNOWN_BILLING: undefined }), ...ready }).refuse, /virtual capital/u);
  assert.match(resolveLongRun({ until, now: NaN, cfg, ...ready }).refuse, /no clock/u);
});

test('a run nobody watches refuses to start in a state where it would stay alive and never vote or act', () => {
  const until = iso(T0 + 31 * DAY);
  assert.match(resolveLongRun({ until, now: T0, cfg: longCfg(), judgeKeySet: true, judgePriced: false }).refuse, /judge prices/u);
  assert.match(resolveLongRun({ until, now: T0, cfg: longCfg(), judgeKeySet: false, judgePriced: true }).refuse, /endpoint, model pin and key/u);
  assert.match(resolveLongRun({ until, now: T0, cfg: longCfg(), noJudge: true, ...ready }).refuse, /no --no-judge/u);
  assert.match(resolveLongRun({ until, now: T0, cfg: makeCfg({ PAPER_CAPITAL_USD: '10000', REQUIRE_DEEPSEEK: 'false' }), ...ready }).refuse, /PAPER_CONTINUE_UNKNOWN_BILLING=true/u);
  assert.match(resolveLongRun({ until, now: T0, cfg: longCfg({ REQUIRE_DEEPSEEK: 'true' }), ...ready }).refuse, /slow-brain key/u);
  assert.equal(resolveLongRun({ until, now: T0, cfg: longCfg({ REQUIRE_DEEPSEEK: 'true', DEEPSEEK_API_KEY: 'test-key-not-real' }), ...ready }).ok, true);
});

test('the run keeps one record in its ledger: every start is added, a changed end is noted, a stop and the end are told apart', () => {
  let now = T0; const clock = () => now;
  const ledger = openLedger(longCfg(), { clock });
  const first = noteLongRunStart(ledger, { deadline: T0 + 31 * DAY, tickMs: 300_000, now });
  assert.equal(first.startCount, 1); assert.equal(first.firstStartAt, iso(T0)); assert.equal(first.status, 'running'); assert.equal(first.until, iso(T0 + 31 * DAY));
  now = T0 + 3 * DAY;
  assert.equal(noteLongRunStop(ledger, { now, reason: 'SIGTERM', completed: false }).status, 'stopped');
  now = T0 + 3 * DAY + 600_000;
  const second = noteLongRunStart(ledger, { deadline: T0 + 31 * DAY, tickMs: 300_000, now });
  assert.equal(second.startCount, 2); assert.equal(second.firstStartAt, iso(T0)); assert.deepEqual(second.starts, [iso(T0), iso(now)]);
  assert.equal(second.status, 'running'); assert.equal(second.endedAt, null); assert.deepEqual(second.untilChanged, []);
  const moved = noteLongRunStart(ledger, { deadline: T0 + 33 * DAY, tickMs: 300_000, now });
  assert.equal(moved.untilChanged.length, 1); assert.equal(moved.untilChanged[0].from, iso(T0 + 31 * DAY)); assert.equal(moved.untilChanged[0].to, iso(T0 + 33 * DAY));
  now = T0 + 33 * DAY;
  const done = noteLongRunStop(ledger, { now, reason: 'the end written down (--until)', completed: true });
  assert.equal(done.status, 'completed'); assert.equal(done.endedAt, iso(now)); assert.equal(ledger.kv.get('run:paper').startCount, 3);
  ledger.close();
});

test('a blind process ends itself: no usable tape for fifteen minutes, or for three ticks when a tick is longer', () => {
  assert.equal(staleTooLong({ staleSinceMs: null, now: T0, tickMs: 60_000 }), false);
  assert.equal(staleTooLong({ staleSinceMs: T0, now: T0 + 14 * 60_000, tickMs: 60_000 }), false);
  assert.equal(staleTooLong({ staleSinceMs: T0, now: T0 + 15 * 60_000, tickMs: 60_000 }), true);
  assert.equal(staleTooLong({ staleSinceMs: T0, now: T0 + 15 * 60_000, tickMs: 300_000 }), true, 'three five-minute ticks are fifteen minutes');
  assert.equal(staleTooLong({ staleSinceMs: T0, now: T0 + 29 * 60_000, tickMs: 600_000 }), false);
  assert.equal(staleTooLong({ staleSinceMs: T0, now: T0 + 30 * 60_000, tickMs: 600_000 }), true);
});

test('the runner itself: --until refuses before any network or ledger when the run could not work, and exits quietly once it is over', () => {
  const run = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const base = { PATH: process.env.PATH, AGENT_TEST: '1', MODE: 'paper', PAPER_CAPITAL_USD: '10000', AGENT_DB_PATH: ':memory:', AGENT_LOCK_PATH: '/dev/null',
    JUDGE_BASE_URL: 'https://judge.example', JUDGE_MODEL: 'judge-model-1', REQUIRE_DEEPSEEK: 'false' };
  const start = (env, args) => spawnSync(process.execPath, [run, ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 20_000 });
  const future = iso(Date.now() + 2 * DAY);
  const noKey = start({ PAPER_CONTINUE_UNKNOWN_BILLING: 'true' }, ['--until', future]);
  assert.equal(noKey.status, 2); assert.match(noKey.stderr, /refusing a long paper run: it needs .*key/u);
  const over = start({ PAPER_CONTINUE_UNKNOWN_BILLING: 'true' }, ['--until', '2020-01-01T00:00:00Z']);
  assert.equal(over.status, 0); assert.match(over.stderr, /this run is over/u);
  const mixed = start({ PAPER_CONTINUE_UNKNOWN_BILLING: 'true' }, ['--until', future, '--once']);
  assert.equal(mixed.status, 2); assert.match(mixed.stderr, /does not combine/u);
  const unbounded = start({ PAPER_CONTINUE_UNKNOWN_BILLING: 'true' }, []);
  assert.equal(unbounded.status, 2); assert.match(unbounded.stderr, /outside a bounded run/u);
});
