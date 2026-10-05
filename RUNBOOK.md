# Runbook

Operating notes for a paper session. Nothing here needs a wallet; live mode is at the end.

## Before a session

1. Node 24 or newer, `npm install`, `.env` from `.env.example`.
2. The judge is yours to bring: `JUDGE_BASE_URL` (your provider's API origin), `JUDGE_MODEL` (one exact model id, pinned) and `JUDGE_API_KEY`; the slow brain needs `DEEPSEEK_API_KEY`. Keys are read by their clients only; nothing prints them, and the judge key travels only to `JUDGE_BASE_URL`.
3. Judge prices: `JUDGE_PRICE_USD_PER_MTOK_INPUT` and `JUDGE_PRICE_USD_PER_MTOK_OUTPUT` from your vendor's price list. Without them every judge call is an UNKNOWN bill and the session stops on the first one, unless `PAPER_CONTINUE_UNKNOWN_BILLING=true`.
4. Choose the preset (`RISK_PRESET=trend|trend-fast|forecast`, README: Presets), the cadence `TICK_MS` and the capital `PAPER_CAPITAL_USD`. Individual `VOTE_*` keys override the preset.
5. Choose a fresh ledger path: `AGENT_DB_PATH=./data/<name>.db`. A timed session refuses an existing file. A ledger written by an earlier build (cost rows under older names) is refused by every run, because those rows would fall outside the daily inference budget; keep such a file as an archive and read it with `report.mjs` (`REPORT_LEGACY_JUDGE_KIND=<old kind>` names the judge's old cost kind).
6. `node agent/selfcheck.mjs`: every line must be PASS or an explicit skip. It reads public chain state and its own sources, uses a temporary ledger and sends nothing to any model.
7. Keep the machine awake for the whole session (on macOS `caffeinate -is node agent/run.mjs ...`; on Windows use AC power, disable sleep and lid-close sleep in the power plan, and avoid a scheduled restart). Slots missed while the machine sleeps are recorded as missed, not invented.
8. `RPC_URL`: on the public Base endpoint we saw quotes fail with `missing revert data` at the moment several arms switched at once; the cause was not established (the agent cannot tell a refused `eth_call` from a revert). An error without revert data is retried under the deadline and, in paper, cancels the switch before any effect. For parallel arms use a provider key. The URL is read from `.env` only, the ledger and the logs record its hostname, and error text is sanitized before it is written.

## Start

```sh
AGENT_DB_PATH=./data/session-1.db node agent/run.mjs --duration-minutes 240
```

In Windows PowerShell, the POSIX inline assignment above does not work. After configuring the local `.env`, start from the repository directory with a fresh ledger path:

```powershell
$env:AGENT_DB_PATH = './data/session-1.db'
node agent/run.mjs --duration-minutes 240
Remove-Item Env:AGENT_DB_PATH
```

Keep the terminal running for the whole session, or use a one-shot task whose working directory is this repository. A task must have AC power, an awake machine, and a fresh ledger and lock path for each launch; do not configure an automatic retry after a halt. Check the report and stop reason before starting another run.

The first log line, `agent starting`, carries the complete non-secret configuration, its hash and the source hash; the same values are stored in the ledger. A warning follows if judge prices are not configured. The feed warms for a few seconds, pending state is recovered (a timed session requires a clean one), then the bounded clock starts.

## During

- One judgment per tick; the funnel of each tick is logged (window not full, candidate, vetoed, blocked, deferred, executed).
- `KILL` (an empty file next to `package.json`) is noticed within a second, as are Ctrl+C and SIGTERM; the agent then stops at the next safe point, which can be after an RPC read in flight finishes or times out (`RPC_TIMEOUT_MS`, `QUOTE_DEADLINE_MS`). The stop reason lands in the session manifest.
- A halt (loss limit, unknown outcome, unknown bill, a failure inside a switch) stops new actions. It latches: a new start with `--reset-halt` is needed, and only outside a timed session. In paper, `PAPER_DAILY_LATCH_LIFT=midnight` lifts a latched daily loss once its UTC day is over; nothing else is lifted by the calendar. One exception, paper only: a transient RPC error or an operator stop while quoting, before any leg exists, cancels that switch without a halt and starts `QUOTE_FAILURE_COOLDOWN_MS`; a deterministic revert or any other failure inside a switch still halts.
- The inference budget (`INFERENCE_BUDGET_USD_PER_DAY`) pauses judging for the rest of the UTC day when reached; it resets at midnight UTC.

## After

```sh
node agent/report.mjs --db ./data/session-1.db            # the day report
node agent/report.mjs --db ./data/session-1.db --json     # the same as data
node agent/report.mjs --db ./data/session-1.db --day 2026-10-02
node agent/report.mjs --db ./data/session-1.db --projection 1000
```

The report needs no `.env` and works on a copied ledger. It shows the session header and manifest, the call counts and inference cost (KNOWN and UNKNOWN apart), the decision funnel, the switches with their legs, a 15-minute forecast check of every judgment, the result against holding, and the halts. CPU, sleep and reboots are not in the ledger; note them by hand.

For an older ledger whose judge cost kind predates this build, set `REPORT_LEGACY_JUDGE_KIND` only in the local shell before running the report. The value is the old kind recorded in that ledger; the report reads it without migrating the file. In PowerShell:

```powershell
$env:REPORT_LEGACY_JUDGE_KIND = '<old kind>'
node agent/report.mjs --db ./data/archived-session.db
Remove-Item Env:REPORT_LEGACY_JUDGE_KIND
```

## Several presets over the same hours

Give each its own ledger and lock, and run them side by side:

```sh
AGENT_DB_PATH=./data/trend.db      AGENT_LOCK_PATH=./data/trend.lock      RISK_PRESET=trend      node agent/run.mjs --duration-minutes 480
AGENT_DB_PATH=./data/trend-fast.db AGENT_LOCK_PATH=./data/trend-fast.lock RISK_PRESET=trend-fast node agent/run.mjs --duration-minutes 480
AGENT_DB_PATH=./data/forecast.db   AGENT_LOCK_PATH=./data/forecast.lock   RISK_PRESET=forecast   node agent/run.mjs --duration-minutes 480
```

Paper fills have no on-chain effect, so the sessions cannot trade against each other; each has its own feed, quotes and API timings, and they share the machine and the RPC endpoint (give parallel arms a keyed `RPC_URL` and start them a few seconds apart). Each pays its own judge calls (three sessions cost three times the judge calls of one). Compare the reports: same hours, same market, not identical input. `trend` against `trend-fast` shows what the persistence window changes; `forecast` against either shows what the vote basis changes. If every arm stays flat, read the funnel before concluding anything: a gate or a halt keeps an arm flat as surely as a market without a regime flip. On a laptop keep the machine awake for the whole session (`caffeinate -is` on macOS) and leave the lid open.

## A long paper run: days or weeks on the live tape

A timed session measures hours on a fresh ledger and ends with its process. A long run is one ledger for days or weeks with its end written down, and it is made to be restarted: after a reboot the same command continues where the ledger stands, and the ticks in between are simply missing. Paper with a virtual capital only.

```sh
AGENT_DB_PATH=./data/month-bot4.db AGENT_LOCK_PATH=./data/month-bot4.lock STRATEGY=rebuy TICK_MS=300000 \
PAPER_CAPITAL_USD=10000 REQUIRE_DEEPSEEK=false PAPER_CONTINUE_UNKNOWN_BILLING=true PAPER_DAILY_LATCH_LIFT=midnight \
  node agent/run.mjs --until 2026-11-06T00:00:00Z
```

In Windows PowerShell set the same names with `$env:NAME = 'value'` before the `node` line, or keep them in the local `.env` and set only the ledger and lock paths per bot.

- **`--until`** is a UTC instant at most 45 days ahead. The run refuses to start in any state in which it would stay alive and never vote or act: without the judge endpoint, model pin, key and prices, without `PAPER_CONTINUE_UNKNOWN_BILLING=true` (the first bill that cannot be established would otherwise end it for good), or with the slow brain required and no key for it. Run `node agent/selfcheck.mjs` first, as for any session.
- **The daily loss limit.** Live, a latched daily loss waits for `--reset-halt`. Nobody sits at a run that lasts a month, so decide the operator's policy before it starts: `PAPER_DAILY_LATCH_LIFT=midnight` lifts a latched daily loss once its UTC day is over, which is the rule every replay in `SESSIONS.md` used; left `off`, the bot stops buying back after its first losing day until someone resets it. The kill limit and a halt inside a switch are never lifted by the calendar.
- **Keeping it alive.** Let whatever keeps processes on your machine start the same command again: Task Scheduler on Windows (at startup, repeating every ten minutes, working directory = this repository), `launchd` or `systemd` elsewhere, or a shell loop. A second copy cannot start while the first lives (the lock); after the end the command exits quietly with code 0; and a process that has had no usable tape for fifteen minutes exits with code 1 on its own, so the keeper gives it a fresh connection. Every start is added to the run's record in the ledger (`run:paper`). The first fifteen minutes after any start are observation only: the tape has to be continuous for that long before the data stops counting as degraded.
- **Looking in.** `node agent/status.mjs --db ./data/month-bot4.db` prints one line: the side held, the worth against the start and against holding, the worst drop of each, the switches, any halt, the judge's errors over the last day, unknown bills and the age of the last tick. It reads the ledger read-only and is safe while the run is going. When something needs a look the line begins with `ATTENTION:` and says what: no tick for a while (the process is not running), a halt the calendar does not lift, judge errors on a large share of calls (an exhausted balance looks like this), ticks without judge calls, a process that keeps restarting.
- **A halt that stays.** Read `node agent/report.mjs --db ...`, decide, and start the same command once with `--reset-halt` added; then let the keeper take over again.
- **Pausing or ending early.** Switch the keeper off first, then stop the process (Ctrl+C, SIGTERM or a `KILL` file). With the keeper still on, a `KILL` file only makes it start and stop the run every few minutes.
- **Two bots over the same weeks** (`STRATEGY=hedge` next to `STRATEGY=rebuy`): a ledger and a lock each, started a minute apart, and a keyed `RPC_URL`. Each pays its own judge calls: at a five-minute tick about 8 900 calls a month per bot.
- **At the end** the ordinary report works on the same ledger. Missed ticks are the difference between the weeks on the calendar and the ticks in the ledger; the report's per-slot accounting belongs to timed sessions.

## Replaying history

1. Fetch the candles once per window, with a day of warm-up before the first decision (the
   24-hour features need 280 closed five-minute candles): `node agent/history-fetch.mjs --from
   <start minus 26 h> --to <end> --granularity 60` and the same with `--granularity 300`. The tool
   writes `data/history/*.jsonl` and a `.meta.json` with the row count, every gap and the SHA-256;
   it refuses to overwrite without `--force`.
2. Run one arm per process on a fresh `AGENT_DB_PATH`, with the judge environment of a paper
   session, `MODE=paper`, `PAPER_CAPITAL_USD`, `TICK_MS` of 60000 or 300000 and
   `REQUIRE_DEEPSEEK=false` unless you give the slow brain a key (it then sees the same hidden-date
   state). Strategy knobs are the usual ones (`STRATEGY`, `RISK_PRESET`, `BREAKOUT_MIN_PCT`, `REENTRY`,
   `VOTE_*`, `MAX_DAILY_LOSS_PCT`). `--no-judge` walks the whole path without a model call. Another
   market (`MARKET`, README: Markets) needs its candles (`history-fetch.mjs --product ARB-USD`) and
   its pool's price impact: `node agent/probe-impact.mjs` prints the table, `REPLAY_IMPACT_TABLE_BPS`
   hands it to the replay, which refuses to start on another market without it.
3. The runner logs a progress line a minute and the switches; `node agent/replay-report.mjs --db
   <ledger> [--db <ledger> ...]` prints each arm against hold and a comparison table. Keep the ledgers
   and the history files' hashes with the result; the manifest in the ledger (`session:paper`)
   records the window, the files, the cost scenario and the hidden-date line.
4. Several arms at once share the judge's rate limit with any live paper session on the same key:
   stagger the launches, and watch the live session's log for judge errors.

## When something refuses to start

- `refusing a long paper run: ...` names what a run with `--until` needs before it may start (see the section above); once its end has passed the same command says the run is over and exits with code 0.
- `refusing a timed paper session: ...` names what is missing: paper mode, `PAPER_CAPITAL_USD`, whole minutes in 1..1440, the judge key, the slow-brain key while `REQUIRE_DEEPSEEK=true`, or a flag that does not combine with a timed run.
- `choose a fresh, unused AGENT_DB_PATH`: the file (or its `-wal`/`-shm` neighbours) exists.
- `ledger ... has schema version N`: an older ledger; move it aside, nothing is migrated.
- `another agent (pid ...) holds ...`: the lock is taken; a crashed run leaves no stale lock because the holder's pid is checked.
- `invalid configuration: ...`: every out-of-range or inconsistent value is listed at once.

## Live mode (not recommended)

Everything above, plus: `MODE=live` in `.env`, `--live` on the command line, `ACCOUNT_ADDRESS` and the matching `PRIVATE_KEY`, a funded wallet with a gas reserve, `DEEPSEEK_API_KEY`. Paper-only settings (`PAPER_*`) are refused. The notional is capped at $100 by code; `MAX_CAPITAL_USD` may only lower it. A failed, reverted, timed-out or unknown on-chain outcome latches a halt; `--reset-halt` is an operator's decision after reading the ledger, never automatic. Timed sessions are paper-only.
