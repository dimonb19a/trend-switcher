// The engine: one tick = fresh data → features → judgment → votes → candidate
// → trend filter → limits → slow brain → and then, before EVERY paid effect,
// the admissibility verdict taken at ONE instant after every wait that could
// change it, with no await between the verdict and the effect (R1-B). The
// verdict values the raw balances it was handed at ITS price (R2-B1) and, for
// an effect, judges the exact amount that will be sent: its availability in
// the fresh balances and its notional at the verdict's price (R3-V1). A loss
// limit seen anywhere — at the tick's entry, after a billed inference cost,
// inside a verdict — latches there and then (R2-E1, R3-E2/E3); after a wait
// the cost is judged against the balances valued at the tape's price at THAT
// instant, never against the valuation the tick started with (R4-E4).
// Switches are durable intents whose legs are all written before the first
// broadcast; a leg is marked `broadcasting` before the send, so a crash at
// that boundary is recovered as UNKNOWN, never as "nothing happened" (R1-C).
// A terminal outcome and the halt it requires are ONE durable step, and the
// requirement lives on the switch row until the owner resets (R3-C4).
// One receipt is settled by one function on the normal path and on restart:
// facts in native units on the leg, the cost keyed by the leg (exactly once),
// leg, cost and switch changed in one SQLite transaction; a replay of the same
// receipt keeps the first committed valuation, and conflicting facts become a
// visible `conflict`, never a silent overwrite (R2-C1..C3, R3-C5). Without a
// price the gas stays an obligation the next priced tick books. Whether the
// receipt's facts are recorded and whether their USD cost is booked are two
// separate facts: an unpriced leg that meets different facts keeps its
// originals and becomes a conflict nobody books but a human; a booked leg
// that becomes a conflict keeps its committed cost in the switch's total; a
// switch with a settled leg that is not booked has an unresolved total, shown
// as NULL, never as a smaller number (R4-C6/C7).
// The gas bound is checked on the estimate of the exact bytes sent, and on
// what remains after each paid leg (R1-D). Everything external is injected;
// the engine and the ledger must share one clock (R1-A). `run.mjs` wires the
// real deps.
import { existsSync } from 'node:fs';
import { VoteWindow, breakoutFilter, limits, riskBreach, trendFilter } from './policy.mjs';
import { computeFeatures, renderState as defaultRenderState } from './features.mjs';
import { OPEN_LEG_STATES } from './ledger.mjs';
import { RecordableError, describeError  } from './errors.mjs';

/** The only allowed live combination is MODE=live AND --live; every other mismatch refuses to start (TR-01). */
export function resolveArming({ mode, liveFlag }) {
  if (mode === 'live' && liveFlag === true) return { armed: true, mode: 'live' };
  if (mode === 'live') return { armed: false, refuse: 'MODE=live is set but --live was not given: refusing to start (both are required to arm)' };
  if (liveFlag === true) return { armed: false, refuse: '--live was given but MODE is not live: refusing to start' };
  return { armed: false, mode: 'paper' };
}

export function createEngine(deps) {
  const {
    cfg, armed, chain, ledger, feed, judge, slowBrain, arms = null,
    clock = () => Date.now(), fsx = { existsSync }, log = () => {}, judgeEnabled = true,
    canAct = () => true, captureInputs = false,
    renderState = defaultRenderState, // the one text both models read; a replay injects a renderer that hides the date
  } = deps;
  const mode = armed ? 'live' : 'paper';
  if (mode !== cfg.mode) throw new RecordableError(`engine mode ${mode} disagrees with configuration mode ${cfg.mode}`);
  const continueUnknownBilling = mode === 'paper' && cfg.paperContinueUnknownBilling;
  if (ledger.clock && ledger.clock !== clock) throw new RecordableError('the engine and the ledger must share one clock (R1-A)');
  const votes = new VoteWindow(cfg);
  let lastDeepseekAt = 0; let busy = false; let lastQuotes = null; let budgetWarned = false;
  let quoteFailureCooldownUntil = 0; // paper only: after a quote failed before any effect, no new candidate is pursued for a while
  const { parseUnits, formatUnits, formatEther } = chain.raw;
  const weiToUsd = (wei, price) => Number(formatEther(wei)) * price;
  const usdToWei = (usd, price) => parseUnits(Math.max(0, usd / price).toFixed(18), 18);
  const killPresent = () => fsx.existsSync(cfg.killFile);

  // ---------- balances and their valuation, kept apart (R2-B1) ----------
  /**
   * The virtual wallet's opening balances (paper only), written once. With a configured virtual capital
   * (`PAPER_CAPITAL_USD`) the wallet opens with that many dollars in ETH at the
   * tape's price at this instant — in ETH, as the real wallet stands — and the row records the capital,
   * the opening price and its source, so a report can name them; without it the wallet mirrors the
   * real one, as before. A virtual capital without a price is not opened: the caller passes the tick's
   * price, the feed's current price is the fallback, and neither being there is an error, never a zero.
   */
  function openingPaperBalances(real, priceHint, at) {
    const since = new Date(at).toISOString();
    const opened = (ethSide, usdc, extra) => ({ ethSide, usdc, since, opening: { ethSide, usdc }, ...extra }); // `opening` survives every fill: the row's later values are the current balances
    if (cfg.paperCapitalUsd === null) return opened(Math.max(0, real.eth - cfg.gasReserveEth) + real.weth, real.usdc, { source: 'real wallet' });
    const price = Number.isFinite(priceHint) ? priceHint : feed.snapshot(at).last?.p;
    if (!Number.isFinite(price) || price <= 0) throw new RecordableError('virtual capital cannot be opened without a tape price');
    return opened(cfg.paperCapitalUsd / price, 0, { source: 'PAPER_CAPITAL_USD', capitalUsd: cfg.paperCapitalUsd, openingPrice: price });
  }

  /** The raw balances (real in live, virtual in paper) with the instant they were read. No price here; `price` only opens a virtual capital on its first read. */
  async function readBalances({ price = null } = {}) {
    const owner = chain.address();
    const real = await chain.balances(owner);
    const at = clock();
    let paper = null;
    if (mode === 'paper') {
      paper = ledger.kv.get('paper:balances');
      if (!paper) {
        paper = openingPaperBalances(real, price, at);
        ledger.kv.set('paper:balances', paper);
        log(`paper balances opened from ${paper.source}`, paper);
      }
    }
    return { at, owner, real, paper };
  }

  /**
   * The valuation of raw balances at ONE price. `equityUsd` is the tradable capital (native above the
   * gas reserve + WETH, and USDC): notional and side. `walletUsd` is the whole account: the base of
   * every P&L figure (R1-E). Pure, so the verdict can re-value the same balances at its own price.
   */
  function valuePosition(balances, price) {
    const { at, owner, real, paper } = balances;
    let ethSide; let usdc; let nativeSurplus = 0; let weth = 0; let walletUsd;
    if (mode === 'live') {
      nativeSurplus = Math.max(0, real.eth - cfg.gasReserveEth); weth = real.weth; ethSide = nativeSurplus + weth; usdc = real.usdc;
      walletUsd = (real.eth + real.weth) * price + real.usdc;
    } else {
      ethSide = paper.ethSide; usdc = paper.usdc; weth = paper.ethSide;
      walletUsd = ethSide * price + usdc;
    }
    const ethUsd = ethSide * price; const equityUsd = ethUsd + usdc;
    const ethPct = equityUsd > 0 ? (ethUsd / equityUsd) * 100 : 0;
    const side = ethPct >= 80 ? 'ETH' : ethPct <= 20 ? 'USDC' : 'MIXED';
    return { at, owner, real, paper, price, ethSide, nativeSurplus, weth, usdc, ethUsd, equityUsd, walletUsd, ethPct, side };
  }

  async function readPosition(price) { return valuePosition(await readBalances({ price }), price); }

  /** How much of a leg's input token the FRESH balances make available, in raw units (R3-V1). */
  function availableRaw(position, send) {
    if (mode === 'paper') {
      return send.label === 'USDC' ? parseUnits(position.paper.usdc.toFixed(6), 6) : parseUnits(position.paper.ethSide.toFixed(18), 18);
    }
    if (send.label === 'ETH') return parseUnits(position.nativeSurplus.toFixed(18), 18);
    if (send.label === 'WETH') return position.real.wethRaw;
    return position.real.usdcRaw;
  }

  /** The tape's current price with its provenance, or null while the feed has none (a cold start). */
  function currentValuation(where) {
    const snap = feed.snapshot(clock());
    const price = snap.last?.p;
    if (!Number.isFinite(price)) return null;
    return { price, priceAt: new Date(snap.last.t).toISOString(), priceSource: `coinbase:${snap.product}@${where}` };
  }

  // ---------- the risk state: one path, wherever a valuation or a cost is seen (R1-E, R2-E1, R3-E2/E3) ----------
  /** Latch the halt when the stats show a loss beyond a limit; returns stats that reflect the latch. `note` names a caveat of the valuation (a stale tape), after the source. */
  function noteRisk(st, walletUsd, where, opts = {}, note = null) {
    const breach = riskBreach(st, cfg);
    if (!breach || st.halt) return st;
    ledger.latchHalt(`risk (${where}): ${breach}${note ? ` [${note}]` : ''}`);
    log('loss limit crossed: halted until --reset-halt', { where, reason: breach, note });
    return ledger.stats(walletUsd, opts);
  }

  /**
   * The balances of this tick valued at the tape's price at THIS instant (R4-E4): after a wait the
   * price the tick started with is history, so a cost billed during the wait is judged against a
   * current, coherent valuation. Synchronous: nothing is awaited here. When the tape has no price
   * the entry valuation stands and the note says so; a tape older than the freshness limit is
   * used (a latch is the safe direction) but named, never passed off as fresh.
   */
  function revalue(position) {
    const snap = feed.snapshot(clock());
    const price = snap.last?.p;
    if (!Number.isFinite(price)) return { walletUsd: position.walletUsd, price: position.price, note: 'no tape price after the wait; entry valuation' };
    const stale = !Number.isFinite(snap.eventAgeMs) || snap.eventAgeMs > cfg.maxDataAgeSec * 1000;
    const valued = valuePosition(position, price);
    return { walletUsd: valued.walletUsd, price, note: stale ? `stale tape (${Number.isFinite(snap.eventAgeMs) ? Math.round(snap.eventAgeMs / 1000) : '∞'} s) valued at its last price` : null };
  }

  // ---------- the admissibility verdict: synchronous, at one instant, from data gathered just before ----------
  /**
   * Everything a paid effect needs to be allowed, decided from ONE reading of the clock and ONE price:
   * the KILL file, the tape at that instant, the age of the balances and of the quote that will be
   * used, the balances re-valued at this price (side, wallet), the durable limits (halt, quotas,
   * hold, loss, budget, pending intents and obligations), the candidate and the trend filter. When
   * `send` names the exact amount about to leave the wallet, the verdict checks that the FRESH
   * balances still hold it and applies the notional bounds to THAT amount at THIS price, never to
   * whatever the wallet happens to hold (R3-V1). A loss limit seen here latches here. Nothing
   * awaits, so a caller can put the effect right after it (R1-B). Paper and live share this
   * contract; only the signer differs.
   */
  function admissible({ stage, target, position: balances, switchId = null, quote = null, send = null, snapshotFn = (t) => feed.snapshot(t) }) {
    const now = clock();
    const problems = [];
    if (!canAct()) problems.push('session cutoff or stop requested');
    if (!continueUnknownBilling && ledger.unknownInference().length) problems.push('inference billing UNKNOWN');
    if (killPresent()) problems.push('KILL file present');
    if (!Number.isFinite(balances?.at) || now - balances.at > cfg.positionMaxAgeSec * 1000) problems.push(`balances ${Number.isFinite(balances?.at) ? Math.round((now - balances.at) / 1000) : '∞'} s old`);
    const snap = snapshotFn(now);
    const price = snap.last?.p ?? null;
    if (!Number.isFinite(snap.eventAgeMs) || snap.eventAgeMs > cfg.maxDataAgeSec * 1000) problems.push(`tape event age ${Number.isFinite(snap.eventAgeMs) ? Math.round(snap.eventAgeMs / 1000) : '∞'} s`);
    if (!Number.isFinite(price)) problems.push('no price');
    if (quote && (!Number.isFinite(quote.at) || now - quote.at > cfg.quoteMaxAgeSec * 1000)) problems.push(`quote ${Number.isFinite(quote.at) ? Math.round((now - quote.at) / 1000) : '∞'} s old`);
    if (problems.length) return { ok: false, problems, stage, now };
    const position = valuePosition(balances, price); // the same raw balances, valued at THIS price (R2-B1)
    const priceAt = new Date(snap.last.t).toISOString(); const priceSource = `coinbase:${snap.product}@${stage}`;
    const opts = { excludeSwitchId: switchId };
    let st = ledger.stats(position.walletUsd, opts);
    st = noteRisk(st, position.walletUsd, stage, opts);
    const features = computeFeatures(snap, lastQuotes, now);
    // the notional under the bounds: the exact amount that will be sent, valued now — or the holdings when no effect follows yet
    let notionalUsd = target === 'USDC' ? position.ethUsd : position.usdc;
    if (send) {
      const available = availableRaw(position, send);
      if (available < send.amountInRaw) problems.push(`balance changed since the plan: ${send.label} available ${send.label === 'USDC' ? formatUnits(available, 6) : formatEther(available)} < planned ${send.amountIn}`);
      notionalUsd = send.label === 'USDC' ? send.amountIn : send.amountIn * price;
    }
    const lim = features ? limits({ now, features, position: { ...position, lastSwitchAt: st.lastSwitchAt }, stats: st, notionalUsd, target }, cfg) : { ok: false, problems: ['features unavailable'] };
    if (!lim.ok) problems.push(...lim.problems);
    if (target) {
      const c = votes.candidate(position, now);
      if (c.target !== target) problems.push(`candidate no longer ${target}: ${c.reason}`);
      const tf = features ? trendFilter(features, target) : { ok: false, reason: 'no features' };
      if (!tf.ok) problems.push(tf.reason);
      const bf = features ? breakoutFilter(features, target, cfg) : { ok: false, reason: 'no features' };
      if (!bf.ok) problems.push(bf.reason);
    }
    return { ok: problems.length === 0, problems, stage, now, price, priceAt, priceSource, position, stats: st, features, notionalUsd };
  }

  /** Gather (balances), then decide: the verdict is dated AFTER the wait and valued at its own price (R1-B, R1-04, R2-B1). */
  async function preflight({ stage, target, excludeSwitchId = null, switchId = excludeSwitchId }) {
    const balances = await readBalances();
    return admissible({ stage, target, position: balances, switchId });
  }

  // ---------- one receipt, settled once (R2-C1, R2-C2, R2-C3, R3-C5) ----------
  /** What a settled leg cost in wei: the receipt's L2 gas plus its L1 fee, or the pre-send L1 bound when the receipt did not report one. */
  function legCostWei(row) {
    if (row.gas_l2_wei === null || row.gas_l2_wei === undefined) return null;
    const l2 = BigInt(row.gas_l2_wei);
    if (row.l1_known) return { wei: l2 + BigInt(row.gas_l1_wei), l1Wei: BigInt(row.gas_l1_wei), estimate: false };
    if (row.l1_bound_wei !== null && row.l1_bound_wei !== undefined) return { wei: l2 + BigInt(row.l1_bound_wei), l1Wei: BigInt(row.l1_bound_wei), estimate: true };
    return { wei: l2, l1Wei: 0n, estimate: true, note: 'L1 fee unknown and no pre-send bound recorded' };
  }

  /** The two facts a settled leg carries apart from its status (R4-C6): its receipt facts are recorded; its USD cost is booked. */
  const legState = (row) => ({ recorded: row.accounting !== 'none', booked: row.price_usd !== null && row.price_usd !== undefined, conflict: row.accounting === 'conflict' });

  /**
   * Book the gas of a settled leg in USD at a stated price, exactly once: a leg that is already
   * booked is left exactly as it was (the first committed valuation stands — R3-C5); a leg whose
   * facts are disputed is booked by no one but a human (R4-C6); otherwise the cost row is keyed by
   * the leg, the leg's USD fields and accounting mark follow, and the switch's spent figure is
   * recomputed, all in the caller's transaction. Returns true when the cost was inserted.
   */
  function bookLeg(row, { price, priceAt, priceSource }) {
    const state = legState(row);
    if (state.booked || state.conflict) return false;
    const cost = legCostWei(row);
    if (!cost) return false;
    const inserted = ledger.recordCost('gas', weiToUsd(cost.wei, price), `${row.kind} ${row.tx_hash}${cost.note ? ` (${cost.note})` : ''}`, { key: `leg:${row.id}:gas`, estimate: cost.estimate, external: false, price, priceAt, priceSource });
    ledger.updateLeg(row.id, { gas_l2_usd: weiToUsd(BigInt(row.gas_l2_wei), price), gas_l1_usd: weiToUsd(cost.l1Wei, price), accounting: 'booked', price_usd: price, priced_at: priceAt, price_source: priceSource });
    ledger.recomputeSpent(row.switch_id);
    return inserted;
  }

  /** The native facts a settlement stored, for comparing a replay against the first settlement. */
  const nativeFacts = (facts) => ({ status: facts.status === 1 ? 'confirmed' : 'failed', gas_l2_wei: String(facts.l2Wei), gas_l1_wei: facts.l1Known ? String(facts.l1Wei) : null, amount_out_raw: facts.amountOutRaw === null || facts.amountOutRaw === undefined ? null : String(facts.amountOutRaw) });

  /**
   * One receipt → one leg, replay-safe: the facts go on the leg in native units, the cost is keyed by
   * the leg, and leg, cost and switch change in ONE SQLite transaction. Without a valuation the gas
   * stays an explicit obligation (`accounting = 'pending'`) that `bookPending()` settles later; the
   * absence of a price is never a zero. Whether the facts are recorded and whether their cost is
   * booked are judged apart (R4-C6): a leg whose facts are recorded meets a second settlement with
   * the SAME facts as a replay — an unpriced one may receive its first valuation now, a booked one
   * changes nothing (the first valuation stands) — and DIFFERENT facts are never merged: the leg
   * keeps its originals and becomes `accounting = 'conflict'` for a human to look at, whether or
   * not it was booked; a conflict is not cleared by later matching input (R3-C5). A conflict never
   * erases a committed cost from the switch's total, and a settled leg that is not booked leaves
   * that total explicitly unresolved (R4-C7). Used on the normal path and on restart alike.
   */
  function settleLeg(leg, facts, valuation) {
    return ledger.transaction(() => {
      const current = ledger.getLeg(leg.id);
      const incoming = nativeFacts(facts);
      const state = legState(current);
      if (state.recorded) {
        const reply = (extra) => ({ outcome: current.status, booked: false, replay: true, conflict: false, actualOut: current.amount_out_actual, ...extra });
        if (state.conflict) return reply({ conflict: true }); // a human resolves it; later input, matching or not, changes nothing
        const stored = { status: current.status, gas_l2_wei: current.gas_l2_wei, gas_l1_wei: current.gas_l1_wei, amount_out_raw: current.amount_out_raw };
        const same = Object.keys(incoming).every((k) => stored[k] === incoming[k]);
        if (!same) {
          ledger.updateLeg(leg.id, { accounting: 'conflict', error: `receipt facts differ from the settled ones: settled ${JSON.stringify(stored)}, received ${JSON.stringify(incoming)}` });
          ledger.recomputeSpent(current.switch_id); // a booked conflict keeps its cost in the total; an unbooked one makes the total unresolved
          log('receipt facts conflict with the settled leg; left for a human', { leg: leg.id, tx: leg.tx_hash, booked: state.booked });
          return reply({ conflict: true });
        }
        if (state.booked) return reply({}); // the first committed valuation stands
        return reply({ booked: valuation ? bookLeg(current, valuation) : false }); // pending + the same facts: the obligation may take its first valuation now
      }
      const actualOut = incoming.amount_out_raw === null ? null : Number(leg.token_out === 'USDC' ? formatUnits(BigInt(incoming.amount_out_raw), 6) : formatEther(BigInt(incoming.amount_out_raw)));
      ledger.updateLeg(leg.id, {
        status: incoming.status, error: incoming.status === 'failed' ? 'reverted' : null, receipt_block: facts.block,
        gas_l2_wei: incoming.gas_l2_wei, gas_l1_wei: incoming.gas_l1_wei, l1_known: facts.l1Known ? 1 : 0,
        amount_out_raw: incoming.amount_out_raw, amount_out_actual: actualOut, accounting: 'pending',
      });
      const booked = valuation ? bookLeg(ledger.getLeg(leg.id), valuation) : false;
      if (!booked) ledger.recomputeSpent(current.switch_id); // an unpriced settlement leaves the switch's spent figure explicitly unresolved, never short
      return { outcome: incoming.status, booked, replay: false, conflict: false, actualOut };
    });
  }

  /** Settle every accounting obligation left by an unpriced restart, each in its own transaction (R2-C1). A disputed obligation is skipped: a human books it (R4-C6). */
  function bookPending(valuation) {
    let booked = 0; let disputed = 0;
    for (const row of ledger.legsAwaitingAccounting()) ledger.transaction(() => { if (bookLeg(row, valuation)) booked += 1; else if (legState(row).conflict) disputed += 1; });
    if (booked) log('gas of earlier legs booked at the current price', { legs: booked, price: valuation.price, priceSource: valuation.priceSource });
    if (disputed) log('settled legs with disputed receipt facts await a human; no switch until then', { legs: disputed });
    return booked;
  }

  // ---------- paper execution: the same contract, no signer, one atomic write ----------
  async function executePaper({ switchId, target }) {
    const refuse = (reason) => { ledger.closeSwitch(switchId, { status: 'failed_before_send', reason }); return { ok: false, reason }; };
    const paper = ledger.kv.get('paper:balances');
    const sell = target === 'USDC';
    if (sell ? !(paper?.ethSide > 0) : !(paper?.usdc > 0)) return refuse(sell ? 'nothing to sell' : 'nothing to buy with');
    const send = sell ? { label: 'ETH', amountIn: paper.ethSide, amountInRaw: parseUnits(paper.ethSide.toFixed(18), 18) } : { label: 'USDC', amountIn: paper.usdc, amountInRaw: parseUnits(paper.usdc.toFixed(6), 6) };
    // gather: the execution quote for exactly this amount, then the balances
    const q = await chain.quote(sell ? cfg.weth : cfg.usdc, sell ? cfg.usdc : cfg.weth, send.amountInRaw);
    const balances = await readBalances();
    // the verdict: one instant, one price, this amount; then the fill in one SQLite transaction, nothing in between
    const pf = admissible({ stage: 'paper fill', target, position: balances, switchId, quote: q, send });
    if (!pf.ok) return refuse(`before the paper fill: ${pf.problems.join('; ')}`);
    const slip = 1 - cfg.expectedSlippageBps / 10_000;
    const quoteOut = sell ? Number(formatUnits(q.amountOut, 6)) : Number(formatEther(q.amountOut));
    const out = quoteOut * slip;
    const fresh = balances.paper;
    ledger.transaction(() => {
      const legId = ledger.openLeg({ switchId, seq: 1, kind: 'paper', tokenIn: sell ? 'ETH' : 'USDC', tokenOut: sell ? 'USDC' : 'WETH', amountIn: send.amountIn, minOut: quoteOut * (1 - cfg.slippageBps / 10_000), quoteOut, quoteAt: new Date(q.at).toISOString(), quoteBlock: q.block });
      ledger.kv.set('paper:balances', sell ? { ...fresh, ethSide: fresh.ethSide - send.amountIn, usdc: fresh.usdc + out } : { ...fresh, ethSide: fresh.ethSide + out, usdc: fresh.usdc - send.amountIn });
      ledger.updateLeg(legId, { status: 'confirmed', amount_out_actual: out, gas_l2_usd: cfg.paperGasUsdPerLeg, gas_l1_usd: 0, accounting: 'booked', price_usd: pf.price, priced_at: pf.priceAt, price_source: pf.priceSource });
      ledger.recordCost('gas', cfg.paperGasUsdPerLeg, `paper leg ${legId}`, { key: `leg:${legId}:gas`, estimate: true, external: true, price: pf.price, priceAt: pf.priceAt, priceSource: pf.priceSource }); // the virtual wallet pays nothing: external
      ledger.closeSwitch(switchId, { status: 'done', cancelPlanned: false });
      ledger.updateSwitch(switchId, { spent_usd: cfg.paperGasUsdPerLeg });
    });
    return { ok: true, legs: 1, quoteOut, out, price: pf.price };
  }

  // ---------- live execution ----------
  // plan (every leg durable) → bound of the whole plan → per leg: gather (quote, estimate of the exact
  // bytes, balances) → verdict at one instant, one price, THIS amount → `broadcasting` → send → receipt → settle → remaining bound.
  async function executeLive({ switchId, target }) {
    const owner = chain.address();
    const refuse = (reason) => { ledger.closeSwitch(switchId, { status: 'failed_before_send', reason }); return { ok: false, reason }; };

    let price = feed.snapshot(clock()).last?.p;
    if (!Number.isFinite(price)) return refuse('no price');
    let position = await readPosition(price);
    const legs = [];
    if (target === 'USDC') {
      if (position.nativeSurplus * price >= 1) legs.push({ label: 'ETH', tokenIn: cfg.weth, tokenOut: cfg.usdc, amountInRaw: parseUnits(position.nativeSurplus.toFixed(18), 18), amountIn: position.nativeSurplus, useValue: true });
      if (position.weth * price >= 1) legs.push({ label: 'WETH', tokenIn: cfg.weth, tokenOut: cfg.usdc, amountInRaw: position.real.wethRaw, amountIn: position.weth, useValue: false });
    } else if (position.usdc >= 1) {
      legs.push({ label: 'USDC', tokenIn: cfg.usdc, tokenOut: cfg.weth, amountInRaw: position.real.usdcRaw, amountIn: position.usdc, useValue: false });
    }
    if (!legs.length) return refuse('nothing to swap');
    const notionalUsd = target === 'USDC' ? position.ethUsd : position.usdc;
    const capOf = (notional, at) => usdToWei(notional * cfg.maxGasPctOfNotional / 100, at);
    const nonces = await chain.nonceState(owner);
    if (nonces.inFlight > 0) return refuse(`${nonces.inFlight} transaction(s) of ours still pending in the mempool`);
    for (const leg of legs) leg.needsApproval = !leg.useValue && (await chain.allowance(leg.tokenIn, owner)) < leg.amountInRaw;

    // 1) the durable plan: every leg is a row before anything is broadcast (R1-C)
    const plan = []; let seq = 0;
    ledger.transaction(() => {
      for (const leg of legs) {
        if (leg.needsApproval) plan.push({ leg, kind: 'approve', legId: ledger.openLeg({ switchId, seq: ++seq, kind: 'approve', tokenIn: leg.label, tokenOut: null, amountIn: leg.amountIn }) });
        plan.push({ leg, kind: 'swap', legId: ledger.openLeg({ switchId, seq: ++seq, kind: 'swap', tokenIn: leg.label, tokenOut: leg.tokenOut === cfg.usdc ? 'USDC' : 'WETH', amountIn: leg.amountIn }) });
      }
    });

    // 2) the bound of the whole plan before the first paid effect (R1-D). A swap that needs an approval
    //    first cannot be estimated until the approval exists on-chain; no multiplier stands in for it. Such a
    //    plan is two bounded steps: the approval (its own estimate, inside the cap) and then the swap,
    //    estimated for real after the approval confirms, against what remains of the cap.
    let budgetWei = 0n; let deferred = 0;
    for (const item of plan) {
      if (item.kind === 'approve') {
        item.tx = chain.buildApproveTx({ token: item.leg.tokenIn, amountRaw: item.leg.amountInRaw });
        item.est = await chain.estimateTx(item.tx, owner, price); budgetWei += item.est.boundWei;
      } else if (!item.leg.needsApproval) {
        const q = await chain.quote(item.leg.tokenIn, item.leg.tokenOut, item.leg.amountInRaw);
        const probe = chain.buildSwapTx({ ...item.leg, minOutRaw: chain.minOut(q.amountOut), recipient: owner, deadline: Math.floor(clock() / 1000) + cfg.swapDeadlineSec });
        item.est = await chain.estimateTx(probe, owner, price); budgetWei += item.est.boundWei;
      } else deferred += 1;
    }
    if (budgetWei > capOf(notionalUsd, price)) return refuse(`execution bound $${weiToUsd(budgetWei, price).toFixed(4)} above ${cfg.maxGasPctOfNotional}% of notional $${notionalUsd.toFixed(2)}`);
    ledger.updateSwitch(switchId, { budget_usd: weiToUsd(budgetWei, price), status: 'executing', reason: deferred ? `${deferred} swap(s) bounded after their approval` : null });

    // 3) execution
    let nonce = nonces.latest; let spentWei = 0n; let paid = 0; let done = 0;
    const abort = (item, reason) => {
      ledger.transaction(() => { ledger.updateLeg(item.legId, { status: 'cancelled', error: reason }); ledger.closeSwitch(switchId, { status: paid ? 'partial' : 'failed_before_send', reason }); });
      return { ok: false, reason, partial: paid > 0 };
    };
    const unknown = (item, reason) => {
      ledger.transaction(() => { ledger.updateLeg(item.legId, { status: 'unknown', error: reason }); ledger.closeSwitch(switchId, { status: 'unknown', reason, halt: `switch ${switchId}: ${reason}` }); });
      return { ok: false, reason: `${reason}; halted`, partial: paid > 0 };
    };
    for (const item of plan) {
      const { leg } = item;
      // gather: the quote (swaps), the estimate of exactly the bytes that will be sent, fresh balances
      let tx = item.tx; let q = null; let deadline = null; let minOutRaw = null; let quoteOut = null;
      if (item.kind === 'swap') {
        q = await chain.quote(leg.tokenIn, leg.tokenOut, leg.amountInRaw);
        minOutRaw = chain.minOut(q.amountOut);
        quoteOut = leg.tokenOut === cfg.usdc ? Number(formatUnits(q.amountOut, 6)) : Number(formatEther(q.amountOut));
        deadline = Math.floor(clock() / 1000) + cfg.swapDeadlineSec;
        tx = chain.buildSwapTx({ ...leg, minOutRaw, recipient: owner, deadline });
      }
      const est = await chain.estimateTx(tx, owner, price);
      const balances = await readBalances();
      // ---- the verdict at one instant, one price, on exactly the amount this transaction carries; nothing awaits between here and the broadcast ----
      const pf = admissible({ stage: `${item.kind} ${leg.label}`, target, position: balances, switchId, quote: q, send: { label: leg.label, amountIn: leg.amountIn, amountInRaw: leg.amountInRaw } });
      if (!pf.ok) return abort(item, `before ${item.kind} ${leg.label}: ${pf.problems.join('; ')}`);
      position = pf.position; price = pf.price; // the valuation the bound and the fallback delta use from here on
      const capWei = capOf(pf.notionalUsd, price);
      if (spentWei + est.boundWei > capWei) return abort(item, `gas bound before ${item.kind} ${leg.label}: spent $${weiToUsd(spentWei, price).toFixed(4)} + next $${weiToUsd(est.boundWei, price).toFixed(4)} above the cap $${weiToUsd(capWei, price).toFixed(4)}`);
      if (deadline !== null && deadline - Math.floor(pf.now / 1000) < cfg.swapDeadlineSec / 2) return abort(item, `deadline half spent before the broadcast of ${leg.label}`);
      ledger.updateLeg(item.legId, {
        status: 'broadcasting', nonce, deadline, quote_out: quoteOut, quote_at: q ? new Date(q.at).toISOString() : null, quote_block: q?.block ?? null,
        min_out: minOutRaw === null ? null : Number(leg.tokenOut === cfg.usdc ? formatUnits(minOutRaw, 6) : formatEther(minOutRaw)),
        l1_bound_wei: String(est.l1BoundWei), // so a restart can price a receipt that reports no L1 fee
      });
      let sent;
      try { sent = await chain.send(tx, { nonce, gasLimit: est.gasLimit, maxFeePerGas: est.maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas }); }
      catch (error) { return unknown(item, `broadcast of ${item.kind} ${leg.label} failed: ${describeError(error)}; the transaction may still exist`); }
      paid += 1;
      ledger.updateLeg(item.legId, { status: item.kind === 'approve' ? 'approval_sent' : 'sent', tx_hash: sent.hash, nonce: sent.nonce });
      nonce = sent.nonce + 1;
      log(`${item.kind} sent`, { leg: leg.label, tx: sent.hash, nonce: sent.nonce, deadline });
      const receipt = await chain.waitReceipt(sent.hash);
      if (!receipt) return unknown(item, `${item.kind} ${sent.hash} receipt timeout`);
      const facts = await chain.receiptFacts(sent.hash, { owner, tokenOut: leg.tokenOut });
      if (!facts) return unknown(item, `${item.kind} ${sent.hash} confirmed but its receipt is missing`);
      const settled = settleLeg(ledger.getLeg(item.legId), facts, { price, priceAt: pf.priceAt, priceSource: pf.priceSource });
      spentWei += legCostWei(ledger.getLeg(item.legId)).wei;
      if (settled.outcome === 'failed') {
        const reason = `${item.kind} ${sent.hash} reverted`;
        ledger.closeSwitch(switchId, { status: 'failed', reason, halt: `switch ${switchId}: ${reason}` }); // terminal status and its halt: one durable step (R3-C4)
        return { ok: false, reason: `${reason}; halted`, partial: paid > 0 };
      }
      if (item.kind === 'swap') {
        let actualOut = settled.actualOut;
        if (actualOut === null) { const after = await chain.balances(owner); actualOut = leg.tokenOut === cfg.usdc ? after.usdc - position.real.usdc : after.weth - position.real.weth; ledger.updateLeg(item.legId, { amount_out_actual: actualOut }); }
        done += 1;
        log('swap confirmed', { leg: leg.label, tx: sent.hash, block: facts.block, actualOut, quoteOut });
      }
    }
    ledger.transaction(() => { ledger.closeSwitch(switchId, { status: 'done', cancelPlanned: false }); ledger.recomputeSpent(switchId); });
    return { ok: true, legs: done, spentUsd: weiToUsd(spentWei, price) };
  }

  // ---------- startup: never decide with unresolved intents (TR-03 / R1-C / R2-C1..C3 / R3-C4) ----------
  // First every halt that a terminal switch required and nobody acknowledged is latched again. Then
  // every leg at or past the broadcast boundary is visited whatever its parent's label says: a leg
  // that never reached `broadcasting` was never sent (cancelled); one with a receipt is settled by the
  // same function as on the normal path; one without a hash or without a receipt stays UNKNOWN. Gas of
  // a settled leg is booked at the tape's price when there is one and kept as an obligation otherwise.
  // A switch is then what its legs prove, closed in one durable step with the halt its outcome
  // requires. An exception here (an RPC outage) propagates and leaves everything recoverable.
  async function recoverPending() {
    const owner = chain.address();
    for (const sw of ledger.requiredHalts()) ledger.latchHalt(sw.halt_reason); // a required halt outlives any crash between its status and its latch
    const valuation = currentValuation('recovery');
    const toSettle = ledger.switchesToSettle(); // collected BEFORE any leg changes: a mislabelled parent is found through its open leg
    for (const leg of ledger.pendingLegs()) {
      if (!leg.tx_hash) { ledger.updateLeg(leg.id, { status: 'unknown', error: 'crash at the broadcast boundary: no hash recorded; a transaction may exist' }); continue; }
      const tokenOut = leg.token_out === 'USDC' ? cfg.usdc : leg.token_out === 'WETH' ? cfg.weth : null;
      const facts = await chain.receiptFacts(leg.tx_hash, { owner, tokenOut });
      if (!facts) { ledger.updateLeg(leg.id, { status: 'unknown', error: 'no receipt yet (found on restart)' }); continue; }
      const settled = settleLeg(leg, facts, valuation);
      log('leg settled on restart', { leg: leg.id, tx: leg.tx_hash, outcome: settled.outcome, booked: settled.booked, replay: settled.replay });
    }
    if (valuation) bookPending(valuation);
    for (const sw of toSettle) {
      ledger.transaction(() => {
        ledger.cancelPlannedLegs(sw.id, 'never broadcast (found on restart)');
        const status = ledger.deriveSwitchStatus(sw.id);
        const halt = status !== 'done' && status !== 'failed_before_send' ? `switch ${sw.id} ${status} after restart` : null;
        ledger.closeSwitch(sw.id, { status, reason: `resolved on restart: ${status}`, halt, cancelPlanned: false });
      });
    }
    if (mode === 'live') {
      const nonces = await chain.nonceState(owner);
      if (nonces.inFlight > 0) ledger.latchHalt(`${nonces.inFlight} transaction(s) in flight at startup`);
    }
    return { unresolvedLegs: ledger.pendingLegs().length, unbookedLegs: ledger.legsAwaitingAccounting().length, halt: ledger.stats(0).halt };
  }

  // ---------- the tick ----------
  function finalizeValuation(reason = 'tick') {
    if (mode !== 'paper') return null;
    const paper = ledger.kv.get('paper:balances');
    const snap = feed.snapshot(clock());
    if (!paper || !Number.isFinite(snap.last?.p)) return null;
    const walletUsd = paper.ethSide * snap.last.p + paper.usdc;
    const value = { reason, walletUsd, price: snap.last.p, priceAt: new Date(snap.last.t).toISOString(),
      stale: !Number.isFinite(snap.eventAgeMs) || snap.eventAgeMs > cfg.maxDataAgeSec * 1000,
      ethSide: paper.ethSide, usdc: paper.usdc,
      externalUsd: ledger.db.prepare('SELECT COALESCE(SUM(usd),0) AS usd FROM costs WHERE mode=? AND external=1').get(mode).usd };
    ledger.observe('valuation', value);
    return value;
  }

  async function tickBody() {
    if (busy) return { skipped: 'busy' };
    busy = true;
    let switchId = null;
    try {
      if (killPresent()) { log('KILL file present, stopping'); return { stop: true }; }
      if (!canAct() || (!continueUnknownBilling && ledger.unknownInference().length)) return { stop: true, reason: 'session ended or inference billing UNKNOWN' };
      const now = clock();
      const snap = feed.snapshot(now);
      if (captureInputs) ledger.captureInput(snap);
      if (!snap.last) { log('waiting for the tape'); return { waiting: true }; }
      const price = snap.last.p;
      const position = await readPosition(price);
      ledger.ensureInitial(position.walletUsd);
      bookPending({ price, priceAt: new Date(snap.last.t).toISOString(), priceSource: `coinbase:${snap.product}@tick` }); // obligations first, decisions after
      if (!lastQuotes || now - lastQuotes.at > cfg.quoteMaxAgeSec * 1000) lastQuotes = await chain.costPicture({ ethSide: position.ethSide, usdc: position.usdc, midPrice: price });
      const features = computeFeatures(snap, lastQuotes, now);
      let st = ledger.stats(position.walletUsd);
      st = noteRisk(st, position.walletUsd, 'tick'); // the risk state latches on its own, candidate or not (R1-E)
      // a billed cost is a state change: judge the risk again before any early return (R3-E2/E3), against the
      // balances valued at the tape's price NOW, after the wait that billed it, not at the tick's entry (R4-E4)
      const afterCost = (where) => { const v = revalue(position); st = noteRisk(ledger.stats(v.walletUsd), v.walletUsd, where, {}, v.note); };
      if (!features) { ledger.insertEquity({ eth: position.real.eth, weth: position.weth, usdc: position.usdc, price, equityUsd: position.equityUsd, walletUsd: position.walletUsd }); log('tape stale, no features', { eventAgeSec: Math.round(snap.eventAgeMs / 1000) }); votes.clear(); return { stale: true }; }
      const stateText = renderState(features, { side: position.side, ethPct: position.ethPct, lastSwitchMinutes: st.lastSwitchAt ? (now - st.lastSwitchAt) / 60_000 : null, switchesToday: st.switchesToday, maxSwitchesPerDay: cfg.maxSwitchesPerDay });

      // 1) the fast judge, within the inference budget
      let summary = null; let judgment = null; let judgeError = null;
      const budgetLeft = st.inferenceBudgetCommittedUsd < cfg.inferenceBudgetUsdPerDay;
      if (judgeEnabled && budgetLeft) {
        if (!canAct() || killPresent()) return { stop: true };
        const callId = ledger.beginInference('judge');
        let reply;
        try {
          judgment = await judge.judge(stateText);
          reply = judgment;
          summary = judge.summarize(judgment.answers);
          votes.push(summary, clock());
        } catch (error) {
          judgeError = error.message;
          // A reply can be paid even when its answers cannot be summarized, or
          // when the adapter rejects its model pin after receiving usage.
          // Keep only billing facts from that reply/error; never turn a known
          // bill into UNKNOWN because the decision itself was unusable.
          const billed = judgment ?? error;
          reply = { ok: false, reason: 'judge failed', costUsd: billed?.costUsd,
            usage: billed?.usage, model: billed?.model, ms: billed?.ms,
            notSent: billed?.notSent === true && !Number.isFinite(billed?.costUsd) };
          votes.clear();
        }
        const settled = ledger.settleInference(callId, reply);
        // The settlement (including a thrown-but-billed reply) changes risk at
        // the post-wait tape price before any decision or early return.
        if (settled.billing === 'KNOWN') afterCost('judgment cost');
        ledger.insertJudgment({ callId, price, features, state: stateText, answers: judgment?.answers, summary, ms: judgment?.ms, costUsd: Number.isFinite(reply?.costUsd) ? reply.costUsd : null, error: judgeError, model: reply?.model, requestAt: judgment?.requestAt, responseAt: judgment?.responseAt, tapeSource: `coinbase:${snap.product}`, candleSource: snap.candlesSource });
        if (settled.billing === 'UNKNOWN') {
          if (!continueUnknownBilling) return { stop: true, reason: 'inference billing UNKNOWN' };
          votes.clear();
          log('paper judge billing UNKNOWN; answer discarded, session continues', { callId });
        }
      } else if (judgeEnabled && !budgetWarned) { budgetWarned = true; log('inference budget for today exhausted; judging paused', { knownUsd: st.inferenceTodayUsd, unknownReserveUsd: st.inferenceUnknownReserveUsd }); }
      if (!budgetLeft) votes.clear();
      ledger.insertEquity({ eth: position.real.eth, weth: position.weth, usdc: position.usdc, price, equityUsd: position.equityUsd, walletUsd: position.walletUsd });

      const c = votes.candidate(position, clock());
      ledger.observe('vote', { ...c, side: position.side, degraded: features.dataQuality.degraded, budgetLeft });
      if (arms) {
        arms.init({ ethSide: position.ethSide, usdc: position.usdc, price, quotes: lastQuotes, now: clock() });
        arms.tick({ price, features, quotes: lastQuotes, candidateFor: (side) => votes.candidate({ side }, clock()).target, now: clock(), judgeCostUsd: judgment?.costUsd ?? 0 });
      }
      const line = summary ? `${summary.regime}(${summary.regimeP.toFixed(2)}) ${summary.direction}(${summary.directionP.toFixed(2)}) ${summary.quality}(${summary.qualityP.toFixed(2)}) risk_off ${summary.riskOffP.toFixed(2)} ${judgment.ms}ms` : judgeError ? `judge error: ${judgeError}` : budgetLeft ? 'judge off' : 'judge paused (budget)';
      log(`tick ${price.toFixed(2)} | ${position.side} ${position.ethPct.toFixed(0)}% eq $${position.equityUsd.toFixed(2)} wallet $${position.walletUsd.toFixed(2)} net ${st.totalNetPnlPct === null ? 'n/a' : st.totalNetPnlPct.toFixed(2) + '%'} | ${features.dataQuality.degraded ? 'DEGRADED' : 'data ok'} | ${line} | votes ETH ${c.votes.ETH} USDC ${c.votes.USDC}${st.halt ? ' | HALTED' : ''}`);
      if (!c.target) return { candidate: null };
      if (clock() < quoteFailureCooldownUntil) {
        // a quote failed before any effect a moment ago (paper): no slow-brain call and no execution quote until the
        // cooldown ends; the judge and the informational cost picture of each tick are not paused by it
        ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'deferred', reason: `quote-failure cooldown: ${Math.round((quoteFailureCooldownUntil - clock()) / 1000)} s left`, stage: 'cooldown' });
        log('candidate waits for the quote-failure cooldown', { target: c.target }); return { cooldown: 'quote failure' };
      }

      // 2) candidate → trend filter → limits → slow brain → verdict → execution
      const tf = trendFilter(features, c.target);
      if (!tf.ok) { ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'vetoed', reason: tf.reason, stage: 'trend' }); log('candidate vetoed', { target: c.target, reason: tf.reason }); return { vetoed: tf.reason }; }
      const bf = breakoutFilter(features, c.target, cfg);
      if (!bf.ok) { ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'vetoed', reason: bf.reason, stage: 'breakout' }); log('candidate vetoed by the breakout condition', { target: c.target, reason: bf.reason }); return { vetoed: bf.reason }; }
      const notionalUsd = c.target === 'USDC' ? position.ethUsd : position.usdc;
      const lim = limits({ now: clock(), features, position: { ...position, lastSwitchAt: st.lastSwitchAt }, stats: st, notionalUsd, target: c.target }, cfg);
      if (!lim.ok) { ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'blocked', reason: lim.problems.join('; '), stage: 'limits' }); log('candidate blocked by limits', { target: c.target, problems: lim.problems }); return { blocked: lim.problems }; }

      let ds = null;
      if (cfg.requireDeepseek || cfg.hasDeepseekKey) {
        if (clock() - lastDeepseekAt < cfg.deepseekCooldownMs) {
          // one row per deferred tick, so a day's funnel counts the candidate-ticks the cooldown consumed (R5-P2 denominators); the votes stay
          ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'deferred', reason: `slow-brain cooldown: ${Math.round((cfg.deepseekCooldownMs - (clock() - lastDeepseekAt)) / 1000)} s left`, stage: 'cooldown' });
          log('candidate waits for the slow-brain cooldown', { target: c.target }); return { cooldown: true };
        }
        lastDeepseekAt = clock();
        if (!canAct() || killPresent()) return { stop: true };
        const callId = ledger.beginInference('deepseek');
        try { ds = await slowBrain.confirm({ stateText, judgeSummary: summary, candidate: c.target, position }); }
        catch { ds = { ok: false, reason: 'slow brain threw' }; }
        const settled = ledger.settleInference(callId, ds);
        if (Number.isFinite(ds?.costUsd) && ds.costUsd > 0) afterCost('slow-brain cost');
        if (settled.billing === 'UNKNOWN') {
          if (!continueUnknownBilling) return { stop: true, reason: 'inference billing UNKNOWN' };
          ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes,
            outcome: 'held', reason: 'slow-brain billing UNKNOWN; answer not actionable', deepseek: ds, stage: 'slow-brain' });
          votes.clear();
          log('paper DeepSeek billing UNKNOWN; candidate held, session continues', { callId });
          return { held: 'slow-brain billing UNKNOWN' };
        }
        if (!ds.ok) {
          ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: cfg.requireDeepseek ? 'held' : 'proceed-without-slow-brain', reason: `slow brain unavailable: ${ds.reason}`, deepseek: ds, stage: 'slow-brain' });
          log('slow brain unavailable', { reason: ds.reason, required: cfg.requireDeepseek });
          votes.clear(); // an outage invalidates the run of agreeing judgments (TR-02)
          if (cfg.requireDeepseek) return { held: ds.reason };
        } else if (!ds.agrees) {
          ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'vetoed', reason: `slow brain says ${ds.stance} (${ds.confidence.toFixed(2)})`, deepseek: ds, stage: 'slow-brain' });
          log('slow brain vetoed the switch', { target: c.target, stance: ds.stance, confidence: ds.confidence, reasons: ds.reasons });
          votes.clear();
          return { vetoed: 'slow brain' };
        }
      }

      // 3) the verdict after the waits, then a durable switch; its slot is reserved here, once
      const pf = await preflight({ stage: 'pre-switch', target: c.target });
      if (!pf.ok) { ledger.insertDecision({ price, position: position.side, candidate: c.target, votes: c.votes, outcome: 'aborted', reason: pf.problems.join('; '), deepseek: ds, stage: 'preflight' }); log('switch aborted at preflight', { target: c.target, problems: pf.problems }); votes.clear(); return { aborted: pf.problems }; }
      switchId = ledger.openSwitch({ fromSide: pf.position.side, toSide: c.target, reason: c.reason, notionalUsd: pf.notionalUsd });
      ledger.insertDecision({ price: pf.price, position: pf.position.side, candidate: c.target, votes: c.votes, outcome: 'execute', reason: `${c.reason}; switch ${switchId}`, deepseek: ds, stage: 'execute' });
      log('SWITCH', { id: switchId, to: c.target, mode, notionalUsd: pf.notionalUsd.toFixed(2), votes: c.votes, deepseek: ds ? { stance: ds.stance, confidence: ds.confidence, model: ds.model } : null });
      let result;
      try {
        result = mode === 'live' ? await executeLive({ switchId, target: c.target }) : await executePaper({ switchId, target: c.target });
      } catch (error) {
        // an exception is not a proven outcome: legs never broadcast are cancelled, anything the chain may
        // hold keeps the switch UNKNOWN and recoverable (R2-C3); the status and its halt are one step (R3-C4).
        // One narrow exception, paper only: a typed quote failure of a transient class (or an operator stop)
        // that happened BEFORE any effect — no leg exists, nothing was booked — is cancelled without a halt
        // and followed by a cooldown. A deterministic revert, an unknown outcome, an accounting conflict or a
        // ledger failure still latch; live keeps every latch (the sanitized reason is what the ledger stores).
        const reason = describeError(error);
        const preEffect = mode === 'paper' && error?.code === 'QUOTE_UNAVAILABLE' && error.preEffect === true && (error.transient === true || error.stopped === true);
        let status; let cancelled = false;
        ledger.transaction(() => {
          ledger.cancelPlannedLegs(switchId, `switch threw: ${reason}`);
          status = ledger.deriveSwitchStatus(switchId);
          cancelled = preEffect && status === 'failed_before_send' && ledger.legsOf(switchId).length === 0;
          if (cancelled) ledger.closeSwitch(switchId, { status, reason: `cancelled before any effect (paper): ${reason}`, halt: null, cancelPlanned: false });
          else ledger.closeSwitch(switchId, { status, reason: `${status === 'unknown' ? 'outcome unknown' : status}: ${reason}`, halt: `switch ${switchId} threw: ${reason}`, cancelPlanned: false });
        });
        if (cancelled) {
          quoteFailureCooldownUntil = clock() + cfg.quoteFailureCooldownMs;
          log('switch cancelled before any effect; no halt in paper, cooldown set', { id: switchId, reason, cooldownMs: cfg.quoteFailureCooldownMs });
        }
        result = { ok: false, reason, partial: status === 'partial', cancelled };
      }
      // finalize: an intent must never stay 'planned' or 'executing' after its attempt
      const row = ledger.getSwitch(switchId);
      if (row && (row.status === 'planned' || row.status === 'executing')) ledger.closeSwitch(switchId, { status: result.ok ? 'done' : result.partial ? 'partial' : 'failed_before_send', reason: result.ok ? null : result.reason });
      votes.clear(); lastQuotes = null;
      log('switch result', { id: switchId, ...result });
      return { switched: result.ok, result };
    } catch (error) {
      const safe = describeError(error);
      log('tick error', { error: safe });
      return { error: safe };
    } finally { busy = false; }
  }

  async function tick() {
    const out = await tickBody();
    if (!out.skipped) { finalizeValuation(); ledger.observe('tick', out); }
    return out;
  }
  return { tick, finalizeValuation, preflight, admissible, recoverPending, bookPending, settleLeg, executePaper, executeLive, readPosition, readBalances, valuePosition, votes, mode, quotes: () => lastQuotes, openLegStates: OPEN_LEG_STATES };
}
