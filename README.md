# trend-switcher

A small position-switching agent on Uniswap v3: by default ETH/USDC on Base, and the same rules on other EVM chains and pairs, always an asset against a USD stablecoin (see Markets). It holds the whole position either in the asset or in the stablecoin and switches sides only when a run of typed model judgments, a deterministic trend filter, a second model's confirmation and every hard limit agree. It runs on paper by default and writes everything it saw and did into a local SQLite ledger, so a run can be audited afterwards and compared with another run.

This is an experimental tool, with the recorded paper results in `SESSIONS.md`. Read the next section first.

## What this is not

- **Not a proven strategy.** The first paper sessions, using the rule now called `forecast`, produced no trades: no judgment qualified as a vote under that rule. The trend presets have run on paper a few times, side by side over the same hours; see "What we tested" and the sanitized session summaries in `SESSIONS.md`; the write-up uses the same summaries. The ledgers, logs and reports themselves are not published: they carry model answers, latencies, prices and error text.
- **Not financial advice.** Nothing here is a recommendation to trade. Live mode exists, is capped by code at a small notional, and is not something we suggest switching on.
- **Not a backtest.** The agent works on the live tape; the replay tool (see Replay) runs the same engine over historical candles under a cost scenario and is a screening, not a proof. Every judgment is a paid API call, and the ledger records each one.
- **Not a stop-loss.** Every limit halts *new* actions. None of them exits a held position; a position in ETH keeps ETH's drawdown until the agent itself decides to switch.

## How a decision is made

1. **Tape and candles.** A Coinbase WebSocket feed for ETH-USD and 5-minute candles. Freshness is measured in event time; stale or degraded data vetoes.
2. **Features.** EMA20 versus EMA50 on the candles, returns over several horizons, realised volatility, spread, and the execution cost of a switch quoted on-chain (Uniswap QuoterV2) plus estimated gas.
3. **The judge.** Every tick the state is rendered as text and sent to a typed-question judge: a model that answers fixed-choice questions with probabilities over an HTTP API, not a chat LLM that writes prose. You bring your own provider (`JUDGE_BASE_URL`, `JUDGE_MODEL` pinned to one exact model id, `JUDGE_API_KEY`); the agent names none and speaks one small request/answer contract (`agent/judge-client.mjs`). Four questions: regime, direction over the next 15 minutes, switch quality, risk-off.
4. **Votes.** Each judgment either votes for a side or does not; what it votes on is the preset's choice (the 15-minute forecast or the regime call, see Presets). The last `VOTE_WINDOW` judgments form a window, and a switch becomes a candidate when at least `VOTE_MIN` of them vote for the same side. Votes must be recent and gap-free (the window is measured in ticks), and a risk-off probability above `MAX_RISK_OFF_P` never votes.
5. **Trend filter, breakout and re-entry.** The candidate must agree with EMA20 versus EMA50, and the price must have broken `BREAKOUT_MIN_PCT` (0.9 %) beyond the closed candles of the last two hours in the candidate's direction. After a sale, the strategy decides how the bot comes back (see Strategies). Deterministic; no model involved.
6. **The slow brain.** A second model (DeepSeek) reads the same state and the candidate and may veto. A cooldown limits how often it is asked; candidate ticks inside the cooldown are recorded as deferred. `SLOW_BRAIN_FRAME` chooses the question it is asked: `forecast` (the default) weighs the candidate against the next 15 minutes and the execution cost; `regime` asks whether the judge's regime is likely to persist long enough to pay for the switch, and withholds the 15-minute answers from it. The two frames differ in the system prompt and in the fields of the summary they see, so a comparison between them is a comparison of two bundles. The default stays `forecast` until a comparison with enough evidence says otherwise; one side-by-side session is a hypothesis, not a verdict.
7. **Hard limits**, re-checked right before any paid effect: switches per day, minimum hold, daily loss halt, total loss kill, inference budget per day, notional bounds, data freshness. A halt latches until an operator runs `--reset-halt`.
8. **Execution.** A paper fill is booked at the on-chain quote minus the expected slippage plus an estimated gas cost. The quote carries the instant its request was issued and the block observed just before it; it is retried only for transient RPC errors, under one deadline. A quote that could not be obtained because of a transient RPC error or an operator stop, before any leg exists, cancels the switch in paper (nothing was booked, a cooldown follows); a deterministic revert or any other failure inside a switch latches a halt, and live keeps every halt. Live sends a real swap through the Uniswap router with a deadline and settles it from the receipt.

Everything a model says is a vote or a veto. Code decides, and every limit is enforced regardless of what any model says.

## Strategies

The judge, the votes and the hard limits are the same in every strategy; what differs is how the bot leaves ETH and how it comes back. `STRATEGY` picks one; `BREAKOUT_MIN_PCT`, `RISK_LATCH_BLOCKS_EXITS`, `REENTRY` and `REENTRY_MARGIN_PCT` override its values one by one.

| `STRATEGY` | Leaves ETH when | Comes back into ETH when | A latched loss limit blocks |
| --- | --- | --- | --- |
| `votes` (bot 1) | 5 of 6 judgments call the trend down and EMA20 is below EMA50 | the same, the other way | every switch |
| `breakout` (bot 2) | the same, and the price is 0.9 % below the low of the last two hours | the same, and the price is 0.9 % above the high of the last two hours | every switch |
| `hedge` (bot 3) | as `breakout` | as `breakout` | only buying back |
| `rebuy` (bot 4, the default) | as `breakout` | the price is 0.9 % above the last sale; no votes needed | only buying back |

Why four, and why bot 4 is the default. Bot 1 is the rule of the first sessions: every run of agreeing judgments is a trade, and the whipsaw is paid every time — 610 switches over the six-month rise of 2023–24, ending below the start while ETH doubled. Bot 2 adds a price condition and becomes quiet, but its loss latch can block the very sale a hedge exists for. Bot 3 lets a latched loss block only buying back: it sells in a crash. Its way back, though, is a 0.9 % burst above the two-hour high, which a slow rise rarely prints at the moment the votes agree: over that rise it sat in USDC for three and a half months and made +28 % while holding made +118 %. Bot 4 keeps bot 3's exit and comes back when the price is 0.9 % above the level it sold at, unless a daily loss limit is latched. Replayed on six windows (`SESSIONS.md`, sessions 9–15; net of all costs). What the table is: historical replays with the judge alone, no slow brain, under scenario fills, each window a separate start with $10 000 in ETH. It is not a result of the two-model bot on the live tape, and not the return of one portfolio. The first five windows were chosen for what a hedge is for and what it costs, and bot 4 was picked as the default after seeing them; the sixth is the latest complete month at the time, taken by that rule alone to test the choice:

| Window | Holding ETH | Bot 1 | Bot 2 | Bot 3 | Bot 4 |
| --- | --- | --- | --- | --- | --- |
| May–Nov 2022: Luna, the June low, FTX | −52.5 % | −49.5 % | −10.8 % | −16.5 % | **+0.9 %** |
| Oct 2023–Mar 2024: a rise with two pullbacks | +118.2 % | −4.9 % | +79.8 % | +28.2 % | **+104.0 %** |
| May 2021: a choppy top, then the crash | −2.5 % | **+50.0 %** | +7.0 % | +14.9 % | −13.7 % |
| November 2022: FTX | −17.7 % | −17.9 % | −17.7 % | **−6.6 %** | **−6.6 %** |
| February 2024: a straight rally | +46.7 % | +19.5 % | +46.7 % | +46.7 % | +46.7 % |
| September 2026: the unseen month, a mild rise | +8.7 % | −8.8 % | +8.7 % | +8.7 % | +8.7 % |

On the five windows it was picked on, bot 4 beat holding in three, matched it in one and lost in one, the choppy top of May 2021, where every dip was a sale and every buy-back came 1.5–7 % above it. The unseen month did not test the choice: no bot with a price condition switched, so bots 2, 3 and 4 all ended at holding, and only bot 1 traded (108 switches, −8.8 % in a month that gained 8.7 %). Its worst window against holding is 14 points behind (the rise); bot 3's is 90. Bot 1's +50 % in May 2021 is the same rule that gave back more than half of February 2024 and all of the 2023–24 rise. Every number is one draw of a stochastic judge per arm: a second run keeps the order of the bots, not the exact numbers.

**How to read bot 4's numbers.** Three things the table does not show (`SESSIONS.md`, the note on reading bot 4's rows):

- **The windows are separate starts, and their results do not add up.** Bot 4 never buys back below its own sale, so every completed round trip leaves it with less ETH (1.0–1.5 % less in the rise, 1.4–6.5 % in May 2021), and its lead over holding lasts only while it waits in USDC under that sale. Followed straight through from May 2022 to April 2024, the sale of 5 May 2022 at 2 753 is bought back only on 14 February 2024, 650 days later: +32 % against +34 % for holding, with a worst drop of 7 % on the way down where holding's was 70 %, and +31 % of the 2023–24 rise instead of the +104 % of a bot that starts that October in ETH. It is insurance against the fall, not a way to end with more than holding.
- **The daily loss limit is part of the result.** A latched daily loss blocks buying back, and in both crash windows that latch, not the price, kept the bot out: the price was back above the re-entry level five minutes after the sale of 5 May 2022 and on 77 five-minute ticks of 8 November 2022. Screened on the recorded answers with the daily limit at 10 %, the FTX month ends at −21 %, below holding; the 2022 window keeps its single sale as long as the 20-minute minimum hold stands, and ends at −31 % once that is cut to five minutes as well. The same latch is what makes May 2021 expensive: five of the six buy-backs waited for it to lift and came 1.5–7 % above the sale.
- **A replay lifts that latch at midnight; live it waits for you.** On the live tape a latched daily loss stays until `--reset-halt` (Replay: the daily stop). After a day that cost 3 % the bot does not buy back until the operator lets it. A paper run may follow the replay's rule instead (`PAPER_DAILY_LATCH_LIFT=midnight`); live never does.

**Is it the judge or the rules?** A reader asked for the control that separates them, and `agent/replay-recorded.mjs` now runs it for free on any finished replay. *No judge* (`--constant-down`): one fixed answer, "the trend is down", so the price conditions alone decide. *A random judge* (`--shuffle-seed`): the recorded answers cut into runs and shuffled, so that it votes for a sale exactly as often and changes its mind exactly as often as the real one, only at random moments. Bot 4 on its six windows, 45 to 99 seeds each:

| Window | Holding | Bot 4 | No judge | Random judges: lowest / median / highest | Bot 4 beats / ties |
| --- | --- | --- | --- | --- | --- |
| May–Nov 2022 | −52.5 % | +0.9 % | +1.0 % | −58.7 / −31.4 / +1.0 % | 82 / 17 of 99 |
| Oct 2023–Mar 2024 | +118.2 % | +104.0 % | +70.6 % | +101.4 / +111.4 / +118.2 % | 2 / 0 of 45 |
| May 2021 | −2.5 % | −13.7 % | −9.4 % | −44.3 / −3.7 / +18.8 % | 24 / 0 of 60 |
| November 2022 | −17.7 % | −6.6 % | −13.2 % | −36.0 / −19.7 / −6.6 % | 52 / 8 of 60 |
| February 2024 | +46.7 % | +46.7 % | +46.7 % | all +46.7 % | 0 / 60 of 60 |
| September 2026 | +8.7 % | +8.7 % | +6.5 % | +6.5 / +8.7 / +8.7 % | 18 / 42 of 60 |

The 2022 row rests on one five-minute tick, the first break of 5 May. The rules choose that moment, and a judge that always agrees gets the same row; a random judge is looking the other way five times in six, sells days later and lower, and none ends higher. In a rise it is the other way round: without the judge the rules sell 17 times instead of 6, but a random judge that approves fewer sales does better still, because in a rise every sale is a false alarm. Summed over the five windows the default was picked on, the real order of answers stands above about five random judges in six (83 % of 10 000 combinations; 92 % when the answers are shifted by whole days instead of shuffled). The judge earns the falls and costs something in a rise; an edge over a blind filter is supported by these runs, not established. The controls carry no judge cost, which is why the same single sale of 2022 reads +1.0 % in them and +0.9 % in the paid row; `SESSIONS.md` has the note with the limits.

**Re-entry** (`REENTRY`): `breakout` — an entry is a candidate of the votes and passes the trend filter and the breakout condition like any switch (bots 1–3). `above-sale` — while the position is in USDC after a completed sale, the price being `REENTRY_MARGIN_PCT` above that sale's fill price is the entry by itself, and below that level there is no entry at all: the judge decides when to leave, the price decides when to come back (bot 4). The hard limits still apply to that entry: a latched loss limit, the minimum hold and the daily switch cap can block it. `above-sale-votes` — the same level, but the votes and the trend filter still have to agree. The level is the fill of the most recent sale; without one (a run that started in USDC) every mode falls back to `breakout`.

**Re-entry margin** (`REENTRY_MARGIN_PCT`, by default the exit's own breakout bar, 0.9): a hysteresis band. A crash often retests the level it broke; a re-entry exactly at the sale would buy every retest and be taken out again lower.

**Breakout condition** (`BREAKOUT_MIN_PCT`; 0 turns it off): judgments a minute apart see almost the same state, so five agreeing votes are closer to one opinion repeated than to five checks. A candidate therefore also needs the price to have moved past the high or low of the closed candles of the last `BREAKOUT_LOOKBACK_MIN` minutes (60, 120 or 240; 120 by default) by that many percent: a switch to USDC only below the range, a switch to ETH only above it. The bar is the cost of a false flip measured in the paper sessions (0.6–0.9 % against holding). It trades later by construction and does not prove an edge; in the replays (`SESSIONS.md`, sessions 9 and 10) it removed the whipsaw of the votes-only rule: zero switches in the February 2024 rally, six over seven months of 2022. Persistence over several 5-minute candles instead of several 1-minute ticks is the same idea through the window: `VOTE_WINDOW=20 VOTE_MIN=18` requires about four candles of agreement.

**Loss latch and exits** (`RISK_LATCH_BLOCKS_EXITS`): with `false` a latched daily or total loss limit halts only switches *into* ETH; a switch into USDC — the move a hedge exists for — stays allowed. With the knob set to `true` the latch halts every switch until `--reset-halt`, the rule of sessions 1–9: the May 2021 and November 2022 replays show the 3 % daily stop blocking the exit on the day it mattered and, in the other month, keeping the bot from churning through the crash; over seven months of 2022 the strict latch froze both of the other arms in ETH from June, while the arm with exits allowed stood at −9.6 % on the day ETH bottomed (holding: −67 %). Halts of other kinds (an unresolved on-chain outcome, an UNKNOWN bill) block both directions regardless.


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

## Markets

The bot always holds one asset or a USD stablecoin, spot, through a Uniswap v3 pool, and reads the asset's Coinbase USD tape. `MARKET` picks the pair:

| `MARKET` | Chain | Pool | Tape | Round trip at $1k / $10k / $100k, 2026-10-04 | Status |
| --- | --- | --- | --- | --- | --- |
| `base-eth-usdc` (default) | Base | WETH/USDC 0.05 % | ETH-USD | −0.10 / −0.13 / −0.35 % | every session and replay in `SESSIONS.md` |
| `ethereum-eth-usdc` | Ethereum | WETH/USDC 0.01 % | ETH-USD | −0.02 / −0.03 / −0.09 % (mainnet gas not included) | supported, not tested |
| `arbitrum-eth-usdc` | Arbitrum One | WETH/USDC 0.05 % | ETH-USD | −0.10 / −0.11 / −0.19 % | supported, not tested |
| `polygon-eth-usdc` | Polygon PoS | WETH/USDC 0.05 % | ETH-USD | −0.19 / −1.0 / −12 % | supported, not tested; shallow above $1k |
| `optimism-eth-usdc` | OP Mainnet | WETH/USDC 0.05 % | ETH-USD | −0.35 / −2.6 / −26 % | supported, not tested; shallow |
| `polygon-pol-usdc` | Polygon PoS | WPOL/USDC 0.05 % | POL-USD | −0.38 / −2.8 / −26 % | supported, not tested; shallow |
| `arbitrum-arb-usdc` | Arbitrum One | ARB/USDC 0.3 % | ARB-USD | −0.90 / −3.8 / −42 % | supported, not tested; shallow |
| `optimism-op-usdc` | OP Mainnet | OP/USDC 0.3 % | OP-USD | −1.2 / −7.2 / −69 % | supported, not tested; shallow |

**What "supported, not tested" means.** Every address was checked on-chain on 2026-10-04 — the quoter's and the router's factory, the router's wrapped native token, the tokens' symbols and decimals, the factory's pool for the pair at the fee tier — every fee tier was the deepest of its pair for a $1k–$10k quote that day, and every tape was an online Coinbase product. `node agent/selfcheck.mjs` repeats the on-chain checks for the market you configure. No session or replay of this repository has run on these markets: they run in paper only, on a virtual capital (`PAPER_CAPITAL_USD`), and `MODE=live` refuses to start on them. The round-trip column is the reason to look before running: on a shallow pool one switch costs more than the whole 0.9 % breakout bar, and the bot can only lose there at that size. Measure your own size with `node agent/probe-impact.mjs` (two read-only quotes per size).

**Another pool or pair.** Any `MARKET_*` key overrides a preset's field (an edited preset counts as untested); `MARKET=custom` builds a market from all of them: `MARKET_CHAIN_ID`, `MARKET_CHAIN`, `MARKET_RPC_URL`, `MARKET_PRODUCT` (a Coinbase USD product, for the tape and the candles), `MARKET_ASSET`, `MARKET_BASE_TOKEN`, `MARKET_BASE`, `MARKET_BASE_DECIMALS`, `MARKET_QUOTE_TOKEN`, `MARKET_QUOTE`, `MARKET_QUOTE_DECIMALS`, `MARKET_POOL_FEE`, `MARKET_POOL`, `MARKET_FACTORY`, `MARKET_QUOTER`, `MARKET_ROUTER`, `MARKET_WRAPPED_NATIVE`, and optionally `MARKET_BINANCE_SYMBOL` (a fallback for the candles) and `MARKET_GAS_ORACLE`. Run the selfcheck first.

**Replaying another market.** The replay's cost scenario uses a measured price impact, and the default table belongs to Base WETH/USDC, so a replay of another market refuses to start without its own: `node agent/probe-impact.mjs` prints the table as its last line, `REPLAY_IMPACT_TABLE_BPS='<that line>'` hands it to `agent/replay.mjs`, and `node agent/history-fetch.mjs --product ARB-USD ...` fetches the asset's candles.

Inside the code and the ledger the two sides keep their historical names, `ETH` and `USDC` (and the configuration keys `weth` and `usdc`): on another market `ETH` means the market's asset and `USDC` its stablecoin. Reports print the asset's symbol.

## What we tested, and what we did not

- **Paper sessions on the live tape (sessions 1–8): hours, not weeks.** A 60-second tick and a virtual $1 000, one session at four sizes and with a five-minute arm. The rule now called `forecast` produced no qualifying vote in a smoke run, a 4-hour session (stopped by an unknown inference bill, as designed) and a 12-hour session. The `trend` presets made the same two-switch whipsaw in a sideways corridor under three slow-brain settings; the breakout condition removed it. Two launches halted on a public-RPC error at the first switch and are kept as part of the record.
- **Historical replays (sessions 9–15).** The same engine and judge over Coinbase candles under a simulated clock: four strategies on five windows chosen for what a hedge is for and what it costs, and on one month taken by a rule after the default was picked. $10 000, a five-minute tick, the judge alone, scenario fills, the date hidden. Two controls without the real judge (Strategies: is it the judge or the rules?) and free screenings of the daily limit and the minimum hold on the recorded answers.
- **Not tested.** Live mode has never been armed. The slow brain has not run in a replay, so the replayed rows are not the two-model flow. No market but Base WETH/USDC has run. No real crash has happened on the live tape while the bot watched. Weeks of unattended running are the subject of session 16, whose bar is written down and whose rows are not in yet. Partial positions, a range filter and a longer-horizon question for the judge are theory.
- **What none of this proves.** The replays are a screening: the fills are a scenario, the models may have seen the older periods, and every row is one draw of a stochastic judge. Bot 4 was picked as the default on five of the six replayed windows, and the sixth did not test that choice. Followed straight through a crash and a recovery it ends where holding ends, with a smaller drawdown on the way. None of this is evidence of an edge in the future, and a month is not a distance.

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

A **long paper run** is days or weeks on one ledger with its end written down: `node agent/run.mjs --until 2026-11-06T00:00:00Z`. Unlike a timed session it continues after a restart with the same command, so a reboot costs the ticks it missed and nothing else; it needs `PAPER_CONTINUE_UNKNOWN_BILLING=true`, and `PAPER_DAILY_LATCH_LIFT=midnight` if a latched daily loss should be lifted the next day, as the replays do, instead of waiting for `--reset-halt`. `node agent/status.mjs --db <ledger>` prints one line about a run in progress and says first what needs a look. `RUNBOOK.md` has the whole procedure.

To **compare presets**, run several sessions over the same hours with different `RISK_PRESET` values and separate `AGENT_DB_PATH` and `AGENT_LOCK_PATH`. Paper has no on-chain effect, so parallel sessions cannot trade against each other; they still have separate feeds, quotes and API timings and share the machine and the RPC endpoint, so the comparison is over the same market window, not over identical input. `RUNBOOK.md` shows the three-preset layout.

## Replay: the same bot over a month of history

A paper session on the live tape measures one night. To see what the bot does in a real selloff
without waiting for one, `agent/replay.mjs` runs the same engine, features, vote rule, filters,
limits and judge over historical Coinbase candles under a simulated clock, into a fresh ledger that
`report.mjs` and `agent/replay-report.mjs` read like any other.

```sh
node agent/history-fetch.mjs --from 2021-04-29T22:00:00Z --to 2021-06-01T00:00:00Z --granularity 60
node agent/history-fetch.mjs --from 2021-04-29T22:00:00Z --to 2021-06-01T00:00:00Z --granularity 300
MODE=paper PAPER_CAPITAL_USD=10000 TICK_MS=300000 REQUIRE_DEEPSEEK=false AGENT_DB_PATH=data/replay-may2021.db \
  node agent/replay.mjs --from 2021-05-01T00:00:00Z --to 2021-06-01T00:00:00Z \
  --minutes data/history/ETH-USD-60s-20210429T2200_20210601T0000.jsonl --candles data/history/ETH-USD-300s-20210429T2200_20210601T0000.jsonl
node agent/replay-report.mjs --db data/replay-may2021.db
```

What is the same: everything that decides. What is replaced, and how:

- **The tape.** A minute becomes observable only once it has closed (Coinbase stamps the bucket's
  start; the replay stamps its end), and its close is the tape's sample. A minute with no trades is a
  gap, as live. A missing five-minute bucket is filled flat and counted, so one hole does not blind
  the 25-hour context for a day. One sample a minute is not a trade: the state says the trade
  activity is unknown.
- **The fill.** The open of the minute that starts at the decision instant, times the pool fee
  (0.05 %) and a price impact read at the notional from a table measured on the Base pool on
  2026-10-02 (0.15 / 1.3 / 12.8 / 133 basis points one way at $1k / $10k / $100k / $1M); the engine
  adds its expected slippage as live. A pool that did not exist in 2021 has no historical quote; this
  is a scenario, and the report says so.
- **The date.** The state's time line is replaced by `Time (UTC): not provided.` for both models.
  A model that has seen the period in training is not handed the day; the price level remains a
  hint, so a replay is a screening with that caveat, never a proof.
- **The daily stop.** Live, a latched daily loss waits for the owner's `--reset-halt`. A replay has
  no owner at the keyboard: the daily latch is lifted at the next simulated UTC midnight; the kill
  limit and any switch-level halt are never lifted. A paper run on the live tape follows the same
  rule only when told to (`PAPER_DAILY_LATCH_LIFT=midnight`).

The judge is called once per tick, in order (its question depends on the position), so a month at a
five-minute tick is about 8 600 calls per arm and takes as long as the judge's latency allows; arms
run as separate processes. Rate-limited replies are retried a few times rather than counted as lost
judgments. The replay-report shows the arm against holding ETH over the same window, with the worst
drop of each and where the arm stood at the hold's lowest point: the view a hedge is judged by.

**Screening a rule change for free.** `node agent/replay-recorded.mjs --source <a finished replay ledger> ...` replays the same window with the answers that replay paid for, found by the market part of the state text at the same instants, so a change of `STRATEGY`, `REENTRY`, a breakout bar or a limit costs no judge call. Run it first with the source's own settings: the switches must come out identical (on seven months of 2022 they did, all 31). The limit is stated in its output: the judge gave each answer while it saw the source bot's position, and the ticks where the new rule holds the other side are counted (`otherSide`). It is a screening; a rule worth keeping is confirmed by a replay that pays the judge.

## The ledger

One SQLite file per run, schema-versioned, never migrated silently. It holds every judgment, every decision with its stage (window not full, candidate, vetoed by the trend filter, blocked by limits, deferred by the cooldown, vetoed by the slow brain, executed), every switch with its legs and receipts, every cost, the equity curve, every inference attempt with KNOWN or UNKNOWN billing, per-slot observations, the compressed market state of every tick, and the effective configuration under its hash. Keys appear in it only as `set` or `unset`. `agent/report.mjs` reads a ledger read-only and prints the day report; `--json` gives the same as data.

## Live mode

It exists, only on the default market (Base WETH/USDC, the one this code has run on), and is deliberately hard to arm: `MODE=live` in `.env` **and** `--live` on the command line; `ACCOUNT_ADDRESS` and a `PRIVATE_KEY` whose address matches it; the slow brain required; the notional capped at $100 by code, which `MAX_CAPITAL_USD` may lower and never raise. Paper-only settings are refused in live. Every failed, reverted, timed-out or unknown on-chain outcome latches a halt until `--reset-halt`. It is published for completeness; we do not recommend running it. See `RUNBOOK.md`.

## Tests

`npm test` covers the configuration schema, the policy, the engine, four rounds of boundary regressions from independent reviews, the virtual-capital paper mode, the report, the readiness of timed sessions, the long paper run (when it may start, its record across restarts, the rule that ends a blind process), the daily latch and the calendar, the one-line status, the feed and features, the lock, the slow-brain contract, the replay (availability of history, the hidden date, the cost scenario and the next-minute fill, the midnight rule, one replay end to end) and the two judge controls (a shuffle keeps every answer, the number of sale votes and the run lengths). Everything runs on fakes with one injected clock.

## Status

**Parked by the author on 2026-10-06.** The paper sessions and the replays are recorded; their sanitized summaries are in `SESSIONS.md`. No further session is planned: the month on the live tape that session 16 describes was prepared and not started. The code, the replay tools, the long paper run and the bar of session 16 are here for anyone who wants to run them; a row from such a run is welcome as an issue. The write-ups: [A cheap trend-following ETH/USDC bot with two models in the loop: what paper trading showed](https://dimonb19a.hashnode.dev/a-cheap-trend-following-eth-usdc-bot-with-two-models-in-the-loop-what-paper-trading-showed) (also on [dev.to](https://dev.to/dimonb19a/a-cheap-trend-following-ethusdc-bot-with-two-models-in-the-loop-what-paper-trading-showed-2g14)) and [Holding ETH through the 2022 crash lost 52%. This free bot ended at +0.9%](https://dimonb19a.hashnode.dev/holding-eth-through-the-2022-crash-lost-52-this-free-bot-ended-at-0-9) (also on [dev.to](https://dev.to/dimonb19a/holding-eth-through-the-2022-crash-lost-52-this-free-bot-ended-at-09-39lh)). A write-up is a snapshot of its day; this README and `SESSIONS.md` are kept current and are the more exact reading where they differ.

## License

MIT. See `LICENSE`.
