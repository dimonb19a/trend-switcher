# trend-switcher

A small ETH/USDC position-switching agent for Base (Uniswap v3). It holds the whole position either in ETH or in USDC and switches sides only when a run of typed model judgments, a deterministic trend filter, a second model's confirmation and every hard limit agree. It runs on paper by default and writes everything it saw and did into a local SQLite ledger, so a run can be audited afterwards and compared with another run.

This is an experimental tool, with the recorded paper results in `SESSIONS.md`. Read the next section first.

## What this is not

- **Not a proven strategy.** The first paper sessions, using the rule now called `forecast`, produced no trades: no judgment qualified as a vote under that rule. The trend presets have run on paper a few times, side by side over the same hours; see "What we tested" and the sanitized session summaries in `SESSIONS.md`; the write-up uses the same summaries. The ledgers, logs and reports themselves are not published: they carry model answers, latencies, prices and error text.
- **Not financial advice.** Nothing here is a recommendation to trade. Live mode exists, is capped by code at a small notional, and is not something we suggest switching on.
- **Not a backtest.** The agent works on the live tape only. Every judgment is a paid API call, and the ledger records each one.
- **Not a stop-loss.** Every limit halts *new* actions. None of them exits a held position; a position in ETH keeps ETH's drawdown until the agent itself decides to switch.

## How a decision is made

1. **Tape and candles.** A Coinbase WebSocket feed for ETH-USD and 5-minute candles. Freshness is measured in event time; stale or degraded data vetoes.
2. **Features.** EMA20 versus EMA50 on the candles, returns over several horizons, realised volatility, spread, and the execution cost of a switch quoted on-chain (Uniswap QuoterV2) plus estimated gas.
3. **The judge.** Every tick the state is rendered as text and sent to a typed-question judge: a model that answers fixed-choice questions with probabilities over an HTTP API, not a chat LLM that writes prose. You bring your own provider (`JUDGE_BASE_URL`, `JUDGE_MODEL` pinned to one exact model id, `JUDGE_API_KEY`); the agent names none and speaks one small request/answer contract (`agent/judge-client.mjs`). Four questions: regime, direction over the next 15 minutes, switch quality, risk-off.
4. **Votes.** Each judgment either votes for a side or does not; what it votes on is the preset's choice (the 15-minute forecast or the regime call, see Presets). The last `VOTE_WINDOW` judgments form a window, and a switch becomes a candidate when at least `VOTE_MIN` of them vote for the same side. Votes must be recent and gap-free (the window is measured in ticks), and a risk-off probability above `MAX_RISK_OFF_P` never votes.
5. **Trend filter.** The candidate must agree with EMA20 versus EMA50. Deterministic; no model involved.
6. **The slow brain.** A second model (DeepSeek) reads the same state and the candidate and may veto. A cooldown limits how often it is asked; candidate ticks inside the cooldown are recorded as deferred. `SLOW_BRAIN_FRAME` chooses the question it is asked: `forecast` (the default) weighs the candidate against the next 15 minutes and the execution cost; `regime` asks whether the judge's regime is likely to persist long enough to pay for the switch, and withholds the 15-minute answers from it. The two frames differ in the system prompt and in the fields of the summary they see, so a comparison between them is a comparison of two bundles. The default stays `forecast` until a comparison with enough evidence says otherwise; one side-by-side session is a hypothesis, not a verdict.
7. **Hard limits**, re-checked right before any paid effect: switches per day, minimum hold, daily loss halt, total loss kill, inference budget per day, notional bounds, data freshness. A halt latches until an operator runs `--reset-halt`.
8. **Execution.** A paper fill is booked at the on-chain quote minus the expected slippage plus an estimated gas cost. The quote carries the instant its request was issued and the block observed just before it; it is retried only for transient RPC errors, under one deadline. A quote that could not be obtained because of a transient RPC error or an operator stop, before any leg exists, cancels the switch in paper (nothing was booked, a cooldown follows); a deterministic revert or any other failure inside a switch latches a halt, and live keeps every halt. Live sends a real swap through the Uniswap router with a deadline and settles it from the receipt.

Everything a model says is a vote or a veto. Code decides, and every limit is enforced regardless of what any model says.

## Presets

The judge answers four questions every tick. Which answers count as a vote, and how many votes a switch needs, is the part of the risk profile a preset sets; the trend filter, the slow brain, the risk-off ceiling and the hard limits apply to every preset. `RISK_PRESET` picks a named starting point; every value behind it can still be set explicitly.

**Two bases for a vote** (`VOTE_BASIS`):

- **regime** (the default) — a judgment votes for the side of the judge's multi-hour regime call (`trend_up` → ETH, `trend_down` → USDC) when that regime holds at least `MIN_REGIME_P` (0.5) of the probability mass and no confident contrary 15-minute forecast exists. This is trend following proper: the position follows the regime, and every false regime flip costs a whipsaw. The switch-quality answer is not consulted on this basis; that is a design choice of the experiment (the question names no horizon), not a property of the judge. `MIN_REGIME_P` is a threshold on the judge's answer, not a measured probability of profit.
- **forecast** (the control) — a judgment votes only when the judge calls a trend regime *and* expects the price to move beyond the execution cost within 15 minutes with probability at least `MIN_DIRECTION_P` (0.7) *and* rates the moment `good` (`VOTE_ACCEPT_QUALITY`). This was the rule of the first sessions. In the short sessions recorded so far it produced no qualifying votes; the reasons are under study, and the judge's calibration on this question has not been measured. Published work on short-horizon crypto returns (mean reversion at minutes, momentum at hours and longer) motivates the regime basis, but proves nothing about this judge, this period or an edge after costs. The mode is kept so that those sessions can be reproduced and so that a trend session has a baseline in the same hours; it is not a safer version of the same thing, it is a different question.

**Persistence** (`VOTE_MIN` of `VOTE_WINDOW`): at a 60-second tick the window is an M-of-N rule over minutes. Requiring more agreeing minutes filters false flips at the price of a later entry. The windows offered are heuristic persistence requirements, not optima: consecutive judgments on a slowly changing state are far from independent, so the window mostly measures how long a signal persisted. The votes must fall within 1.5 × window × tick with no gap longer than two ticks.

| `RISK_PRESET` | Basis | Votes | What to expect |
| --- | --- | --- | --- |
| `trend` (default) | regime | 5 of 6 | follows the regime after five agreeing minutes; a few switches per day at most, a whipsaw at every false flip |
| `trend-fast` | regime | 3 of 4 | follows the regime after three agreeing minutes; more switches, more whipsaw cost |
| `forecast` | forecast | 5 of 6 | the control: the rule of the first sessions; switches only on a judged 15-minute move beyond cost; no qualifying vote in the sessions recorded so far |

Not offered as presets: 9 of 10 (nine agreeing minutes before an entry, more than the regime basis needs) and 2 of 3 (a short confirmation; every other veto, the daily switch cap and the minimum hold still apply). Both remain settable through `VOTE_WINDOW` and `VOTE_MIN`. Every preset keeps the trend filter, the slow brain, the risk-off ceiling and the hard limits; the slow brain is told which basis a candidate stands on.

## What we tested, and what we did not

- **Tested, at a 60-second tick only.** The rule now called `forecast`: a 30-minute smoke run, a 4-hour session (stopped by an unknown inference bill, as designed) and a 12-hour session, all on paper with a virtual capital. Zero trades and zero qualifying votes. The `trend` and `trend-fast` presets: one 8-hour paper session, both side by side over the same hours. The `trend` preset under three slow-brain settings (the forecast frame, no slow brain, the regime frame): one 5-hour paper session side by side; its first two launches halted on a public-RPC error at the first switch and are kept as part of the record. A later 30-minute Windows paper smoke of `trend` completed without a switch. Sanitized summaries of every session, including the two halted launches, are in `SESSIONS.md`; the raw ledgers, logs and reports are not published, and the write-up uses the same summaries.
- **Not tested, theory only.** Longer timelines: a 5-minute tick with an hourly or four-hour direction question and holds of hours, which the cost arithmetic favours and which needs a different judge question, not a setting. Partial positions instead of all-or-nothing. A range filter that sits out when the regime is `range`. Live mode has never been armed.
- **What none of this proves.** Paper results on virtual money over hours show how the machinery behaves and what it costs; they are not evidence of an edge, and a day is not a distance. The write-up says the same.

## Costs

Every tick makes one judge call; every candidate makes one slow-brain call, subject to the cooldown. The ledger books each call with its token usage and, when prices are configured, its cost, and `INFERENCE_BUDGET_USD_PER_DAY` pauses judging when the day's spend reaches it.

Judge prices are not shipped with this repository. Set `JUDGE_PRICE_USD_PER_MTOK_INPUT` and `JUDGE_PRICE_USD_PER_MTOK_OUTPUT` from your vendor's price list. Without them every judge call is recorded as an UNKNOWN bill: a plain run halts on the first one, and a timed paper session stops, unless `PAPER_CONTINUE_UNKNOWN_BILLING=true`, which keeps observing, discards the answer, and counts a small reserve per unknown call against the daily budget. The report shows a session's total inference cost and, with `--projection`, the same dollars as a share of a capital of your choice.

## Quickstart

Node 24 or newer (the ledger uses `node:sqlite`).

On macOS or Linux:

```sh
npm install
cp .env.example .env          # set JUDGE_BASE_URL, JUDGE_MODEL, JUDGE_API_KEY and DEEPSEEK_API_KEY; keep PAPER_CAPITAL_USD
node agent/selfcheck.mjs      # one PASS/FAIL line per check; prints no secret; sends nothing to any model
AGENT_DB_PATH=./data/session-1.db node agent/run.mjs --duration-minutes 240
node agent/report.mjs --db ./data/session-1.db
```

On Windows PowerShell, use a fresh path for every session:

```powershell
npm install
Copy-Item .env.example .env   # edit the local .env with your provider settings; never commit it
node agent/selfcheck.mjs
$env:AGENT_DB_PATH = './data/session-1.db'
node agent/run.mjs --duration-minutes 240
node agent/report.mjs --db ./data/session-1.db
Remove-Item Env:AGENT_DB_PATH
```

See `RUNBOOK.md` before leaving a session unattended.

`npm test` runs the whole suite offline: no network, no keys; the timeout tests use short real timers.

A **timed session** is the measurement unit: paper only, a virtual capital, a fresh ledger, whole minutes up to one day. Slots belong to the wall clock, so an overlong tick consumes later slots instead of bursting late requests. The session manifest (planned, attempted, missed and completed slots, the stop reason) is stored in the ledger under `session:paper`. Ctrl+C or a file named `KILL` next to `package.json` stops it early.

To **compare presets**, run several sessions over the same hours with different `RISK_PRESET` values and separate `AGENT_DB_PATH` and `AGENT_LOCK_PATH`. Paper has no on-chain effect, so parallel sessions cannot trade against each other; they still have separate feeds, quotes and API timings and share the machine and the RPC endpoint, so the comparison is over the same market window, not over identical input. `RUNBOOK.md` shows the three-preset layout.

## The ledger

One SQLite file per run, schema-versioned, never migrated silently. It holds every judgment, every decision with its stage (window not full, candidate, vetoed by the trend filter, blocked by limits, deferred by the cooldown, vetoed by the slow brain, executed), every switch with its legs and receipts, every cost, the equity curve, every inference attempt with KNOWN or UNKNOWN billing, per-slot observations, the compressed market state of every tick, and the effective configuration under its hash. Keys appear in it only as `set` or `unset`. `agent/report.mjs` reads a ledger read-only and prints the day report; `--json` gives the same as data.

## Live mode

It exists and is deliberately hard to arm: `MODE=live` in `.env` **and** `--live` on the command line; `ACCOUNT_ADDRESS` and a `PRIVATE_KEY` whose address matches it; the slow brain required; the notional capped at $100 by code, which `MAX_CAPITAL_USD` may lower and never raise. Paper-only settings are refused in live. Every failed, reverted, timed-out or unknown on-chain outcome latches a halt until `--reset-halt`. It is published for completeness; we do not recommend running it. See `RUNBOOK.md`.

## Tests

`npm test` covers the configuration schema, the policy, the engine, four rounds of boundary regressions from independent reviews, the virtual-capital paper mode, the report, the readiness of timed sessions, the feed and features, the lock, and the slow-brain contract. Everything runs on fakes with one injected clock.

## Status

The paper sessions are recorded; their sanitized summaries are in `SESSIONS.md`. The write-up will be linked here when it is published.

## License

MIT. See `LICENSE`.
