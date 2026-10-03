#!/usr/bin/env node
// Historical candles for the replay harness: Coinbase Exchange public REST (keyless), one product,
// one granularity, an explicit UTC window, 300 candles per request, paced. The rows are validated
// (ascending unique bucket starts, finite positive OHLC, low <= open/close <= high, volume >= 0),
// written as JSON lines, and described by a sidecar .meta.json that names the window, the row
// count, every gap (a bucket with no trades is simply absent from the exchange's answer; nothing
// is invented to fill it) and the SHA-256 of the canonical file. Nothing here reads a key or a
// ledger; the replay reads only what this file holds.
//
//   node agent/history-fetch.mjs --from 2021-04-30T00:00:00Z --to 2021-06-01T00:00:00Z --granularity 60
//   node agent/history-fetch.mjs --from ... --to ... --granularity 300 --out data/history/custom.jsonl
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RecordableError } from './errors.mjs';

export const REST_URL = 'https://api.exchange.coinbase.com';
export const PAGE = 300;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const finite = (v) => Number.isFinite(v);

/** Validate and canonicalize rows of { t, open, high, low, close, volume } (t = bucket start, ms). Throws on a defect; deduplicates identical rows. */
export function canonicalize(rows, granularityMs) {
  const byT = new Map();
  for (const r of rows) {
    if (![r.t, r.open, r.high, r.low, r.close, r.volume].every(finite)) throw new RecordableError(`non-finite candle at ${r.t}`);
    if (r.t % granularityMs !== 0) throw new RecordableError(`bucket start ${r.t} not aligned to ${granularityMs} ms`);
    if (!(r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0)) throw new RecordableError(`non-positive price at ${new Date(r.t).toISOString()}`);
    if (r.low > Math.min(r.open, r.close) || r.high < Math.max(r.open, r.close)) throw new RecordableError(`low/high do not bound open/close at ${new Date(r.t).toISOString()}`);
    if (r.volume < 0) throw new RecordableError(`negative volume at ${new Date(r.t).toISOString()}`);
    const prev = byT.get(r.t);
    if (prev && ['open', 'high', 'low', 'close', 'volume'].some((k) => prev[k] !== r[k])) throw new RecordableError(`conflicting duplicate candle at ${new Date(r.t).toISOString()}`);
    byT.set(r.t, { t: r.t, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Gaps between consecutive buckets, as { from, to, missing } (missing = number of absent buckets). */
export function gapsOf(rows, granularityMs) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const d = rows[i].t - rows[i - 1].t;
    if (d > granularityMs) gaps.push({ from: new Date(rows[i - 1].t + granularityMs).toISOString(), to: new Date(rows[i].t).toISOString(), missing: d / granularityMs - 1 });
  }
  return gaps;
}

async function fetchPage({ product, granularity, startMs, endMs, fetchImpl }) {
  const url = `${REST_URL}/products/${product}/candles?granularity=${granularity}&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`;
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'trend-switcher-replay/1' } }); } catch (error) {
      if (attempt >= 5) throw new RecordableError(`history fetch transport failure after ${attempt} attempts: ${error?.name ?? 'error'}`);
      await delay(1000 * attempt); continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 5) throw new RecordableError(`history fetch HTTP ${response.status} after ${attempt} attempts`);
      await delay(1500 * attempt); continue;
    }
    if (!response.ok) throw new RecordableError(`history fetch HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new RecordableError('history fetch: not an array');
    return rows.map(([time, low, high, open, close, volume]) => ({ t: time * 1000, open, high, low, close, volume }));
  }
}

/** Fetch [fromMs, toMs) at `granularity` seconds; returns canonical rows. Paced at ~4 requests per second. */
export async function fetchHistory({ product = 'ETH-USD', granularity, fromMs, toMs, fetchImpl = globalThis.fetch, log = () => {} }) {
  const step = granularity * 1000;
  if (!Number.isInteger(granularity) || ![60, 300, 900, 3600, 21600, 86400].includes(granularity)) throw new RecordableError('granularity must be one of 60, 300, 900, 3600, 21600, 86400');
  if (!finite(fromMs) || !finite(toMs) || fromMs % step !== 0 || toMs % step !== 0 || toMs <= fromMs) throw new RecordableError('window must be aligned to the granularity and non-empty');
  const out = [];
  let pages = 0;
  for (let start = fromMs; start < toMs; start += PAGE * step) {
    const end = Math.min(toMs, start + PAGE * step) - step; // Coinbase includes both ends
    const rows = await fetchPage({ product, granularity, startMs: start, endMs: end, fetchImpl });
    out.push(...rows.filter((r) => r.t >= fromMs && r.t < toMs));
    pages += 1;
    if (pages % 20 === 0) log(`fetched ${pages} pages, ${out.length} rows, up to ${new Date(end).toISOString()}`);
    await delay(250);
  }
  return canonicalize(out, step);
}

export function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

/** Read a canonical history file written by this tool. */
export function readHistory(path) {
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return rows;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, granularity: { type: 'string', default: '60' }, product: { type: 'string', default: 'ETH-USD' }, out: { type: 'string' }, force: { type: 'boolean', default: false } } });
  const fromMs = Date.parse(values.from ?? ''); const toMs = Date.parse(values.to ?? ''); const granularity = Number(values.granularity);
  if (!finite(fromMs) || !finite(toMs)) { console.error('--from and --to must be ISO instants (UTC)'); process.exit(2); }
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace(/[-:]/gu, '').replace('T', 'T');
  const out = values.out ? resolve(values.out) : resolve(ROOT, 'data', 'history', `${values.product}-${granularity}s-${stamp(fromMs)}_${stamp(toMs)}.jsonl`);
  if (existsSync(out) && !values.force) { console.error(`exists: ${out} (use --force to refetch)`); process.exit(2); }
  mkdirSync(dirname(out), { recursive: true });
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  const rows = await fetchHistory({ product: values.product, granularity, fromMs, toMs, log });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const gaps = gapsOf(rows, granularity * 1000);
  const expected = (toMs - fromMs) / (granularity * 1000);
  const meta = { product: values.product, granularity, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), rows: rows.length, expectedBuckets: expected,
    missingBuckets: expected - rows.length, gaps, source: `${REST_URL}/products/${values.product}/candles`, fetchedAt: new Date().toISOString(), sha256: sha256File(out),
    first: rows.length ? new Date(rows[0].t).toISOString() : null, last: rows.length ? new Date(rows[rows.length - 1].t).toISOString() : null,
    low: rows.length ? Math.min(...rows.map((r) => r.low)) : null, high: rows.length ? Math.max(...rows.map((r) => r.high)) : null };
  writeFileSync(out.replace(/\.jsonl$/u, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  log(`${rows.length}/${expected} buckets, ${gaps.length} gaps (${meta.missingBuckets} missing), low ${meta.low} high ${meta.high}, sha256 ${meta.sha256.slice(0, 16)}… → ${out}`);
}
