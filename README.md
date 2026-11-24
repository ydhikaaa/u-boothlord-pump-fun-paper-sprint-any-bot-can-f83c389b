# Pump.fun Paper Sprint — Disciplined Momentum Bot

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ydhikaaa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ydhikaaa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)

Entry for the make.fun bounty [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b): a paper-trading bot (`main.ts`, Node 22) that trades a replay of pump.fun bonding-curve events under the `agent-fun/replay/v2` harness. Highest net PnL on the 6-hour final window wins; the bot is graded locally on the kit's 24-hour dev window.

## Strategy

**Entries — young, strong, broad, accelerating flow.** A curve becomes a candidate only when all of these hold:

- Age at least 200 slots, so the first chaotic seconds are skipped.
- Real quote reserve between 30 and 85 SOL and rising versus first sight (≥1.2×, or ≥ +1 SOL absolute) — real money is arriving, and a 0.50 SOL order fits the harness cap of 1% of real reserve.
- Inside the last 300 slots: net inflow ≥ 2 SOL, ≥ 12 buys from ≥ 10 distinct buyers, no single buyer above 30% of buy volume.
- Price up between +5% and +120% across the window and within 3% of the window high — momentum without chasing a vertical top.
- Flow accelerating: second-half net flow at least 1.5× the first half.

Position size is 0.50 SOL (or the reserve cap, if lower), at most 5 open positions, one position per mint, and a 300-slot cooldown before any re-entry into a mint that was exited.

**Exits — asymmetric, so winners can run.** There is deliberately no hard take-profit: round-trip fees are ~1.25% per side plus fixed lamports, so capping wins while cutting losses at a fixed stop gives negative expectancy. Instead:

- Stop-loss at −8% from entry caps every loser.
- A trailing stop arms at +10% peak return and sells after a 10% fall from the peak, letting strong coins run +30–100%.
- Max hold of 900 slots recycles capital out of stalled positions — unless the position is up ≥ +10%, in which case it keeps riding the trailing stop.
- A fade exit cuts a losing position early when the last 150 slots of flow turn below −1 SOL net.

**Breadth backstop.** The final window is only 6 hours, so if fewer than 20 distinct coins have traded late in the tape (after slot 45,000), the bot places tiny 0.02 SOL probe buys — at most one per 600 slots — on the most active untouched curves, managed by the same exit rules.

## Guardrails respected

- ≥ 20 distinct mints with round trips ≥ 0.01 SOL (main flow targets far more; probes backstop the minimum).
- Max drawdown ≤ 50%: at most 2.5 SOL of the 10 SOL paper capital is ever deployed, so even a total loss on every open position stays under the cap.
- Deterministic: no clock, no randomness, no network, no environment reads — two executions produce byte-identical action logs.
- Everything the entry runs is in this repository: `main.ts` plus the harness shim vendored at `vendor/makefun-bot.ts`.
