// The daily loss latch and the calendar in a paper run (PAPER_DAILY_LATCH_LIFT): what is lifted, when, and what never is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.mjs';
import { openLedger } from './ledger.mjs';
import { liftDailyLatchAfterItsDay, liftDailyLatchAtMidnight, utcDay } from './latch.mjs';
import { flatSummary, makeCfg, makeHarness, T0 } from './test-helpers.mjs';

const DAY = 24 * 3600_000;
const DAILY = 'risk (tick): daily net loss -3.20% beyond the daily limit 3%';
const KILL = 'risk (tick): total net loss -31.00% beyond the kill limit 30%';

test('a latched daily loss is lifted once its UTC day is over, not before, and reports the day it latched on', () => {
  let now = Date.parse('2027-03-10T23:50:00Z'); const clock = () => now;
  const ledger = openLedger(makeCfg({ PAPER_CAPITAL_USD: '1000' }), { clock });
  ledger.latchHalt(DAILY);
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', now), null, 'the same instant');
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', Date.parse('2027-03-10T23:59:59Z')), null, 'still the same UTC day');
  assert.ok(ledger.kv.get('halt:paper'));
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', Date.parse('2027-03-11T00:00:00Z')), '2027-03-10', 'the first instant of the next day');
  assert.equal(ledger.kv.get('halt:paper'), null);
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', Date.parse('2027-03-12T00:00:00Z')), null, 'nothing is latched any more');
  ledger.close();
});

test('the calendar never lifts a kill latch, an UNKNOWN-bill latch or a switch-level halt, and a non-finite clock lifts nothing', () => {
  let now = T0; const clock = () => now;
  const ledger = openLedger(makeCfg({ PAPER_CAPITAL_USD: '1000' }), { clock });
  const later = T0 + 3 * DAY;
  ledger.latchHalt(KILL);
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', later), null); assert.ok(ledger.kv.get('halt:paper'));
  ledger.resetHalt();
  ledger.latchHalt('inference 7 (judge) billing UNKNOWN; reconcile before another run');
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', later), null);
  ledger.resetHalt();
  const id = ledger.openSwitch({ fromSide: 'ETH', toSide: 'USDC', reason: 'test', notionalUsd: 100 });
  ledger.closeSwitch(id, { status: 'unknown', reason: 'test', halt: `switch ${id}: outcome unknown` });
  ledger.latchHalt(DAILY); // ignored while the switch halt stands
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', later), null, 'a required switch-level halt is never lifted by the calendar');
  ledger.resetHalt();
  ledger.latchHalt(DAILY);
  assert.equal(liftDailyLatchAfterItsDay(ledger, 'paper', NaN), null, 'no clock, no lift');
  assert.equal(liftDailyLatchAtMidnight(ledger), true, 'the replay rule still lifts it at its own midnight');
  assert.equal(utcDay(Date.parse('2027-03-10T23:59:59Z')), '2027-03-10');
  ledger.close();
});

test('PAPER_DAILY_LATCH_LIFT: off by default, midnight in paper, refused in live and for any other value', () => {
  assert.equal(makeCfg({ PAPER_CAPITAL_USD: '1000' }).paperDailyLatchLift, 'off');
  assert.equal(makeCfg({ PAPER_CAPITAL_USD: '1000', PAPER_DAILY_LATCH_LIFT: 'midnight' }).paperDailyLatchLift, 'midnight');
  assert.equal(makeCfg({ PAPER_CAPITAL_USD: '1000', PAPER_DAILY_LATCH_LIFT: ' Midnight ' }).paperDailyLatchLift, 'midnight');
  assert.equal(makeCfg({ PAPER_CAPITAL_USD: '1000', PAPER_DAILY_LATCH_LIFT: 'off' }).paperDailyLatchLift, 'off');
  assert.throws(() => makeCfg({ PAPER_CAPITAL_USD: '1000', PAPER_DAILY_LATCH_LIFT: 'noon' }), /PAPER_DAILY_LATCH_LIFT must be off or midnight/u);
  assert.throws(() => loadConfig({ AGENT_TEST: '1', AGENT_DB_PATH: ':memory:', AGENT_LOCK_PATH: '/dev/null', ACCOUNT_ADDRESS: '0x1111111111111111111111111111111111111111',
    JUDGE_BASE_URL: 'https://judge.example', JUDGE_MODEL: 'judge-model-1', MODE: 'live', PRIVATE_KEY: '0x' + '1'.repeat(64), DEEPSEEK_API_KEY: 'test-key-not-real', PAPER_DAILY_LATCH_LIFT: 'midnight' }),
  /PAPER_DAILY_LATCH_LIFT is paper-only/u);
});

test('a paper engine with the knob lifts the latch on the first tick of a later UTC day and records it; without the knob the latch waits for the owner', async () => {
  const withKnob = makeHarness({ env: { PAPER_CAPITAL_USD: '1000', PAPER_DAILY_LATCH_LIFT: 'midnight' }, summary: flatSummary });
  withKnob.ledger.latchHalt(DAILY);
  await withKnob.advance(2);
  assert.ok(withKnob.ledger.kv.get('halt:paper'), 'the same UTC day: the latch stands');
  withKnob.wait(DAY);
  await withKnob.advance(1);
  assert.equal(withKnob.ledger.kv.get('halt:paper'), null, 'the next UTC day: lifted on the first tick');
  const lifts = withKnob.ledger.db.prepare("SELECT payload FROM observations WHERE kind = 'latch'").all().map((r) => JSON.parse(r.payload));
  assert.equal(lifts.length, 1); assert.equal(lifts[0].latchedOn, utcDay(T0)); assert.equal(lifts[0].lifted, 'daily loss');
  withKnob.ledger.latchHalt(KILL);
  withKnob.wait(2 * DAY);
  await withKnob.advance(1);
  assert.match(withKnob.ledger.kv.get('halt:paper').reason, /kill limit/u, 'the kill latch is never lifted');
  withKnob.ledger.close();

  const plain = makeHarness({ env: { PAPER_CAPITAL_USD: '1000' }, summary: flatSummary });
  plain.ledger.latchHalt(DAILY);
  plain.wait(DAY);
  await plain.advance(1);
  assert.ok(plain.ledger.kv.get('halt:paper'), 'the default: a latched daily loss waits for --reset-halt');
  assert.equal(plain.ledger.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE kind = 'latch'").get().n, 0);
  plain.ledger.close();
});
