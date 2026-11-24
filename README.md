# Pump.fun Paper Sprint — Cliff-Rebound Bot

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ydhikaaa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ydhikaaa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)

Entry for the make.fun bounty [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b): a paper-trading bot (`main.ts`, Node 22) that trades a replay of pump.fun bonding-curve events under the `agent-fun/replay/v2` harness. Highest net PnL on the 6-hour final window wins; the bot is graded locally on the kit's 24-hour dev window.

## Strategy

**Entries — buy the confirmed base after a cliff, never the pump.** Most curves that pump hard and fall 25–50% keep falling, but a minority form a base and rebound — and a few of those run all the way to curve completion. A mint becomes a buy only when every condition holds:

- Age at least 400 slots, and the curve is alive: real quote reserve between 15 and 85 SOL.
- It was broadly traded over the last 1,500 slots: ≥ 25 buys from ≥ 15 distinct buyers, with no single buyer above 35% of buy volume.
- Price sits between 50% and 75% of the 1,500-slot high — down 25–50% from the top.
- The bottom is already formed: the window low is at least 100 slots old.
- Stabilization: net flow over the last 150 slots is at least +0.5 SOL, the last 300 slots are no worse than −1 SOL net, and recent prices are flat to rising.
- Confirmation: the full setup must persist for at least 30 slots before capital is committed — a setup that flashes and dies is skipped.

Position size is 0.35 SOL (or the harness reserve cap of 1% of real reserve, if lower), at most 5 open positions, one position per mint, and a 300-slot cooldown before re-entering a mint that was exited.

**Exits — bank the rebound, cut failures fast.**

- Take-profit at +15% banks the typical rebound.
- A trailing stop (arms at +12% peak, fires 8% below the peak) protects larger runs.
- Stop-loss at −4%: a base that breaks was not a base.
- Flat-line exit: a position still under +2% after 150 slots is sold — dead money is recycled.
- Flow-fade exit: a losing position is cut when the last 150 slots of flow turn below −1 SOL net.
- Max hold 500 slots, unless the position is up at least +15%, in which case it rides the trailing stop.

**Breadth backstop.** The final window is only 6 hours, so if fewer than 20 distinct coins have traded late in the tape (after slot 45,000), the bot places tiny 0.02 SOL probe buys — at most one per 600 slots — on the most active untouched curves, managed by the same exit rules.

**Why not momentum?** Eleven measured variants on the dev window — chasing confirmed strength, stricter strength, early entries with tight exits, launch sniping, spraying new curves, a looser dip, and riding near-complete curves — all lost more than this design. Buying confirmed strength on this tape systematically buys local tops; the rebound design finished closest to breakeven with the lowest drawdown (7.0%) of everything measured.

## Guardrails respected

- ≥ 20 distinct mints with round trips ≥ 0.01 SOL: 33 coins and 65 round trips on the 24-hour dev window, with the probe backstop covering the shorter final window.
- Max drawdown ≤ 50%: measured 7.0% on the dev window; at most 1.75 SOL of the 10 SOL paper capital is ever deployed.
- Deterministic: no clock, no randomness, no network, no environment reads — two executions produce byte-identical action logs (verified: identical `action_log_sha256` across repeated local grades).
- Everything the entry runs is in this repository: `main.ts` plus the harness shim vendored at `vendor/makefun-bot.ts`.
