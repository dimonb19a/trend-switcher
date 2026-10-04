// The ledger: judgments, decisions, switches with their legs (durable intents,
// TR-03 / R1-C), costs (inference, gas — TR-08 / R1-E), equity, arms of the
// shadow experiment, and a small key/value store, in SQLite through
// node:sqlite. Provenance columns (model, config and source hashes, schema,
// timestamps) answer TR-11 / R1-H. `transaction()` makes paper fills atomic.
//
// Time comes from ONE injected clock shared with the engine (R1-A): every
// timestamp, every UTC day boundary and every "how long ago" reads it.
//
// Accounting identity (R1-E): P&L is measured on the whole wallet
// (native + WETH + USDC at the tape price in live; the virtual balances in
// paper) minus the costs paid OUTSIDE that wallet. Gas in live is paid from
// the wallet and therefore already inside the wallet value: it is recorded
// (external = 0) but never subtracted a second time. In paper the virtual
// wallet pays nothing, so the gas estimate is external. Inference (the judge,
// DeepSeek) is external in both modes, whether or not the answer was usable.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { canonicalJson, cfg as defaultCfg, describeConfig } from './config.mjs';
import { RecordableError } from './errors.mjs';

export const SCHEMA_VERSION = 6; // v2.7: inference attempts, slot/valuation observations and compressed market inputs. Fresh ledger required; no silent migration.

export class LedgerError extends RecordableError {}

/** The cost kinds and inference providers this build writes. A file holding any other value was written by an earlier build and is not resumed (see openLedger). */
export const KNOWN_COST_KINDS = Object.freeze(['judge', 'deepseek', 'gas']);
export const KNOWN_PROVIDERS = Object.freeze(['judge', 'deepseek']);

/** Switch statuses that count as intents for the daily quota and the minimum hold. */
export const COUNTED_SWITCH = "('planned','executing','done','partial','failed','unknown')";
const OPEN_SWITCH = "('planned','executing','unknown')";
const OPEN_LEG = "('broadcasting','approval_sent','sent','unknown')";
/** Leg states at or past the broadcast boundary: the chain may hold a transaction for them. */
export const OPEN_LEG_STATES = Object.freeze(['broadcasting', 'approval_sent', 'sent', 'unknown']);

const quoteKind = (value) => `'${String(value).replace(/[^A-Za-z0-9_.-]/gu, '?').slice(0, 40)}'`;

/**
 * A ledger of the current schema may still have been written by an earlier build that booked the
 * judge's cost or inference calls under another name. Those rows would fall outside the daily
 * inference budget (and the UNKNOWN-billing reserve) of this build, so such a file is not resumed:
 * it stays a read-only archive (report.mjs reads it, REPORT_LEGACY_JUDGE_KIND names the old kind)
 * and a run starts on a fresh AGENT_DB_PATH. Nothing is migrated silently.
 */
function assertCompatibleRows(db, path) {
  const kinds = db.prepare('SELECT DISTINCT kind FROM costs').all().map((r) => r.kind).filter((k) => !KNOWN_COST_KINDS.includes(k));
  const providers = db.prepare('SELECT DISTINCT provider FROM inference_calls').all().map((r) => r.provider).filter((p) => !KNOWN_PROVIDERS.includes(p));
  if (!kinds.length && !providers.length) return;
  db.close();
  const what = [kinds.length ? `cost kind${kinds.length === 1 ? '' : 's'} ${kinds.map(quoteKind).join(', ')}` : null,
    providers.length ? `inference provider${providers.length === 1 ? '' : 's'} ${providers.map(quoteKind).join(', ')}` : null].filter(Boolean).join(' and ');
  throw new LedgerError(`ledger ${path} was written by an earlier build (${what}): it is not resumed, because those rows would fall outside this build's daily inference budget. Keep the file as a read-only archive (node agent/report.mjs --db <file>, with REPORT_LEGACY_JUDGE_KIND=<old kind> for the judge's cost) and start on a fresh AGENT_DB_PATH; nothing is migrated silently`);
}

export function openLedger(cfg = defaultCfg, { clock = () => Date.now() } = {}) {
  if (cfg.databasePath !== ':memory:') mkdirSync(dirname(cfg.databasePath), { recursive: true });
  const db = new DatabaseSync(cfg.databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
  if (hasTables && version !== SCHEMA_VERSION) {
    db.close();
    throw new LedgerError(`ledger ${cfg.databasePath} has schema version ${version}; this agent needs ${SCHEMA_VERSION}. Move the file aside (for example data/agent-v2.3-<date>.db) and start again; nothing is migrated silently`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS judgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL, price REAL,
      features TEXT NOT NULL, state TEXT NOT NULL, answers TEXT, summary TEXT, ms INTEGER, cost_usd REAL, error TEXT,
      model TEXT, request_at TEXT, response_at TEXT, feature_schema TEXT, config_hash TEXT, source_hash TEXT, tape_source TEXT, candle_source TEXT
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL, price REAL,
      position TEXT NOT NULL, candidate TEXT, votes TEXT, outcome TEXT NOT NULL, reason TEXT, deepseek TEXT, deepseek_model TEXT, stage TEXT
    );
    CREATE TABLE IF NOT EXISTS switches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL, from_side TEXT NOT NULL, to_side TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL, notional_usd REAL, budget_usd REAL, spent_usd REAL,
      halt_reason TEXT, halt_acked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, switch_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      token_in TEXT NOT NULL, token_out TEXT, amount_in REAL NOT NULL, min_out REAL, quote_out REAL, quote_at TEXT, quote_block INTEGER,
      deadline INTEGER, nonce INTEGER, tx_hash TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL,
      amount_out_actual REAL, gas_l2_usd REAL, gas_l1_usd REAL, receipt_block INTEGER, error TEXT,
      gas_l2_wei TEXT, gas_l1_wei TEXT, l1_known INTEGER, l1_bound_wei TEXT, amount_out_raw TEXT,
      accounting TEXT NOT NULL DEFAULT 'none', price_usd REAL, priced_at TEXT, price_source TEXT
    );
    CREATE TABLE IF NOT EXISTS costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL, kind TEXT NOT NULL, usd REAL NOT NULL, ref TEXT,
      estimate INTEGER NOT NULL DEFAULT 1, external INTEGER NOT NULL DEFAULT 1,
      key TEXT, price_usd REAL, price_at TEXT, price_source TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS costs_key ON costs (mode, key) WHERE key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS equity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL,
      eth REAL, weth REAL, usdc REAL, price REAL, equity_usd REAL, wallet_usd REAL, costs_usd REAL, net_usd REAL
    );
    CREATE TABLE IF NOT EXISTS arms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL, arm TEXT NOT NULL,
      side TEXT NOT NULL, eth_side REAL, usdc REAL, equity_usd REAL, costs_usd REAL, net_usd REAL, switches INTEGER, note TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS inference_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL,
      provider TEXT NOT NULL, status TEXT NOT NULL, billing TEXT NOT NULL,
      completed_at TEXT, usd REAL, usage TEXT, response TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, mode TEXT NOT NULL,
      codec TEXT NOT NULL, payload BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS equity_ts ON equity (mode, ts);
    CREATE INDEX IF NOT EXISTS switches_status ON switches (mode, status);
    CREATE INDEX IF NOT EXISTS costs_ts ON costs (mode, ts);
    CREATE INDEX IF NOT EXISTS arms_ts ON arms (mode, arm, ts);
    -- two reads the engine makes on every tick, over tables that grow by a row per tick: without these a long
    -- run (a seven-month replay, sixty thousand ticks) slowed from a third of a second a tick to seconds a tick
    CREATE INDEX IF NOT EXISTS inference_billing ON inference_calls (mode, billing);
    CREATE INDEX IF NOT EXISTS costs_external ON costs (mode, external);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  if (hasTables) assertCompatibleRows(db, cfg.databasePath);

  const mode = cfg.mode;
  const now = () => new Date(clock()).toISOString();
  const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
  const dayStart = () => { const d = new Date(clock()); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

  const kv = {
    get(key) {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    },
    set(key, value) {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    },
    del(key) { db.prepare('DELETE FROM kv WHERE key = ?').run(key); },
  };

  /**
   * Run `fn` inside one SQLite transaction; roll back on any throw. Reentrant: a nested call joins
   * the outer transaction, so a helper that is atomic on its own stays atomic as part of a larger
   * step (R3-C4). A process that dies anywhere inside leaves nothing of it in the file.
   */
  let depth = 0;
  function transaction(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN');
    depth += 1;
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { depth -= 1; }
  }

  const described = describeConfig(cfg);
  const provenance = {
    configHash: createHash('sha256').update(canonicalJson(described)).digest('hex').slice(0, 16),
    sourceHash: (() => {
      try {
        const dir = dirname(fileURLToPath(import.meta.url));
        const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('test-')).sort();
        const h = createHash('sha256');
        for (const f of files) h.update(f).update(readFileSync(resolve(dir, f)));
        return h.digest('hex').slice(0, 16);
      } catch (error) { throw new LedgerError(`cannot fingerprint agent source: ${error.code ?? error.name}`); }
    })(),
  };
  // the non-secret effective configuration behind this hash, once per hash: what a report reads to name the tick,
  // the virtual capital, the cap and the budget of every row that carries the hash (secrets are set/unset only)
  kv.set(`config:${provenance.configHash}`, { ...described, recordedAt: now(), sourceHash: provenance.sourceHash });

  // Commit BEFORE network I/O. A crash leaves UNKNOWN, never an invented zero bill.
  function beginInference(provider) {
    if (!['judge', 'deepseek'].includes(provider)) throw new LedgerError('unknown provider');
    return Number(db.prepare("INSERT INTO inference_calls (ts,mode,provider,status,billing) VALUES (?,?,?,'dispatched','UNKNOWN')").run(now(), mode, provider).lastInsertRowid);
  }
  function settleInference(id, response = {}) {
    return transaction(() => {
      const row = db.prepare('SELECT * FROM inference_calls WHERE id = ? AND mode = ?').get(id, mode);
      if (!row || row.status !== 'dispatched') throw new LedgerError('inference settlement must happen exactly once');
      const notSent = response.notSent === true;
      const known = notSent || (Number.isFinite(response.costUsd) && response.costUsd >= 0);
      const usd = notSent ? 0 : known ? response.costUsd : null;
      // Only selected response fields; never arbitrary Error objects, request headers or env.
      const safe = { ok: response.ok ?? !response.error, reason: response.reason ?? null,
        model: response.model ?? null, answers: response.answers ?? null,
        stance: response.stance ?? null, confidence: response.confidence ?? null,
        reasons: response.reasons ?? null, ms: response.ms ?? null };
      db.prepare('UPDATE inference_calls SET status=?,billing=?,completed_at=?,usd=?,usage=?,response=? WHERE id=?')
        .run(notSent ? 'not-sent' : 'responded', known ? 'KNOWN' : 'UNKNOWN', now(), usd,
          j(response.usage), j(safe), id);
      if (known && usd > 0) recordCost(row.provider, usd, `inference ${id}`, { key: `inference:${id}`, estimate: row.provider === 'deepseek', external: true });
      if (!known && !cfg.paperContinueUnknownBilling) latchHalt(`inference ${id} (${row.provider}) billing UNKNOWN; reconcile before another run`);
      return { id, billing: known ? 'KNOWN' : 'UNKNOWN', usd };
    });
  }
  const unknownInference = () => db.prepare("SELECT id,provider,ts,status FROM inference_calls WHERE mode=? AND billing='UNKNOWN' ORDER BY id").all(mode);
  function observe(kind, payload) {
    return Number(db.prepare('INSERT INTO observations(ts,mode,kind,payload) VALUES (?,?,?,?)').run(now(), mode, kind, JSON.stringify(payload)).lastInsertRowid);
  }
  function captureInput(snapshot) {
    return Number(db.prepare("INSERT INTO market_inputs(ts,mode,codec,payload) VALUES (?,?,'json+gzip',?)")
      .run(now(), mode, gzipSync(Buffer.from(JSON.stringify(snapshot)))).lastInsertRowid);
  }

  function insertJudgment({ price, features, state, answers, summary, ms, costUsd, error, model, requestAt, responseAt, tapeSource, candleSource, callId = null }) {
    db.prepare(`INSERT INTO judgments (ts, mode, price, features, state, answers, summary, ms, cost_usd, error, model, request_at, response_at, feature_schema, config_hash, source_hash, tape_source, candle_source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now(), mode, price ?? null, JSON.stringify(features ?? {}), state ?? '', j(answers), j(summary), ms ?? null, costUsd ?? null, error ?? null,
        model ?? null, requestAt ?? null, responseAt ?? null, features?.schema ?? null, provenance.configHash, provenance.sourceHash, tapeSource ?? null, candleSource ?? null);
    if (callId === null && Number.isFinite(costUsd) && costUsd > 0) recordCost('judge', costUsd, 'judgment', { estimate: false, external: true });
  }

  function insertDecision({ price, position, candidate, votes, outcome, reason, deepseek, stage }) {
    db.prepare('INSERT INTO decisions (ts, mode, price, position, candidate, votes, outcome, reason, deepseek, deepseek_model, stage) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(now(), mode, price ?? null, position, candidate ?? null, j(votes), outcome, reason ?? null, j(deepseek), deepseek?.model ?? null, stage ?? null);
  }

  /**
   * A cost. `external` = paid outside the measured wallet (inference always; gas only in paper).
   * `key` makes the row exactly-once: a second insert with the same key is ignored (R2-C2). The
   * price used for the USD figure travels with the row (`price`, `priceAt`, `priceSource`), so a
   * figure booked at recovery time is never mistaken for an execution-time fact (R2-C1).
   * Returns true when a row was inserted, false when the key already existed.
   */
  function recordCost(kind, usd, ref, { estimate = true, external = true, key = null, price = null, priceAt = null, priceSource = null } = {}) {
    if (!KNOWN_COST_KINDS.includes(kind)) throw new LedgerError(`unknown cost kind ${quoteKind(kind)}; a cost is booked under one of ${KNOWN_COST_KINDS.join(', ')}`);
    if (!Number.isFinite(usd) || usd < 0) throw new RecordableError(`cost must be a finite non-negative number, got ${usd}`);
    const info = db.prepare('INSERT OR IGNORE INTO costs (ts, mode, kind, usd, ref, estimate, external, key, price_usd, price_at, price_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(now(), mode, kind, usd, ref ?? null, estimate ? 1 : 0, external ? 1 : 0, key, price, priceAt, priceSource);
    return info.changes === 1;
  }

  function externalCostsSince(ts) {
    return db.prepare('SELECT COALESCE(SUM(usd),0) AS usd FROM costs WHERE mode = ? AND ts >= ? AND external = 1').get(mode, ts).usd;
  }

  function costsSince(ts) {
    return db.prepare('SELECT COALESCE(SUM(usd),0) AS usd FROM costs WHERE mode = ? AND ts >= ?').get(mode, ts).usd;
  }

  function inferenceSince(ts) {
    return db.prepare("SELECT COALESCE(SUM(usd),0) AS usd FROM costs WHERE mode = ? AND ts >= ? AND kind IN ('judge','deepseek')").get(mode, ts).usd;
  }
  function unknownInferenceReserveSince(ts) {
    if (!cfg.paperContinueUnknownBilling) return 0;
    const n = db.prepare("SELECT COUNT(*) AS n FROM inference_calls WHERE mode = ? AND ts >= ? AND billing = 'UNKNOWN'").get(mode, ts).n;
    return n * cfg.paperUnknownBillReserveUsd;
  }

  function insertEquity({ eth, weth, usdc, price, equityUsd, walletUsd = equityUsd }) {
    const initial = kv.get(`initial:${mode}`);
    const external = initial ? externalCostsSince(initial.ts) : 0;
    db.prepare('INSERT INTO equity (ts, mode, eth, weth, usdc, price, equity_usd, wallet_usd, costs_usd, net_usd) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(now(), mode, eth, weth, usdc, price, equityUsd, walletUsd, external, walletUsd - external);
  }

  function ensureInitial(walletUsd) {
    if (!kv.get(`initial:${mode}`)) kv.set(`initial:${mode}`, { ts: now(), equityUsd: walletUsd, walletUsd });
    return kv.get(`initial:${mode}`);
  }

  // ---- switches and legs (durable intents) ----
  function openSwitch({ fromSide, toSide, reason, notionalUsd, budgetUsd }) {
    const ts = now();
    const info = db.prepare('INSERT INTO switches (ts, mode, from_side, to_side, status, reason, updated_at, notional_usd, budget_usd) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(ts, mode, fromSide, toSide, 'planned', reason ?? null, ts, notionalUsd ?? null, budgetUsd ?? null);
    return Number(info.lastInsertRowid);
  }
  function updateSwitch(id, fields) {
    const sets = []; const values = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); values.push(v); }
    sets.push('updated_at = ?'); values.push(now()); values.push(id);
    db.prepare(`UPDATE switches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  function openLeg({ switchId, seq, kind, tokenIn, tokenOut, amountIn, minOut, quoteOut, quoteAt, quoteBlock, deadline, status = 'planned' }) {
    const ts = now();
    const info = db.prepare(`INSERT INTO legs (switch_id, seq, kind, token_in, token_out, amount_in, min_out, quote_out, quote_at, quote_block, deadline, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(switchId, seq, kind, tokenIn, tokenOut ?? null, amountIn, minOut ?? null, quoteOut ?? null, quoteAt ?? null, quoteBlock ?? null, deadline ?? null, status, ts);
    return Number(info.lastInsertRowid);
  }
  function updateLeg(id, fields) {
    const sets = []; const values = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); values.push(v); }
    sets.push('updated_at = ?'); values.push(now()); values.push(id);
    db.prepare(`UPDATE legs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  /** Legs of a switch that were never broadcast: closed as cancelled, never left `planned`. */
  function cancelPlannedLegs(switchId, reason) {
    db.prepare("UPDATE legs SET status = 'cancelled', error = COALESCE(error, ?), updated_at = ? WHERE switch_id = ? AND status = 'planned'").run(reason ?? null, now(), switchId);
  }
  /**
   * The terminal transition of a switch as ONE durable step (R3-C4): its never-sent legs are
   * cancelled, its status and reason are written, and when the outcome requires a halt the
   * requirement is recorded on the switch itself (`halt_reason`) in the same transaction as the
   * global latch. A process that dies anywhere inside leaves the switch open, so the next restart
   * settles it again; a switch that reached its terminal status with a `halt_reason` that nobody
   * acknowledged is re-latched by `requiredHalts()` on restart.
   */
  function closeSwitch(id, { status, reason, halt = null, cancelPlanned = true }) {
    transaction(() => {
      if (cancelPlanned) api.cancelPlannedLegs(id, reason ?? null);
      const fields = { status, halt_reason: halt };
      if (reason !== undefined) fields.reason = reason; // a close without a reason keeps the one already recorded
      api.updateSwitch(id, fields); // through the public method, so the status write is the observable boundary (crash probes hook it)
      if (halt) api.latchHalt(halt);
    });
  }
  /** Switches whose terminal outcome required a halt that the owner has not acknowledged with --reset-halt. */
  function requiredHalts() {
    return db.prepare('SELECT id, status, halt_reason FROM switches WHERE mode = ? AND halt_reason IS NOT NULL AND halt_acked_at IS NULL ORDER BY id').all(mode);
  }
  function pendingSwitches() { return db.prepare(`SELECT * FROM switches WHERE mode = ? AND status IN ${OPEN_SWITCH} ORDER BY id`).all(mode); }
  /** Legs at or past the broadcast boundary, whatever their parent switch says (R2-C3). */
  function pendingLegs() { return db.prepare(`SELECT l.* FROM legs l JOIN switches s ON s.id = l.switch_id WHERE s.mode = ? AND l.status IN ${OPEN_LEG} ORDER BY l.id`).all(mode); }
  /**
   * Settled legs whose gas has not been booked in USD yet: an accounting obligation, not a zero
   * (R2-C1). A leg whose receipt facts are disputed and whose cost was never booked is the same
   * kind of obligation — one that a human, not the next priced tick, resolves (R4-C6).
   */
  function legsAwaitingAccounting({ excludeSwitchId = null } = {}) {
    return db.prepare("SELECT l.* FROM legs l JOIN switches s ON s.id = l.switch_id WHERE s.mode = ? AND (l.accounting = 'pending' OR (l.accounting = 'conflict' AND l.price_usd IS NULL)) AND l.switch_id != ? ORDER BY l.id").all(mode, excludeSwitchId ?? -1);
  }
  /** Switches a restart must settle: open by status, or holding any leg that is not terminal — the parent's label alone decides nothing (R2-C3). */
  function switchesToSettle() {
    return db.prepare(`SELECT DISTINCT s.* FROM switches s LEFT JOIN legs l ON l.switch_id = s.id WHERE s.mode = ? AND (s.status IN ${OPEN_SWITCH} OR l.status IN ('planned','broadcasting','approval_sent','sent','unknown')) ORDER BY s.id`).all(mode);
  }
  function legsOf(switchId) { return db.prepare('SELECT * FROM legs WHERE switch_id = ? ORDER BY seq').all(switchId); }
  function getLeg(id) { return db.prepare('SELECT * FROM legs WHERE id = ?').get(id); }
  function getSwitch(id) { return db.prepare('SELECT * FROM switches WHERE id = ?').get(id); }
  /**
   * The switch's paid gas, recomputed from every leg whose cost was booked, whatever its current
   * accounting label: a conflict discovered later never erases a committed expense (R4-C7). While
   * any settled leg of the switch (receipt facts recorded) has no booked cost, the total is not
   * known, and it says so — NULL — instead of presenting a smaller sum as complete.
   */
  function recomputeSpent(switchId) {
    db.prepare(`UPDATE switches SET spent_usd = (
        SELECT CASE WHEN EXISTS (SELECT 1 FROM legs WHERE switch_id = ? AND accounting != 'none' AND price_usd IS NULL) THEN NULL
               ELSE COALESCE(SUM(COALESCE(gas_l2_usd, 0) + COALESCE(gas_l1_usd, 0)), 0) END
        FROM legs WHERE switch_id = ? AND price_usd IS NOT NULL
      ), updated_at = ? WHERE id = ?`).run(switchId, switchId, now(), switchId);
  }
  /** The status a switch's legs prove: unknown while any leg may hold a transaction; done only when every leg confirmed and a swap ran. */
  function deriveSwitchStatus(switchId) {
    const legs = legsOf(switchId);
    if (legs.some((l) => OPEN_LEG_STATES.includes(l.status))) return 'unknown';
    if (legs.some((l) => l.status === 'failed')) return 'failed';
    if (legs.length && legs.every((l) => l.status === 'confirmed') && legs.some((l) => l.kind === 'swap' || l.kind === 'paper')) return 'done';
    return legs.some((l) => l.status === 'confirmed') ? 'partial' : 'failed_before_send';
  }

  /**
   * Everything the limits need, from durable rows. `excludeSwitchId` is the intent being executed
   * right now: it is not a PREVIOUS switch, so it neither starts the minimum hold nor occupies a
   * daily slot in its own preflights — its slot was reserved once, when it was opened (R1-A).
   */
  function stats(currentWalletUsd, { excludeSwitchId = null } = {}) {
    const day = dayStart();
    const excluded = excludeSwitchId ?? -1;
    const switchesToday = db.prepare(`SELECT COUNT(*) AS n FROM switches WHERE mode = ? AND ts >= ? AND status IN ${COUNTED_SWITCH} AND id != ?`).get(mode, day, excluded).n;
    const last = db.prepare(`SELECT ts FROM switches WHERE mode = ? AND status IN ${COUNTED_SWITCH} AND id != ? ORDER BY id DESC LIMIT 1`).get(mode, excluded);
    const firstToday = db.prepare('SELECT ts, wallet_usd FROM equity WHERE mode = ? AND ts >= ? ORDER BY id ASC LIMIT 1').get(mode, day);
    const initial = kv.get(`initial:${mode}`);
    const net = (base, sinceTs) => (base && base > 0 && Number.isFinite(currentWalletUsd) ? ((currentWalletUsd - externalCostsSince(sinceTs)) / base - 1) * 100 : null);
    const inferenceTodayUsd = inferenceSince(day);
    const inferenceUnknownReserveUsd = unknownInferenceReserveSince(day);
    return {
      switchesToday,
      lastSwitchAt: last ? Date.parse(last.ts) : null,
      dailyNetPnlPct: firstToday ? net(firstToday.wallet_usd, firstToday.ts) : null,
      totalNetPnlPct: initial ? net(initial.walletUsd ?? initial.equityUsd, initial.ts) : null,
      initialEquityUsd: initial?.walletUsd ?? initial?.equityUsd ?? null,
      inferenceTodayUsd,
      inferenceUnknownReserveUsd,
      inferenceBudgetCommittedUsd: inferenceTodayUsd + inferenceUnknownReserveUsd,
      costsTodayUsd: costsSince(day),
      halt: kv.get(`halt:${mode}`),
      // open intents, legs the chain may still hold, and settled legs whose gas is not booked yet: every one of them blocks a new switch
      pendingSwitches: pendingSwitches().filter((s) => s.id !== excludeSwitchId).length + pendingLegs().filter((l) => l.switch_id !== excludeSwitchId).length + legsAwaitingAccounting({ excludeSwitchId }).length,
    };
  }

  function latchHalt(reason) { if (!kv.get(`halt:${mode}`)) kv.set(`halt:${mode}`, { reason, at: now() }); }
  /** The owner's reset: clears the latch and acknowledges every switch-level halt requirement in one step. */
  function resetHalt() {
    transaction(() => {
      kv.del(`halt:${mode}`);
      db.prepare('UPDATE switches SET halt_acked_at = ?, updated_at = ? WHERE mode = ? AND halt_reason IS NOT NULL AND halt_acked_at IS NULL').run(now(), now(), mode);
    });
  }

  function insertArm({ arm, side, ethSide, usdc, equityUsd, costsUsd = 0, netUsd = equityUsd - costsUsd, switches, note }) {
    db.prepare('INSERT INTO arms (ts, mode, arm, side, eth_side, usdc, equity_usd, costs_usd, net_usd, switches, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(now(), mode, arm, side, ethSide, usdc, equityUsd, costsUsd, netUsd, switches ?? 0, note ?? null);
  }

  /**
   * The fill price (USDC per ETH) of the most recent completed switch into USDC in this mode — every executed leg of
   * that switch together, so a live sale of native ETH and WETH counts as one price — or null when there is none.
   * The re-entry level of REENTRY=above-sale and above-sale-votes (README: Strategies).
   */
  function lastSalePrice() {
    const sale = db.prepare("SELECT id FROM switches WHERE mode = ? AND to_side = 'USDC' AND status = 'done' ORDER BY id DESC LIMIT 1").get(mode);
    if (!sale) return null;
    const r = db.prepare("SELECT COALESCE(SUM(amount_in),0) AS ai, COALESCE(SUM(amount_out_actual),0) AS ao FROM legs WHERE switch_id = ? AND kind IN ('swap','paper') AND amount_out_actual IS NOT NULL").get(sale.id);
    return r.ai > 0 && r.ao > 0 ? r.ao / r.ai : null;
  }

  function totals() {
    const judgments = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM judgments WHERE mode = ?').get(mode);
    const switches = db.prepare('SELECT COUNT(*) AS n FROM switches WHERE mode = ?').get(mode).n;
    const costs = db.prepare('SELECT kind, COALESCE(SUM(usd),0) AS usd FROM costs WHERE mode = ? GROUP BY kind').all(mode);
    return { judgments: judgments.n, judgeCostUsd: judgments.cost, switches, costs: Object.fromEntries(costs.map((c) => [c.kind, c.usd])) };
  }

  const api = {
    db, kv, clock, transaction, provenance, insertJudgment, insertDecision, recordCost, insertEquity, ensureInitial,
    beginInference, settleInference, unknownInference, observe, captureInput,
    openSwitch, updateSwitch, getSwitch, closeSwitch, requiredHalts, recomputeSpent, deriveSwitchStatus, openLeg, updateLeg, getLeg, cancelPlannedLegs,
    pendingSwitches, pendingLegs, legsAwaitingAccounting, switchesToSettle, legsOf, stats, latchHalt, resetHalt, insertArm, totals, lastSalePrice,
    close() { db.close(); },
  };
  return api;
}
