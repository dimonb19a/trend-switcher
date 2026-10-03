# Paper sessions — sanitized summaries

What is published about each session: its UTC window, the preset and slow-brain frame, the slots planned and attempted, the number of switches, the result at the virtual capital against holding the starting position over the same window, and how the session ended. What is not published: the ledgers, logs and reports themselves, the call counts and costs of either model, their latencies, their answer distributions, hostnames and configuration hashes. Zero switches is a result of the voting rule, not a measurement of any model.

Every session: paper mode, a virtual capital of 1,000 USD, the starting position in ETH, a 60-second tick, on-chain quotes from Uniswap v3 on Base, the Coinbase ETH-USD tape. "Hold" is the value of keeping the starting position for the same window: a diagnostic benchmark, not a strategy. Results are mark-to-market at the end of the window after the paper execution costs (quote, slippage, estimated gas); the inference bills are booked separately and are small against the capital. Sessions 1–3 and 6 ran on a Windows laptop, 4–5 on a macOS laptop.

| # | Window (UTC) | Preset · slow-brain frame | Slots attempted / planned | Switches | Result vs capital | Hold | Worst drop (arm / hold) | How it ended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-29 08:36 → 09:06 | `forecast` · forecast frame | 30 / 30 | 0 | −0.295 % before inference | the same (no switch) | — | deadline (smoke run) |
| 2 | 2026-09-30 00:01 → 04:08 | `forecast` · forecast frame | 248 / 720 | 0 | net not reported (the last judge bill stayed unknown) | — | — | stopped by the unknown-bill guard, as designed |
| 3 | 2026-09-30 09:31 → 21:31 | `forecast` · forecast frame | 720 / 720 | 0 | −0.08 % before inference | the same (no switch) | — | deadline |
| 4a | 2026-09-30 19:00 → 2026-10-01 03:00 | `trend` (5 of 6) · forecast frame | 480 / 480 | 2 | −0.64 % | +0.28 % | — | deadline |
| 4b | the same window | `trend-fast` (3 of 4) · forecast frame | 480 / 480 | 2 | −0.58 % | +0.28 % | — | deadline |
| 5a | 2026-10-01 15:33 → 20:33 | `trend` · forecast frame | 300 / 300 | 2 | −0.09 % | +0.83 % | — | deadline |
| 5b | the same window | `trend` · no slow brain | 300 / 300 | 2 | −0.07 % | +0.88 % | — | deadline |
| 5c | the same window | `trend` · regime frame | 300 / 300 | 2 | −0.10 % | +0.82 % | — | deadline |
| 6 | 2026-10-02 00:11 → 00:41 | `trend` · forecast frame | 30 / 30 | 0 | −0.043 % before inference | the same (no switch) | — | deadline (smoke run) |
| 7a | 2026-10-02 19:32 → 2026-10-03 05:32 | `trend` · forecast frame (control) | 598 / 600 | 2 | −0.37 % | +0.43 % | −0.62 % / −0.50 % | deadline |
| 7b | the same window | `trend` + breakout 0.9 % beyond the 2-hour range | 598 / 600 | 0 | +0.43 % | +0.43 % | −0.46 % / −0.46 % | deadline |
| 7c | the same window | `trend`, 18 of 20 (≈ four 5-minute candles) | 598 / 600 | 1 | −0.00 % | +0.47 % | −0.15 % / −0.51 % | deadline |

Notes.

- Sessions 1–3 used the rule now called `forecast`: no judgment qualified as a vote, so there was nothing to switch. Session 2 stopped on the first judge reply whose bill could not be established, which is what the guard is for; session 3 ran with the paper-only continuation enabled and its three unresolved bills reserved.
- Sessions 4 and 5 ran several arms side by side over the same market hours. The named setting was the intended difference; separate feeds, quote requests and API timing gave the arms different inputs, so these are exploratory comparisons rather than controlled identical-input trials. Every arm made the same two switches: it sold ETH near a local low and bought it back near a local high. That is the whipsaw cost of a regime flip, and it is why every trend arm ended below "hold".
- Session 5 was launched three times. The first two launches (13:30 and 14:59 UTC) halted at the first switch, when the public RPC endpoint answered the quote with `missing revert data` while several arms switched at once; the retry and deadline logic was changed between launches, and the third launch ran its full 300 slots. The halted ledgers are kept privately as part of the record.
- In session 5 the slow brain in its forecast frame vetoed most buy-backs and only delayed the same switch; without it (5b) and in the regime frame (5c) the outcome was the same two switches. The default frame stays `forecast`; the lever that would change these results is not the slow brain but the judge's regime call flipping at the edges of a sideways corridor.
- Hold differs slightly between the arms of session 5 because each arm values its window from its own first and last tick.
- "Worst drop" is the maximum drawdown of the arm's wallet over the window against the maximum drawdown of holding ETH over the same window, computed from the ledger's price series; it is reported from session 7 on, after a reader pointed out that a hedge should be judged on the drop it sits out rather than on the return.
- Session 7 tested a reader's suggestion: agreeing votes a minute apart are one opinion repeated, so a switch should depend on new information. The night was a 1 %-wide corridor (ETH 2 657–2 684). The control sold at 2 665 and bought back at 2 684 near the top, the same whipsaw as in sessions 4 and 5, 0.8 points behind hold. The breakout arm vetoed 175 candidates because the price never moved 0.9 % beyond the 2-hour range, made no switch and ended exactly at hold. The persistence arm sold once and never saw 18 of 20 minutes agree on ETH again, so it sat out the dip with a smaller drawdown and missed the recovery. The bar was written down before the run: a flip has to be worth more than 0.9 %. Two slots per arm were missed during a two-minute network drop.
