// R13-02: a ledger of the current schema that was written by an earlier build (cost rows or inference
// calls under older names) is refused by every run, because its rows would fall outside the daily
// inference budget; it stays a read-only archive for the report. AGENT_TEST=1 node --test agent/test-legacy-ledger.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeHarness, T0 } from './test-helpers.mjs';
import { KNOWN_COST_KINDS, KNOWN_PROVIDERS, LedgerError, SCHEMA_VERSION } from './ledger.mjs';
import { buildReport } from './report.mjs';

const OLD_KIND = 'oldjudge'; // a synthetic earlier name; any name outside the known set must behave the same
const PAPER = { PAPER_CAPITAL_USD: '1000', TICK_MS: '60000' };
const ts = new Date(T0).toISOString();

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-ledger-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const rowCount = (path, table) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); } };

test('a ledger with a cost row under an earlier kind is refused on reopen, before any execution, and left untouched', () => withDir((dir) => {
  const env = { ...PAPER, AGENT_DB_PATH: join(dir, 'ledger.db') };
  const h = makeHarness({ env });
  h.ledger.ensureInitial(1000);
  h.ledger.db.prepare('INSERT INTO costs (ts, mode, kind, usd, ref, estimate, external) VALUES (?, ?, ?, ?, ?, 0, 1)').run(ts, 'paper', OLD_KIND, 0.75, 'synthetic pre-rename bill');
  h.ledger.close();
  assert.throws(() => makeHarness({ env }), (e) => e instanceof LedgerError && /earlier build/u.test(e.message) && e.message.includes(`'${OLD_KIND}'`) && /read-only archive/u.test(e.message) && /fresh AGENT_DB_PATH/u.test(e.message));
  assert.equal(rowCount(env.AGENT_DB_PATH, 'costs'), 1); // nothing migrated, nothing deleted
  assert.equal(rowCount(env.AGENT_DB_PATH, 'judgments'), 0); // nothing ran
  const db = new DatabaseSync(env.AGENT_DB_PATH, { readOnly: true }); try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION); } finally { db.close(); }
}));

test('a ledger with an inference call under an earlier provider name is refused the same way', () => withDir((dir) => {
  const env = { ...PAPER, AGENT_DB_PATH: join(dir, 'ledger.db') };
  const h = makeHarness({ env });
  h.ledger.db.prepare("INSERT INTO inference_calls (ts, mode, provider, status, billing) VALUES (?, 'paper', ?, 'responded', 'KNOWN')").run(ts, OLD_KIND);
  h.ledger.close();
  assert.throws(() => makeHarness({ env }), (e) => e instanceof LedgerError && /earlier build/u.test(e.message) && /inference provider/u.test(e.message) && e.message.includes(`'${OLD_KIND}'`));
}));

test('the current build books costs under the known kinds only; an unknown kind is refused at the call', () => {
  const h = makeHarness({ env: PAPER });
  try {
    assert.deepEqual([...KNOWN_COST_KINDS], ['judge', 'deepseek', 'gas']);
    assert.deepEqual([...KNOWN_PROVIDERS], ['judge', 'deepseek']);
    assert.throws(() => h.ledger.recordCost(OLD_KIND, 0.1, 'x'), (e) => e instanceof LedgerError && /unknown cost kind/u.test(e.message));
    assert.throws(() => h.ledger.beginInference(OLD_KIND), (e) => e instanceof LedgerError);
    assert.equal(h.ledger.recordCost('judge', 0.1, 'x'), true);
  } finally { h.ledger.close(); }
});

test('a current-format ledger restarts with its daily inference budget and its halt intact', () => withDir((dir) => {
  const env = { ...PAPER, AGENT_DB_PATH: join(dir, 'ledger.db') };
  const h = makeHarness({ env });
  h.ledger.ensureInitial(1000);
  h.ledger.recordCost('judge', 0.75, 'judgment', { estimate: false, external: true });
  h.ledger.recordCost('deepseek', 0.05, 'confirmation', { estimate: true, external: true });
  h.ledger.latchHalt('synthetic halt');
  h.ledger.close();
  const h2 = makeHarness({ env });
  try {
    const st = h2.ledger.stats(1000);
    assert.equal(st.inferenceTodayUsd, 0.8);
    assert.ok(st.inferenceBudgetCommittedUsd >= 0.8);
    assert.equal(h2.ledger.kv.get('halt:paper').reason, 'synthetic halt');
  } finally { h2.ledger.close(); }
}));

test('the report reads a refused legacy ledger read-only and names the old judge kind through REPORT_LEGACY_JUDGE_KIND', () => withDir((dir) => {
  const env = { ...PAPER, AGENT_DB_PATH: join(dir, 'ledger.db') };
  const h = makeHarness({ env });
  h.ledger.ensureInitial(1000);
  h.ledger.db.prepare('INSERT INTO costs (ts, mode, kind, usd, ref, estimate, external) VALUES (?, ?, ?, ?, ?, 0, 1)').run(ts, 'paper', OLD_KIND, 0.75, 'synthetic pre-rename bill');
  h.ledger.close();
  assert.throws(() => makeHarness({ env }), LedgerError);
  const saved = process.env.REPORT_LEGACY_JUDGE_KIND;
  try {
    process.env.REPORT_LEGACY_JUDGE_KIND = OLD_KIND;
    const r = buildReport({ path: env.AGENT_DB_PATH, mode: 'paper', day: ts.slice(0, 10) });
    assert.equal(r.calls.judge.usd, 0.75);
    assert.equal(r.calls.inferenceUsd, 0.75);
    delete process.env.REPORT_LEGACY_JUDGE_KIND;
    const plain = buildReport({ path: env.AGENT_DB_PATH, mode: 'paper', day: ts.slice(0, 10) });
    assert.equal(plain.calls.judge.usd, 0); // without the alias the old kind is not the judge's; the external total still holds it
    assert.equal(plain.calls.externalUsd, 0.75);
  } finally {
    if (saved === undefined) delete process.env.REPORT_LEGACY_JUDGE_KIND; else process.env.REPORT_LEGACY_JUDGE_KIND = saved;
  }
  assert.equal(rowCount(env.AGENT_DB_PATH, 'costs'), 1);
}));
